import { AgentUnavailableError, MorseError } from '@morse/system';
import type {
  AgentEvent,
  AgentForkMessage,
  AgentGateway,
  AgentHistoryEntry,
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentSessionState,
  ModelRef,
  PromptImage,
  PromptMode,
  ThinkingLevel,
  WorkspaceRef,
} from '@morse/agent';
import type {
  ChatService,
  MorseLogger,
  OpenedSession,
  SessionRegistry,
  SessionSummary,
} from '@morse/system';
import {
  PROTOCOL_VERSION,
  type AgentErrorCode,
  type AgentFailure,
  type ChatPin,
  type ClientToHostMessage,
  type FrontendIdentity,
  type HostCapabilities,
  type HostToClientMessage,
  type InteractionResponse,
  type SessionActivity,
  type SessionViewState,
  type TranscriptItem,
  type UserTranscriptItem,
} from '@morse/protocol';
import type { HostCommandHandler, NativeDialogs } from './native-dialogs.js';
import type { TerminalBackend, TerminalSession } from './terminal.js';
import { SessionTranscriptStore } from './transcript-store.js';
import {
  draftSessionViewState,
  noticeMessage,
  toInteractionRequest,
  toSessionViewState,
} from './view-state.js';

export interface HostSessionServices {
  registry: SessionRegistry;
  chat: ChatService;
  /**
   * A host-side watch over the `mcp.json` files pi reads. When one moves, this
   * client is told (`mcp/changed`) and re-reads the affected directory instead
   * of waiting out its cache. Optional: a host without an MCP CLI, or a test
   * double, simply never pushes.
   */
  mcpWatch?: McpWatch;
}

/** A subscription to a directory's MCP config changing on disk. */
export interface McpWatch {
  subscribe(listener: (cwd: string) => void): () => void;
}

/**
 * Driven port (R2) declared by this glue: which directories the host lets the
 * agent work in. The server enforces an allow-list; a local VS Code window
 * allows anything the user can already open.
 */
export interface ProjectPolicy {
  canOpen(path: string): boolean;
}

/** Every project the host knows about, which is what the browser host shows. */
export interface GlobalHostScope {
  kind: 'global';
}

/** Only the given roots, which is what the VS Code host shows. */
export interface WorkspaceHostScope {
  kind: 'workspace';
  roots: string[];
}

/** The directories a host is allowed to show and work in. */
export type HostScopeOptions = GlobalHostScope | WorkspaceHostScope;

export interface HostSessionControllerOptions {
  services: HostSessionServices;
  capabilities: HostCapabilities;
  emit: (message: HostToClientMessage) => void;
  logger: MorseLogger;
  /**
   * Which sessions/projects this host may show and open. `workspace` restricts
   * everything to the given roots (VS Code); `global` shows them all.
   */
  scope?: HostScopeOptions;
  /** Present when the host can render interactions natively; omitted otherwise. */
  dialogs?: NativeDialogs;
  /** Transcript storage shared by every client of this host. */
  transcripts: SessionTranscriptStore;
  frontend?: FrontendIdentity;
  onHostCommand?: HostCommandHandler;
  autoOpen?: boolean;
  /**
   * Runs interactive shells for the bottom panel's terminal. Omitted by a host
   * that leaves `capabilities.terminal` off (VS Code keeps its own terminal).
   */
  terminal?: TerminalBackend;
  /**
   * Dispose the shared session registry together with this controller.
   * Defaults to false: registries outlive a client so a refresh reattaches.
   */
  ownsRegistry?: boolean;
  /**
   * The one session this client shows, when it is not the host's shared "session
   * in front". A VS Code editor tab is exactly that: a client pinned to one
   * conversation, opened from the sidebar and closed with its tab.
   *
   * A pinned controller always activates its own session on start (reusing the
   * warm process, or resuming it by id), and addresses every command at it —
   * Stop, a prompt, the model, compaction — so a sidebar that has since switched
   * to another session cannot receive this tab's next prompt. The registry's own
   * `activeKey` is still moved by that activation: one window has one session in
   * front, and the sidebar reattaches to whichever one was last activated.
   */
  pinnedSessionId?: string;
  /** Shown to the user when the agent backend cannot be started. */
  agentHint?: string;
  policy?: ProjectPolicy;
}

/** A value the controller accepted after validating it against something. */
interface GuardedOk<T> {
  ok: true;
  value: T;
}

/** A value the controller refused; the caller answers with its own error. */
interface GuardedFailed {
  ok: false;
}

type Guarded<T> = GuardedOk<T> | GuardedFailed;

/** How many history entries one page carries when a resumed session is seeded. */
const HISTORY_PAGE_SIZE = 50;

/** The title a session without a name shows until the user says something. */
const UNTITLED_SESSION = 'New session';

/**
 * The application service both hosts share: it owns the wire conversation for
 * one client, routes client messages into the core use cases, and projects agent
 * events back onto the wire.
 *
 * Multiple sessions and projects run at once: every session gets its own
 * transcript projector, and only the active one is streamed to the client (the
 * others stay warm and are replayed in full when the client switches to them).
 */
export class HostSessionController {
  private summaries = new Map<string, SessionSummary>();
  private detachRegistry: (() => void) | undefined;
  private detachTranscripts: (() => void) | undefined;
  private detachRemovals: (() => void) | undefined;
  private detachMcpWatch: (() => void) | undefined;
  private activeKey: string | undefined;
  /** True while the panel shows the intentional no-session draft state. */
  private isDraft = false;
  /** Project a draft opens its first session in (browser "New session here"). */
  private draftWorkspace: WorkspaceRef | undefined;
  /**
   * How many catalog sessions of each project the client already has, keyed by
   * cwd. The host owns this rather than trusting the client's count, because the
   * first page folds live (unpersisted) sessions in and a client counting rows
   * would page past real ones. Reset on every full publish.
   */
  private sessionOffsets = new Map<string, number>();
  /** Catalog of a never-recording probe — fills the draft pickers. */
  private draftCatalog: AgentSessionState | undefined;
  /**
   * The engine the draft chose. Sticky across drafts in this host session;
   * undefined means the host's configured default.
   */
  private draftEngine: string | undefined;
  /** Picks made in the draft, applied to the session the first prompt opens. */
  private draftModel: ModelRef | undefined;
  private draftThinking: ThinkingLevel | undefined;
  /** The mode the first prompt opens in; consumed by that session. */
  private draftMode: string | undefined;
  /** True while a newly chosen engine's catalogs are being re-read. */
  private loadingEngine = false;
  /** Identifies the newest engine probe, so a stale answer cannot overwrite it. */
  private engineRefresh = 0;
  private agentReady = false;
  private agentStarting = false;
  private agentError: string | undefined;
  /** The machine-readable half of `agentError` (see `AgentFailure`). */
  private agentFailure: AgentFailure | undefined;
  /**
   * True while this client is switching to/starting a session
   * (`runSessionChange`). Kept apart from `compacting`: sharing one flag meant
   * a switch's release cleared a compaction still running in the tab the reader
   * just left, and the composer's Working indicator vanished with it.
   */
  private switchBusy = false;
  /** Keys of the sessions a compaction is running for (`session/compact`). */
  private readonly compacting = new Set<string>();
  /**
   * Compactions the reader scheduled while their conversation was still working
   * (`session/compact` with `schedule`): session key -> the instructions it was
   * asked with. pi compacts by aborting the run in flight, so these wait for that
   * session's settle — `agent/run-end`, which only fires once the queued
   * follow-ups have drained too.
   */
  private readonly scheduledCompacts = new Map<string, string | undefined>();
  /**
   * The session a switch is heading for, set the moment `session/activate`
   * arrives and cleared once `adopt` has landed. Every state emitted in between
   * is built from it, so a client that already put the new tab in front never
   * receives the state of the tab it just left — its Working lighting up under
   * the tab now in front.
   */
  private pendingKey: string | undefined;
  private disposed = false;
  private hasOpenedOnce = false;
  private hostReadyEmitted = false;
  /**
   * Browser dialogs the agent is waiting on, keyed by request id. The value
   * carries the owning session, so the answer is routed back to the pi process
   * that asked — a dialog in a background conversation must not be answered by
   * whichever session happens to be in front.
   */
  private readonly pendingInteractions = new Map<
    string,
    { sessionKey: string; request: AgentInteractionRequest }
  >();
  /** The one pending request this client is showing, so a session switch swaps it. */
  private shownInteractionId: string | undefined;
  /** Cursor of the oldest history page loaded for the active session. */
  private historyBefore: string | undefined;
  private hasOlderHistory = false;
  private loadingOlderHistory = false;
  /**
   * True while the thinking levels of a just-picked model are being re-read.
   * pi scopes the levels to the *current* model, so they can only follow the
   * switch (see `setModel`); until they land the picker would be showing the
   * previous model's list, which is worse than saying it is reading.
   */
  private loadingThinkingLevels = false;
  /**
   * Identifies the newest thinking-levels refresh. A slower, superseded probe
   * compares its ticket before clearing the flag, so a second pick keeps its
   * own loading row instead of the first one's answer.
   */
  private thinkingLevelsRefresh = 0;
  /**
   * Serializes the client messages that change what a prompt is answered with,
   * so a prompt can never overtake a model or thinking pick it should follow.
   *
   * The transport fires every message without awaiting the last (`void
   * controller.handleClientMessage(...)`), and `model/set` is slow — it awaits
   * pi, which re-reads the new model's thinking levels before it is done. A fast
   * Enter used to run `chat/prompt` in parallel, reaching the agent before the
   * switch: the prompt was answered, or reasoned, by the previous model's
   * settings. Chaining the mutating messages here restores the order the reader
   * saw on screen — model, then thinking, then the prompt.
   */
  private clientChain: Promise<void> = Promise.resolve();
  /** Discriminates history item ids across pages (see `historyItems`). */
  private historyPageSeq = 0;
  /** This client's live attachments to shells, keyed by the terminal id it named. */
  private readonly terminals = new Map<string, TerminalSession>();
  /**
   * The ids this connection has already opened. It separates a *first* open — a
   * page reattaching to a shell the host still runs — from a repeat open (the
   * Restart button), which must replace the shell and clear its scrollback
   * instead of replaying it into the emulator that already shows it.
   */
  private readonly openedTerminals = new Set<string>();
  /**
   * Bumped whenever a terminal id is opened or closed. A shell's late `exit`
   * (a replaced one, a killed one) compares its generation and stays silent, so
   * it cannot delete or report over the shell now holding the id.
   */
  private readonly terminalGenerations = new Map<string, number>();

  constructor(private readonly options: HostSessionControllerOptions) {}

  async start(): Promise<void> {
    this.detachRegistry = this.options.services.registry.subscribe((tagged) => {
      void this.onTaggedEvent(tagged.sessionKey, tagged.event);
    });
    // The transcript lives with the session, not with this connection: forward
    // the updates of whichever session this client is showing.
    this.detachTranscripts = this.options.transcripts.subscribe((update) => {
      if (update.sessionKey === this.activeKey) {
        this.options.emit(update.message);
      }
    });
    // A scheduled compaction belongs to a live session: when one leaves the hot
    // set (a close, a delete, the LRU) its schedule goes with it, so a session
    // reopened later cannot inherit a compact nobody is waiting for anymore.
    this.detachRemovals = this.options.services.registry.onRemoval((key) => {
      this.scheduledCompacts.delete(key);
    });
    // A host watch over pi's `mcp.json` files: a config edited in a terminal (or
    // by another window) reaches this client without it having to poll the
    // expensive `pi mcp list` itself.
    this.detachMcpWatch = this.options.services.mcpWatch?.subscribe((cwd) => {
      this.options.emit({ type: 'mcp/changed', payload: { cwd } });
    });
    if (this.options.autoOpen !== false || this.options.pinnedSessionId !== undefined) {
      // Answer the handshake immediately with a truthful state: the agent is
      // starting. Otherwise the client renders its defaults for the whole spawn.
      this.agentStarting = true;
    }
    this.emitReady();
    const pinned = this.options.pinnedSessionId;
    if (pinned !== undefined) {
      // A pinned client (a VS Code editor tab) shows one session and only that
      // one. Activate it whatever the registry's host-wide `activeKey` is now:
      // `activate` reuses a warm process, or resumes the session by id, so this
      // spawns nothing it does not have to — and the sidebar's own session in
      // front is left exactly where it was until the reader acts in this tab.
      await this.runSessionChange(() => this.options.services.registry.activate(pinned));
      // Re-read the model catalog so a model added while the panel was away
      // shows up without restarting the host.
      void this.refreshModels();
    } else if (this.options.autoOpen !== false) {
      await this.openDefaultSession();
    } else {
      // A reconnecting client (webview reload, browser refresh) must reattach
      // the session the host was already showing: the warm transcript replays
      // and the Reload button keeps the conversation instead of landing on an
      // empty panel. Activating a hot session spawns nothing; only a host with
      // no active session stays on the empty draft, which is what keeps a fresh
      // window from spawning a throwaway "New session" — the panel stays empty
      // until the user actually says something.
      const existingKey = this.options.services.registry.activeKeyOf();
      if (existingKey === undefined) {
        this.isDraft = true;
        void this.warmDraft();
      } else {
        await this.runSessionChange(() => this.options.services.registry.activate(existingKey));
        // A reload keeps the warm session: re-read its model catalog so a model
        // added while the panel was away shows up without restarting the host.
        void this.refreshModels();
      }
    }
    void this.publishLists();
  }

  /**
   * Points this controller at a new client. Hosts that reattach a still-warm
   * session to a reconnecting client use this so the same agent process keeps
   * serving without being respawned.
   */
  setEmitter(emit: (message: HostToClientMessage) => void): void {
    this.options.emit = emit;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // Detach, do not kill: the shell and its scrollback belong to the host now,
    // so a reloaded page (a browser refresh) can attach to the same process. An
    // explicit `terminal/close` is the only thing that ends a shell.
    for (const session of this.terminals.values()) {
      session.detach();
    }
    this.terminals.clear();
    this.terminalGenerations.clear();
    // The next connection is a new viewer, so every id is a first open again.
    this.openedTerminals.clear();
    this.detachRegistry?.();
    this.detachRegistry = undefined;
    this.detachTranscripts?.();
    this.detachTranscripts = undefined;
    this.detachRemovals?.();
    this.detachRemovals = undefined;
    this.detachMcpWatch?.();
    this.detachMcpWatch = undefined;
    if (this.options.ownsRegistry === true) {
      await this.options.services.registry.dispose();
    }
  }

  async handleClientMessage(message: ClientToHostMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    // Ordering matters only where a message changes the state a later one reads:
    // a prompt must not overtake the model/thinking pick it follows (see
    // `clientChain`). Terminal keystrokes and reads stay immediate — a shell
    // must echo without waiting on a slow model switch, and a list refresh has
    // nothing to order against.
    const mutatesSettings =
      message.type === 'model/set' ||
      message.type === 'thinking/set' ||
      message.type === 'chat/prompt';
    if (!mutatesSettings) {
      await this.dispatchClientMessage(message);
      return;
    }
    const run = this.clientChain.then(() => this.dispatchClientMessage(message));
    // Keep the chain alive even when this message throws, or one failed send
    // would wedge every later pick.
    this.clientChain = run.catch(() => undefined);
    await run;
  }

  private async dispatchClientMessage(message: ClientToHostMessage): Promise<void> {
    switch (message.type) {
      case 'client/ready':
        if (message.payload.protocolVersion !== PROTOCOL_VERSION) {
          // A refused handshake is a banner, not a conversation entry: only the
          // transient error is sent, so no transcript is polluted.
          this.emitWireError(
            'Frontend and host speak different protocol versions.',
            `frontend=${message.payload.protocolVersion} host=${PROTOCOL_VERSION}`,
          );
          return;
        }
        if (message.payload.frontend) {
          this.options.logger.info(
            `Frontend ${message.payload.frontend.name}@${message.payload.frontend.version} connected`,
          );
        }
        // While the first session is still starting, `start()` owns the single
        // `host/ready` we send. Answering here would flash "agent unavailable".
        if (!this.hostReadyEmitted) {
          return;
        }
        this.emitReady();
        void this.publishLists();
        return;
      case 'chat/prompt':
        await this.prompt(
          message.payload.text,
          message.payload.mode,
          message.payload.images,
          message.payload.pins,
          message.payload.sessionKey,
        );
        return;
      case 'chat/edit':
        await this.editPrompt(message.payload.itemId, message.payload.text);
        return;
      case 'chat/fork':
        await this.forkPrompt(message.payload.itemId);
        return;
      case 'chat/abort':
        await this.guard(() => this.options.services.chat.abort(this.promptTarget()));
        return;
      case 'session/new':
        // "New session" is an empty draft, not a spawn: no engine session, no
        // index row, no navigator entry. The first prompt opens the actual
        // session (see `prompt`). The optional cwd targets it — the browser
        // nav's "New session here" picks a project this way.
        await this.enterDraft(message.payload.cwd ? workspaceOf(message.payload.cwd) : undefined);
        return;
      case 'session/activate':
      case 'session/load':
        await this.activateSession(message.payload.sessionId, message.payload.cwd);
        return;
      case 'session/refresh':
        await this.refreshSession();
        return;
      case 'session/close':
        await this.closeSession(message.payload.sessionId);
        return;
      case 'session/delete':
        await this.deleteSession(message.payload.sessionId);
        return;
      case 'session/compact': {
        // The key the frontend sends pins the compaction to the conversation its
        // dialog was opened over. Without it (older frontends, the shared panel)
        // the session in front is the target, which is the only sensible default;
        // with no session at all it is the host's active one, as `chat.compact`
        // resolves it (`requireActive`).
        const targetKey =
          message.payload.sessionKey ??
          this.promptTarget() ??
          this.options.services.registry.activeKeyOf();
        // "Schedule Compact": pi compacts by aborting whatever is running, so a
        // reader with a run (and queued follow-ups) in flight wants this at the
        // settle instead. A run that already ended while the question was up
        // would never fire it again — there is nothing left to wait for — so
        // that case falls through and compacts now.
        if (
          message.payload.schedule === true &&
          targetKey !== undefined &&
          this.options.services.registry.stateOf(targetKey)?.streaming === true
        ) {
          this.scheduledCompacts.set(targetKey, message.payload.instructions);
          this.options.emit(
            noticeMessage(
              'info',
              'Compaction scheduled — it runs when this conversation finishes.',
              Date.now(),
            ),
          );
          return;
        }
        await this.runCompact(message.payload.instructions, message.payload.sessionKey);
        return;
      }
      case 'history/load':
        await this.loadOlderHistory();
        return;
      case 'session/list':
        await this.publishSessions(message.payload);
        return;
      case 'commands/refresh':
        await this.refreshCommands();
        return;
      case 'models/refresh':
        await this.refreshModels();
        return;
      case 'modes/refresh':
        await this.refreshModes();
        return;
      case 'engine/set':
        await this.setEngine(message.payload.kind);
        return;
      case 'mode/set':
        await this.setMode(message.payload.mode);
        return;
      case 'project/list':
        await this.publishProjects();
        return;
      case 'project/open':
        // Target the draft at that project (browser navigation): still no
        // spawn — the first prompt opens the session there.
        await this.enterDraft(workspaceOf(message.payload.path));
        return;
      case 'model/set':
        await this.setModel(message.payload.provider, message.payload.id);
        return;
      case 'thinking/set':
        await this.setThinkingLevel(message.payload.level);
        return;
      case 'interaction/respond':
        await this.respondToInteraction(message.payload);
        return;
      case 'host/command':
        await this.runHostCommand(
          message.payload.command,
          message.payload.args,
          message.payload.requestId,
        );
        return;
      case 'terminal/open':
        await this.openTerminal(message.payload);
        return;
      case 'terminal/input':
        this.terminals.get(message.payload.terminalId)?.write(message.payload.data);
        return;
      case 'terminal/resize':
        this.terminals
          .get(message.payload.terminalId)
          ?.resize(message.payload.cols, message.payload.rows);
        return;
      case 'terminal/close':
        this.closeTerminal(message.payload.terminalId);
        return;
      default:
        return;
    }
  }

  /**
   * Attaches this client to a shell for the bottom panel. The directory is the
   * viewing session's (or the draft's), never an arbitrary path the client
   * names — the backend still re-checks it against the host policy before
   * spawning.
   *
   * A *first* open on this connection may land on a shell that is already running
   * (a reloaded page reattaching); a repeat open (the Restart button) replaces
   * it, scrollback and all, so the fresh shell does not replay the old one.
   */
  private async openTerminal(payload: {
    terminalId: string;
    cwd?: string;
    cols?: number;
    rows?: number;
  }): Promise<void> {
    const backend = this.options.terminal;
    if (backend === undefined) {
      this.emitTerminalExit(payload.terminalId, undefined, 'This host has no terminal.');
      return;
    }
    // A repeat open on this connection is a *reattach*: a pane that remounted
    // (a rebuilt view) is asking for the shell it already has, not a new one.
    // Detach the superseded viewer only; `attach` below reuses the live shell
    // and replays what that viewer missed. A shell that already exited is the
    // other case — there the dead scrollback is dropped so a fresh shell does
    // not replay it over the emulator that still shows it.
    const previous = this.terminals.get(payload.terminalId);
    if (previous !== undefined) {
      previous.detach();
      this.terminals.delete(payload.terminalId);
    } else if (this.openedTerminals.has(payload.terminalId)) {
      // A restart after the shell exited: drop the dead shell's scrollback, so
      // the fresh shell does not replay it over the emulator that still has it.
      backend.close(payload.terminalId);
    }
    this.openedTerminals.add(payload.terminalId);
    // Any pending exit for a superseded shell is now stale.
    const generation = (this.terminalGenerations.get(payload.terminalId) ?? 0) + 1;
    this.terminalGenerations.set(payload.terminalId, generation);

    const cwd = payload.cwd ?? this.currentState().workspace.cwd;
    const cols = clampGeometry(payload.cols, 80);
    const rows = clampGeometry(payload.rows, 24);
    let session: TerminalSession;
    try {
      session = await backend.attach(
        payload.terminalId,
        { cwd, cols, rows },
        {
          output: (data) => {
            if (this.terminalGenerations.get(payload.terminalId) === generation) {
              this.emitTerminalOutput(payload.terminalId, data);
            }
          },
          exit: (code, error) => {
            // A shell replaced or closed after this one opened is not the shell
            // the client is looking at; its end is not news.
            if (this.terminalGenerations.get(payload.terminalId) !== generation) {
              return;
            }
            this.terminals.delete(payload.terminalId);
            this.emitTerminalExit(payload.terminalId, code, error);
          },
        },
      );
    } catch (error: unknown) {
      this.options.logger.warn('Failed to open a terminal', error);
      this.emitTerminalExit(payload.terminalId, undefined, describeTerminalError(error));
      return;
    }
    // The client may have closed it while `attach` was still awaiting the shell.
    if (!this.disposed && this.terminalGenerations.get(payload.terminalId) === generation) {
      this.terminals.set(payload.terminalId, session);
      // Catch the viewer up before the shell's next chunk: what it missed while
      // no page was attached is the whole point of a surviving terminal.
      if (session.replay.length > 0) {
        this.emitTerminalOutput(payload.terminalId, session.replay);
      }
    } else {
      // Nobody is watching any more: leave the shell running for the next attach.
      session.detach();
    }
  }

  /**
   * Ends a shell for good: the reader closed the pane. Bumps the generation first,
   * so a late `exit` for the shell being replaced is not reported as news.
   */
  private closeTerminal(terminalId: string): void {
    this.terminalGenerations.set(terminalId, (this.terminalGenerations.get(terminalId) ?? 0) + 1);
    const session = this.terminals.get(terminalId);
    this.terminals.delete(terminalId);
    this.openedTerminals.delete(terminalId);
    session?.detach();
    this.options.terminal?.close(terminalId);
  }

  private emitTerminalOutput(terminalId: string, data: string): void {
    if (data.length > 0 && !this.disposed) {
      this.options.emit({
        type: 'terminal/output',
        payload: { terminalId, data },
      });
    }
  }

  private emitTerminalExit(terminalId: string, code?: number, error?: string): void {
    if (!this.disposed) {
      this.options.emit({
        type: 'terminal/exit',
        payload: { terminalId, code, error },
      });
    }
  }

  private async openDefaultSession(): Promise<void> {
    const existingKey = this.options.services.registry.activeKeyOf();
    if (existingKey) {
      await this.runSessionChange(() => this.options.services.registry.activate(existingKey));
      return;
    }
    await this.runSessionChange(() => this.options.services.registry.open());
  }

  /**
   * The session this client addresses: the one it is showing. Every command that
   * belongs to "the conversation in front" (Stop, a prompt, the model, thinking,
   * compaction) names this key instead of reaching for the registry's host-wide
   * `activeKey` — otherwise a pinning client (a VS Code editor tab holding one
   * conversation) would act on whichever session some other panel last activated.
   * `undefined` still means "whatever the host has active", which is the shared
   * panel's own behaviour.
   */
  private promptTarget(): string | undefined {
    return this.activeKey;
  }

  /** The gateway of the session this client addresses, if it is still hot. */
  private addressedGateway(): AgentGateway | undefined {
    return this.activeKey === undefined
      ? undefined
      : this.options.services.registry.agentFor(this.activeKey);
  }

  /**
   * The empty panel is an intentional draft: no agent process, no session
   * file, no navigator entry — "New session" becomes real only once the first
   * prompt runs. A pending project and pending picks (model, thinking) wait
   * here until that first prompt opens the session they belong to.
   */
  private async enterDraft(workspace?: WorkspaceRef): Promise<void> {
    if (workspace && !this.canOpen(workspace.cwd)) {
      this.fail(
        `Morse is not allowed to run an agent in ${workspace.cwd}.`,
        'Add it to MORSE_PROJECTS first.',
      );
      return;
    }
    this.activeKey = undefined;
    this.isDraft = true;
    this.draftWorkspace = workspace;
    this.syncInteraction();
    this.resetViewState();
    this.options.emit({ type: 'transcript/replace', payload: { items: [] } });
    this.emitState();
    await this.warmDraft();
  }

  /** Clears everything the previous session had left on the view state. */
  private resetViewState(): void {
    this.historyBefore = undefined;
    this.hasOlderHistory = false;
    this.loadingOlderHistory = false;
    this.agentReady = false;
    this.agentStarting = false;
    this.clearAgentFailure();
  }

  /**
   * Forgets the agent failure, message and all. Called wherever the agent comes
   * back (a ready event, an adopted session), so a stale screen never outlives
   * the problem it described.
   */
  private clearAgentFailure(): void {
    this.agentError = undefined;
    this.agentFailure = undefined;
  }

  /**
   * Fills the draft pickers from the registry's session-less probe. A ticket is
   * passed when a newly chosen engine triggered the read, so an older probe
   * cannot land after the reader moved on; the engine/model comparison covers
   * the initial probe and a model pick made while it was in flight.
   */
  private async warmDraft(ticket?: number): Promise<void> {
    const engine = this.draftEngine;
    const model = this.draftModel;
    try {
      const catalog = await this.options.services.registry.draftDefaults(engine, model);
      if (!this.draftProbeIsCurrent(ticket, engine, model)) {
        return;
      }
      this.draftCatalog = catalog;
      this.clearAgentFailure();
      this.emitState();
    } catch (error: unknown) {
      if (!this.draftProbeIsCurrent(ticket, engine, model)) {
        return;
      }
      // The session-less probe is where a missing engine shows up on load.
      // Without this the draft looked healthy (empty pickers) until the first
      // prompt failed to spawn, and a reader with sessions in the sidebar but no
      // engine on PATH had no way to know the agent was gone.
      this.agentError = describeError(error);
      this.agentFailure = describeAgentFailure(error, this.options.agentHint);
      this.options.logger.warn('Could not probe the draft catalog', error);
      this.emitState();
    } finally {
      if (ticket !== undefined) {
        this.endEngineRefresh(ticket);
      }
    }
  }

  /** True while the answer still belongs to the draft the reader is looking at. */
  private draftProbeIsCurrent(
    ticket: number | undefined,
    engine: string | undefined,
    model: ModelRef | undefined,
  ): boolean {
    if (this.activeKey !== undefined || this.disposed) {
      return false;
    }
    if (ticket !== undefined && ticket !== this.engineRefresh) {
      return false;
    }
    return this.draftEngine === engine && this.draftModel === model;
  }

  /** Clears the engine-loading flag, unless a newer switch has taken it over. */
  private endEngineRefresh(ticket: number): void {
    if (ticket !== this.engineRefresh) {
      return;
    }
    this.loadingEngine = false;
    this.emitState();
  }

  /**
   * Switches the empty session to another installed engine. Everything that
   * belonged to the previous engine's catalog is dropped: its models, thinking
   * levels and modes are not comparable, and the first prompt must open under
   * the new engine's defaults until the reader picks again.
   */
  private async setEngine(kind: string): Promise<void> {
    if (!this.isDraft || this.activeKey !== undefined) {
      this.options.emit(
        noticeMessage(
          'warn',
          'The agent engine can only change before a session starts.',
          Date.now(),
        ),
      );
      return;
    }
    if (!this.options.services.registry.engineKinds().includes(kind)) {
      this.options.emit(
        noticeMessage('warn', `The ${kind} agent engine is not installed here.`, Date.now()),
      );
      return;
    }
    if (this.draftEngine === kind) {
      return;
    }
    this.draftEngine = kind;
    this.draftModel = undefined;
    this.draftThinking = undefined;
    this.draftMode = undefined;
    this.draftCatalog = undefined;
    this.clearAgentFailure();
    const ticket = ++this.engineRefresh;
    this.loadingEngine = true;
    this.emitState();
    await this.warmDraft(ticket);
  }

  private async activateSession(sessionId: string, cwd?: string): Promise<void> {
    const pinned = this.options.pinnedSessionId;
    if (pinned !== undefined && sessionId !== pinned) {
      // A pinned client is bound to its own conversation, so it must not follow
      // some other surface's `session/activate` — the registry's active pointer
      // is host-wide, and two tabs watching each other's switches is a bug, not
      // a feature. A tab is re-pointed by opening a different session there.
      return;
    }
    const known = this.summaries.get(sessionId);
    const path = cwd ?? known?.cwd;
    if (path && !this.canOpen(path)) {
      this.fail(
        `Morse is not allowed to run an agent in ${path}.`,
        'Add it to MORSE_PROJECTS first.',
      );
      return;
    }
    // Activating a session ends any draft, and its pending picks belonged to
    // a session that was never created — drop them here, not on the resumed
    // conversation.
    this.isDraft = false;
    this.draftWorkspace = undefined;
    this.draftModel = undefined;
    this.draftThinking = undefined;
    this.draftMode = undefined;
    await this.runSessionChange(
      () =>
        this.options.services.registry.activate(sessionId, path ? workspaceOf(path) : undefined),
      sessionId,
    );
  }

  private async closeSession(sessionId: string): Promise<void> {
    await this.guard(() => this.options.services.registry.close(sessionId));
    this.options.transcripts.clear(sessionId);
    await this.fallBackAfterSessionGone(sessionId);
  }

  /**
   * Deletes a session for good: the registry disposes its process and the
   * catalog drops the stored conversation. Which directories an agent may
   * touch is the host's rule (`ProjectPolicy`), so one use case is safe behind
   * a server allow-list and inside a VS Code window — the wiring differs, the
   * decision does not.
   */
  private async deleteSession(sessionId: string): Promise<void> {
    const path = this.summaries.get(sessionId)?.cwd;
    if (path !== undefined && path.length > 0 && !this.canOpen(path)) {
      this.fail(
        `Morse is not allowed to delete sessions in ${path}.`,
        'Add it to MORSE_PROJECTS first.',
      );
      return;
    }
    const result = await this.guard(() => this.options.services.registry.remove(sessionId));
    if (!result.ok) {
      return;
    }
    this.options.transcripts.clear(sessionId);
    await this.fallBackAfterSessionGone(sessionId);
    this.options.emit(noticeMessage('info', 'Session deleted.', Date.now()));
  }

  /** The panel must stay usable once the session it showed is gone. */
  private async fallBackAfterSessionGone(sessionId: string): Promise<void> {
    if (this.activeKey !== sessionId) {
      this.publishActivity();
      await this.publishSessions();
      return;
    }

    // Keep the client usable: adopt another hot session, or return to the
    // empty panel. Spawning a replacement nobody asked for would recreate the
    // throwaway-session problem — the next prompt lazily opens one instead.
    this.activeKey = undefined;
    this.historyBefore = undefined;
    this.hasOlderHistory = false;
    this.loadingOlderHistory = false;
    this.agentReady = false;
    this.clearAgentFailure();
    const next = this.options.services.registry.hotKeys().at(-1);
    if (this.options.pinnedSessionId !== undefined) {
      // A pinned client's session is gone: showing it another hot session would
      // silently turn this tab into a different conversation. It returns to the
      // empty draft instead, which is the honest thing for a tab whose session
      // was closed or deleted from the sidebar.
      await this.enterDraft();
    } else if (next) {
      await this.runSessionChange(() => this.options.services.registry.activate(next), next);
    } else {
      // Return to the draft the way session/new made it: no replacement
      // session nobody asked for; the next prompt opens one.
      await this.enterDraft();
    }
    await this.publishSessions();
  }

  /**
   * Opens/activates a session while reporting progress and failures.
   * `targetKey` is the session the reader's tab already shows: from the first
   * emit the view describes it, never the session they just left.
   */
  private async runSessionChange(
    change: () => Promise<OpenedSession>,
    targetKey?: string,
  ): Promise<void> {
    const announce = this.hasOpenedOnce;
    if (targetKey !== undefined) {
      this.pendingKey = targetKey;
    }
    if (announce) {
      // The switch's own pulse: Working while the target starts, released in
      // `finally` — never touching a compaction another session may be running.
      this.switchBusy = true;
    }
    this.agentStarting = true;
    if (announce) {
      this.emitState();
    }
    try {
      const opened = await change();
      this.adopt(opened);
    } catch (error: unknown) {
      this.agentReady = false;
      this.agentError = describeError(error);
      this.agentFailure = describeAgentFailure(error, this.options.agentHint);
      this.options.logger.warn('Could not start the Morse agent', error);
      this.fail(`Could not start the Morse agent: ${this.agentError}`, this.options.agentHint);
    } finally {
      this.agentStarting = false;
      this.hasOpenedOnce = true;
      // `adopt` has landed (or the switch failed): the view speaks for
      // `activeKey` again, and the switch's own busy flag is released without
      // touching a compaction another session may still be running.
      this.pendingKey = undefined;
      if (announce) {
        this.switchBusy = false;
        this.emitState();
      } else {
        this.emitState();
      }
    }
  }

  private adopt(opened: OpenedSession): void {
    this.activeKey = opened.key;
    // A real session is showing from now on; the draft target is consumed by
    // the open that just happened.
    this.isDraft = false;
    this.draftWorkspace = undefined;
    if (!opened.reused) {
      // A brand new process for this key: drop any stale transcript.
      this.options.transcripts.reset(opened.key);
    }
    // Paging state belongs to the session being adopted, never to the previous one.
    this.historyBefore = undefined;
    this.hasOlderHistory = false;
    this.loadingOlderHistory = false;
    this.agentReady = true;
    this.clearAgentFailure();
    this.emitTranscript(opened.key);
    this.emitState();
    // A session can have been waiting on a dialog while it was in the
    // background; adopting it puts that dialog back in this client's slot.
    this.syncInteraction();
    // A new/activated session must show up in the list immediately; otherwise
    // the user picks "New session" and it is nowhere to be seen.
    void this.publishSessions();
    void this.seedHistory(opened.key);
  }

  /**
   * A resumed session has its messages on disk but streams nothing on attach, so
   * the transcript would look empty. Fill it from the *newest* page of history:
   * a session with thousands of messages must open without rendering them all,
   * and older pages are fetched on demand (see `loadOlderHistory`).
   */
  private async seedHistory(key: string): Promise<void> {
    if (this.options.transcripts.items(key).length > 0) {
      // A reattach (refresh, second window) already has the transcript; restore
      // how far back it was paged instead of forgetting older pages exist.
      const cursor = this.options.transcripts.historyCursor(key);
      this.historyBefore = cursor.before;
      this.hasOlderHistory = cursor.hasOlder;
      this.emitState();
      return;
    }
    if (this.activeKey !== key) {
      return;
    }
    const gateway = this.addressedGateway();
    if (!gateway) {
      return;
    }
    // A resumed session is seeded from history, so until the page lands we do
    // not yet know that it reaches the beginning: show "Loading older…" rather
    // than claiming "Start of conversation".
    this.loadingOlderHistory = true;
    this.emitState();
    const result = await this.guard(() => gateway.history({ limit: HISTORY_PAGE_SIZE }));
    this.loadingOlderHistory = false;
    if (!result.ok || this.options.transcripts.items(key).length > 0 || this.activeKey !== key) {
      this.emitState();
      return;
    }
    this.historyBefore = result.value.before;
    this.hasOlderHistory = result.value.hasOlder;
    this.options.transcripts.setHistoryCursor(key, {
      before: result.value.before,
      hasOlder: result.value.hasOlder,
    });
    this.options.transcripts.seed(
      key,
      historyItems(key, result.value.entries, this.historyPageSeq++),
    );
    this.emitState();
  }

  /** Prepends the previous page of history when the reader reaches the top. */
  private async loadOlderHistory(): Promise<void> {
    if (!this.hasOlderHistory || this.loadingOlderHistory) {
      return;
    }
    const key = this.activeKey;
    const gateway = this.addressedGateway();
    if (key === undefined || !gateway) {
      return;
    }
    this.loadingOlderHistory = true;
    this.emitState();
    const result = await this.guard(() =>
      gateway.history({ limit: HISTORY_PAGE_SIZE, before: this.historyBefore }),
    );
    this.loadingOlderHistory = false;
    if (!result.ok || this.activeKey !== key) {
      this.emitState();
      return;
    }
    this.historyBefore = result.value.before;
    this.hasOlderHistory = result.value.hasOlder;
    this.options.transcripts.setHistoryCursor(key, {
      before: result.value.before,
      hasOlder: result.value.hasOlder,
    });
    this.options.transcripts.prepend(
      key,
      historyItems(key, result.value.entries, this.historyPageSeq++),
    );
    this.emitState();
  }

  /**
   * Re-reads the conversation in front from the agent's own storage. A watched
   * session is written by someone else — a subagent's parent process keeps
   * running while this panel only displays — so its transcript ages in place,
   * and `seedHistory`'s guard ("already has items") would happily leave it
   * stale forever. This replaces the newest page from the source; anything the
   * live stream already delivered converges with what the engine stored.
   */
  private async refreshSession(): Promise<void> {
    const key = this.activeKey;
    if (key === undefined) {
      return;
    }
    const gateway = this.addressedGateway();
    if (!gateway) {
      return;
    }
    // An adapter that kept its first read (pi caches `get_entries`) is told to
    // let it go before the re-read, or the refresh would serve the snapshot
    // from when this gateway attached.
    await gateway.refreshHistory?.();
    const result = await this.guard(() => gateway.history({ limit: HISTORY_PAGE_SIZE }));
    if (!result.ok || this.activeKey !== key) {
      return;
    }
    this.options.transcripts.reset(key);
    this.historyBefore = result.value.before;
    this.hasOlderHistory = result.value.hasOlder;
    this.options.transcripts.setHistoryCursor(key, {
      before: result.value.before,
      hasOlder: result.value.hasOlder,
    });
    this.options.transcripts.seed(
      key,
      historyItems(key, result.value.entries, this.historyPageSeq++),
    );
    this.emitTranscript(key);
    this.emitState();
  }

  private canOpen(path: string): boolean {
    const scope = this.options.scope ?? { kind: 'global' };
    if (scope.kind === 'workspace' && !insideRoots(path, scope.roots)) {
      return false;
    }
    return this.options.policy?.canOpen(path) ?? true;
  }

  private withinScope(path: string): boolean {
    const scope = this.options.scope ?? { kind: 'global' };
    return scope.kind === 'global' || insideRoots(path, scope.roots);
  }

  private async prompt(
    text: string,
    mode: PromptMode | undefined,
    images: PromptImage[] | undefined,
    pins: ChatPin[] | undefined,
    sessionKey?: string,
  ): Promise<void> {
    // An addressed prompt belongs to another session: it must not touch the draft
    // or the active session's view state, and the panel must not switch to it.
    if (sessionKey !== undefined && sessionKey !== this.activeKey) {
      await this.promptInBackground(sessionKey, text, mode, images, pins);
      return;
    }
    if (!this.agentReady) {
      if (this.isDraft) {
        // The draft becomes the session it was waiting for: a fresh, recorded
        // one in the chosen engine and mode, in the pending workspace — never a
        // re-activation of whatever session another connection happens to have
        // active.
        const engine = this.draftEngine;
        const draftMode = this.draftMode;
        await this.runSessionChange(() =>
          this.options.services.registry.open({
            workspace: this.draftWorkspace,
            ...(engine === undefined ? {} : { engine }),
            ...(draftMode === undefined ? {} : { mode: draftMode }),
          }),
        );
        this.draftWorkspace = undefined;
        // The mode belonged to the session just created; the next draft starts
        // on the engine's own default. The engine choice stays sticky.
        this.draftMode = undefined;
      } else {
        await this.openDefaultSession();
      }
      if (!this.agentReady) {
        return;
      }
    }
    this.isDraft = false;
    // Picks made in the draft become the fresh session's settings, applied
    // before the first prompt so the answer already answers to them.
    const pendingModel = this.draftModel;
    const pendingThinking = this.draftThinking;
    this.draftModel = undefined;
    this.draftThinking = undefined;
    if (pendingModel) {
      await this.guard(() =>
        this.options.services.chat.setModel(
          {
            provider: pendingModel.provider,
            id: pendingModel.id,
            name: pendingModel.name,
          },
          this.promptTarget(),
        ),
      );
    }
    if (pendingThinking) {
      await this.guard(() =>
        this.options.services.chat.setThinkingLevel(pendingThinking, this.promptTarget()),
      );
    }
    const result = await this.guard(() =>
      this.options.services.chat.prompt(text, mode ?? 'new', images, pins, this.promptTarget()),
    );
    if (!result.ok || !result.value.accepted) {
      return;
    }
    const key = this.activeKey;
    if (key) {
      // The transcript shows the message with its attachments: the pins and
      // images stay chips on the user item, whatever a later reload replays.
      this.options.transcripts.userPrompt(key, text, images, pins);
      // A nameless session takes its title from the first message (an engine may
      // name it, or the catalog derives it from the text), so refresh the
      // navigator right away instead of leaving it on "New session" until the
      // next list request.
      void this.publishSessions();
    }
  }

  /**
   * Delivers a prompt to a live session that is not the one in front: a queued
   * follow-up draining while the reader looks at another tab. The target keeps
   * its own transcript and activity; the open panel never switches to it.
   */
  private async promptInBackground(
    sessionKey: string,
    text: string,
    mode: PromptMode | undefined,
    images: PromptImage[] | undefined,
    pins: ChatPin[] | undefined,
  ): Promise<void> {
    const result = await this.guard(() =>
      this.options.services.chat.prompt(text, mode ?? 'new', images, pins, sessionKey),
    );
    if (!result.ok || !result.value.accepted) {
      return;
    }
    // The transcript of that session gets the user item; its own events keep it
    // warm through `onTaggedEvent`, and switching to it later replays them.
    this.options.transcripts.userPrompt(sessionKey, text, images, pins);
    // The first message names the session, so the navigator may need the title.
    void this.publishSessions();
  }

  /**
   * Edits a past user message: fork the conversation before it (which discards
   * that turn and everything after), truncate the transcript to match, then send
   * the edited text as a fresh prompt. Attachments on the original message ride
   * along, so an image or pin is not silently dropped by the edit.
   */
  private async editPrompt(itemId: string, text: string): Promise<void> {
    const target = await this.forkBefore(itemId, 'edit');
    if (!target) {
      return;
    }
    await this.prompt(text, 'new', target.images, target.pins);
  }

  /**
   * Branches the conversation before a past user message without sending
   * anything. A fork moves the conversation to a new engine session (a new
   * harness id, hence a new Morse id) while the old branch stays resumable; the
   * transcript re-homes onto the new, shorter branch and the forked prompt goes
   * back to the composer, so the user continues from the fork point instead of
   * retyping it.
   */
  private async forkPrompt(itemId: string): Promise<void> {
    const target = await this.forkBefore(itemId, 'fork');
    if (!target) {
      return;
    }
    // Only a committed fork seeds the composer; a cancelled one leaves it alone.
    this.options.emit({
      type: 'composer/seed',
      payload: {
        text: target.text,
        ...(target.images ? { images: target.images } : {}),
        ...(target.pins ? { pins: target.pins } : {}),
      },
    });
    // The fork is a new session (the engine moved to a new id, so the router
    // derived a new one): surface it in the navigator now instead of waiting
    // for a prompt to refresh the list.
    void this.publishSessions();
  }

  /**
   * Forks the active session before a past user message and re-homes the
   * transcript onto the new branch. Shared by edit (which then sends) and fork
   * (which seeds the composer). Returns the forked message, or `undefined` when
   * the fork was refused — a notice has already been emitted in that case.
   */
  private async forkBefore(
    itemId: string,
    action: 'edit' | 'fork',
  ): Promise<UserTranscriptItem | undefined> {
    const gerund = action === 'edit' ? 'editing' : 'forking';
    const past = action === 'edit' ? 'edited' : 'forked';
    if (this.isDraft) {
      // No session exists in a draft, so there is nothing to fork: do not spawn
      // one just to fail the lookup (or re-activate another session).
      this.options.emit(
        noticeMessage(
          'warn',
          `Nothing to ${action} yet — this session has no messages.`,
          Date.now(),
        ),
      );
      return undefined;
    }
    if (!this.agentReady) {
      await this.openDefaultSession();
      if (!this.agentReady) {
        return undefined;
      }
    }
    const key = this.activeKey;
    const gateway = this.addressedGateway();
    if (key === undefined || !gateway) {
      this.options.emit(noticeMessage('warn', `No session to ${action}.`, Date.now()));
      return undefined;
    }
    const items = this.options.transcripts.items(key);
    const target = items.find((item) => item.id === itemId);
    if (!target || target.kind !== 'user') {
      this.options.emit(
        noticeMessage('warn', `That message is no longer available to ${action}.`, Date.now()),
      );
      return undefined;
    }
    if (this.options.services.registry.stateOf(key)?.streaming === true) {
      this.options.emit(
        noticeMessage(
          'warn',
          `Wait for the agent to finish before ${gerund} a message.`,
          Date.now(),
        ),
      );
      return undefined;
    }

    const messages = await this.guard(() => gateway.forkMessages());
    if (!messages.ok) {
      return undefined;
    }
    const entryId = entryIdForEdit(items, itemId, messages.value);
    if (entryId === undefined) {
      this.options.emit(
        noticeMessage(
          'warn',
          `This message cannot be ${past} — the agent has no fork point for it.`,
          Date.now(),
        ),
      );
      return undefined;
    }

    const forked = await this.guard(() => this.options.services.registry.forkActive(entryId));
    if (!forked.ok) {
      return undefined;
    }
    if (forked.value.cancelled) {
      this.options.emit(noticeMessage('warn', 'The fork was cancelled.', Date.now()));
      return undefined;
    }

    // The forked branch ends right before the chosen message: drop that row and
    // everything after it, then re-home the transcript under the new session id.
    const index = items.findIndex((item) => item.id === itemId);
    const kept = items.slice(0, index);
    this.activeKey = forked.value.key;
    this.options.transcripts.move(key, forked.value.key, kept);
    this.historyBefore = undefined;
    this.hasOlderHistory = false;
    this.loadingOlderHistory = false;
    this.emitState();

    return target;
  }

  private async setModel(provider: string, id: string): Promise<void> {
    if (this.activeKey === undefined) {
      // Draft pick: shown as the pending model, applied to the session the
      // first prompt opens. Without a probe-cached catalog the name falls back
      // to the id the client sent.
      const match = this.draftCatalog?.availableModels.find(
        (model) => model.provider === provider && model.id === id,
      );
      const picked = match ?? { provider, id, name: id };
      this.draftModel = picked;
      // pi reports thinking levels per *current* model, so the picker has to be
      // re-probed for the model the reader just chose before a session exists —
      // unless that model was probed before, in which case its levels are
      // already known and land in the same frame as the pick.
      const cached = this.options.services.registry.cachedDraftDefaults(this.draftEngine, picked);
      if (cached) {
        this.draftCatalog = cached;
        this.emitState();
        return;
      }
      const ticket = this.beginThinkingLevelsRefresh();
      await this.refreshDraftCatalog(picked, ticket);
      return;
    }
    const ticket = this.beginThinkingLevelsRefresh();
    await this.guard(() =>
      this.options.services.chat.setModel({ provider, id, name: id }, this.promptTarget()),
    );
    this.endThinkingLevelsRefresh(ticket);
  }

  /**
   * Announces on the wire that the levels of the picked model are being read,
   * and returns the ticket that identifies this refresh (see
   * `endThinkingLevelsRefresh`). The state is emitted either way, so the picker
   * names the model it is about to describe instead of sitting on the previous
   * one while it waits.
   */
  private beginThinkingLevelsRefresh(): number {
    const ticket = ++this.thinkingLevelsRefresh;
    this.loadingThinkingLevels = true;
    this.emitState();
    return ticket;
  }

  /** Clears the loading row, unless a newer pick has taken the flag over. */
  private endThinkingLevelsRefresh(ticket: number): void {
    if (ticket !== this.thinkingLevelsRefresh) {
      return;
    }
    this.loadingThinkingLevels = false;
    // Emitted here, after the new catalog is in `draftCatalog`, so the levels and
    // the end of the loading row reach the picker as one state: a message with
    // the old list and no spinner would read as "this model has no reasoning".
    this.emitState();
  }

  /**
   * Re-reads the draft catalog for a model picked before any session exists, so
   * the thinking picker mirrors that model's levels instead of the default
   * model's. The request is dropped when the reader picks again or a session
   * opens while the probe is in flight.
   */
  private async refreshDraftCatalog(model: ModelRef, ticket: number): Promise<void> {
    const engine = this.draftEngine;
    try {
      const catalog = await this.options.services.registry.draftDefaults(engine, model);
      if (
        catalog &&
        this.activeKey === undefined &&
        !this.disposed &&
        this.draftEngine === engine &&
        this.draftModel === model
      ) {
        this.draftCatalog = catalog;
      }
    } catch (error: unknown) {
      this.options.logger.warn('Could not probe the draft catalog for the picked model', error);
    }
    this.endThinkingLevelsRefresh(ticket);
  }

  private async setThinkingLevel(level: SessionViewState['thinkingLevel']): Promise<void> {
    if (this.activeKey === undefined) {
      this.draftThinking = level;
      this.emitState();
      return;
    }
    const result = await this.guard(() =>
      this.options.services.chat.setThinkingLevel(level, this.promptTarget()),
    );
    if (result.ok) {
      this.emitState();
    }
  }

  /**
   * Picks a named way of working. A draft holds it for the session the first
   * prompt opens; a running session switches through its own gateway. An id the
   * harness does not offer is refused instead of being sent blindly.
   */
  private async setMode(mode: string): Promise<void> {
    if (this.isDraft) {
      const offered = this.draftCatalog?.availableModes ?? [];
      if (!offered.some((option) => option.id === mode)) {
        this.options.emit(
          noticeMessage(
            'warn',
            `The selected agent engine does not offer the "${mode}" mode.`,
            Date.now(),
          ),
        );
        return;
      }
      this.draftMode = mode;
      this.emitState();
      return;
    }
    const key = this.viewKey();
    const state = key === undefined ? undefined : this.options.services.registry.stateOf(key);
    if (
      state?.availableModes !== undefined &&
      !state.availableModes.some((option) => option.id === mode)
    ) {
      this.options.emit(
        noticeMessage(
          'warn',
          `The selected agent engine does not offer the "${mode}" mode.`,
          Date.now(),
        ),
      );
      return;
    }
    const result = await this.guard(() =>
      this.options.services.chat.setMode(mode, this.promptTarget()),
    );
    if (result.ok) {
      this.emitState();
    }
  }

  private async respondToInteraction(response: InteractionResponse, owner?: string): Promise<void> {
    const sessionKey =
      owner ?? this.pendingInteractions.get(response.requestId)?.sessionKey ?? this.activeKey;
    this.pendingInteractions.delete(response.requestId);
    this.syncInteraction();
    // A session that is no longer hot has no process left to answer; the dialog
    // it was waiting on is already gone with it.
    const gateway =
      sessionKey === undefined ? undefined : this.options.services.registry.agentFor(sessionKey);
    if (!gateway) {
      this.publishActivity();
      return;
    }
    await this.guard(() => gateway.respondToInteraction(response));
    this.publishActivity();
  }

  /**
   * The palette asked for a fresh command list. The agent re-reads the template
   * files and reports back through `agent/state`, so the composer sees a template
   * added, changed or deleted since the session started — without a pi reload.
   */
  private async refreshCommands(): Promise<void> {
    const gateway = this.addressedGateway();
    if (gateway?.refreshCommands === undefined) {
      return;
    }
    await this.guard(() => gateway.refreshCommands!());
  }

  /**
   * Re-reads the model catalog on request. A warm session re-asks pi over RPC
   * (cheap); a draft re-runs the session-less probe, since that is where its
   * picker's catalog came from and it would otherwise be frozen for the host's
   * lifetime.
   */
  private async refreshModels(): Promise<void> {
    if (this.activeKey === undefined) {
      this.options.services.registry.refreshDraftDefaults();
      await this.warmDraft();
      return;
    }
    const gateway = this.addressedGateway();
    if (gateway?.refreshModels === undefined) {
      return;
    }
    await this.guard(() => gateway.refreshModels!());
  }

  /**
   * Re-reads the modes the selected engine offers. A draft re-probes its whole
   * catalog (the mode list came from there); a warm session asks its own gateway
   * and drops a pick that the new list no longer offers.
   */
  private async refreshModes(): Promise<void> {
    if (this.isDraft) {
      this.options.services.registry.refreshDraftDefaults();
      await this.warmDraft();
      if (
        this.draftMode !== undefined &&
        !(this.draftCatalog?.availableModes ?? []).some((mode) => mode.id === this.draftMode)
      ) {
        this.draftMode = undefined;
        this.emitState();
      }
      return;
    }
    const gateway = this.addressedGateway();
    if (gateway?.refreshModes === undefined) {
      return;
    }
    await this.guard(() => gateway.refreshModes!());
    this.emitState();
  }

  private async runHostCommand(
    command: string,
    args: Record<string, unknown> | undefined,
    requestId?: string,
  ): Promise<void> {
    // Session search is answered here, not by the host's own command handler:
    // the registry (and so the whole catalog) lives in this controller, and the
    // result must respect the host's scope. Routing it through every host would
    // duplicate the scope filter in each one.
    if (command === 'searchSessions') {
      const query = typeof args?.query === 'string' ? args.query : '';
      const limit = typeof args?.limit === 'number' ? args.limit : undefined;
      const sessions = await this.options.services.registry
        .searchSessions(query, limit)
        .catch((error: unknown) => {
          this.options.logger.warn(`Session search failed: ${describeError(error)}`, error);
          return [];
        });
      const scoped = sessions.filter((session) => this.withinScope(session.cwd));
      this.answerHostCommand(requestId, true, { sessions: scoped });
      return;
    }
    const handler = this.options.onHostCommand;
    if (!handler) {
      this.options.emit(
        noticeMessage('warn', `This host does not support "${command}".`, Date.now()),
      );
      this.answerHostCommand(
        requestId,
        false,
        undefined,
        `This host does not support "${command}".`,
      );
      return;
    }
    // A host command answers a surface that asked for a value — the folder a user
    // is typing, a file being previewed, a working tree on a timer. Its failure
    // belongs to that caller (it receives `ok: false`) and to the log; it is not
    // conversation content. Appending it here is what filled the transcript with a
    // red "scandir" row for every unfinished or wrong path the folder browser was
    // asked about, and for every poll of a directory that had gone away. `guard`
    // stays for the session/agent commands, whose failure *is* the panel's news.
    let value: unknown;
    try {
      value = await handler(command, args, {
        cwd: this.currentState().workspace.cwd,
      });
    } catch (error: unknown) {
      this.options.logger.error(`Morse command failed: ${describeError(error)}`, error);
      this.answerHostCommand(requestId, false, undefined, `"${command}" failed`);
      return;
    }
    this.answerHostCommand(requestId, true, value);
  }

  /** Replies to a host command the frontend asked a value for. */
  private answerHostCommand(
    requestId: string | undefined,
    ok: boolean,
    data?: unknown,
    error?: string,
  ): void {
    if (!requestId) {
      return;
    }
    this.options.emit({
      type: 'host/command/result',
      payload: { requestId, ok, data, error },
    });
  }

  private async onTaggedEvent(sessionKey: string, event: AgentEvent): Promise<void> {
    // A scheduled compaction waits for exactly this moment — the run and its
    // queued follow-ups settling — so it is checked before the split below: a
    // background conversation schedules (and settles) the same way as one in
    // front. It never blocks this dispatch: a compaction is a model call.
    if (event.type === 'agent/run-end' && this.scheduledCompacts.has(sessionKey)) {
      void this.runScheduledCompact(sessionKey);
    }
    // A dialog can arrive in any live session, not only the one in front. It is
    // tracked per session either way; only the active session's owns this
    // client's single dialog slot (see `syncInteraction`).
    if (event.type === 'agent/interaction') {
      await this.handleInteraction(sessionKey, event.request);
      return;
    }
    if (sessionKey !== this.activeKey) {
      // Keep inactive sessions' transcripts warm without streaming them, and
      // still report their activity: that is what makes several sessions show
      // as working at once in the navigator.
      if (event.type !== 'agent/ready' && event.type !== 'agent/state') {
        this.options.transcripts.apply(sessionKey, event);
        if (event.type === 'agent/run-end') {
          void this.publishSessions();
        }
      } else {
        this.publishActivity();
      }
      return;
    }

    switch (event.type) {
      case 'agent/ready':
        this.agentReady = true;
        this.clearAgentFailure();
        this.emitState();
        return;
      case 'agent/state':
        this.emitState();
        return;
      case 'agent/run-end':
        this.options.transcripts.apply(sessionKey, event);
        // An engine persists and names a session at its first user message (pi
        // writes the session file then, and the catalog derives the title from
        // that text), so a finished run is the moment to replace the placeholder
        // "New session" in the navigator.
        void this.publishSessions();
        return;
      case 'agent/fatal':
        this.agentReady = false;
        this.agentError = event.message;
        // A process that died carries no code the frontend could act on, but the
        // host still knows where to look: keep the hint, drop any stale code.
        this.agentFailure = hintOnly(this.options.agentHint);
        // Through the projector (not `transcripts.error`) so the error row is
        // guarded by the store's per-event identity: every connection reacts to
        // the same fatal event, and only the first must write it.
        this.options.transcripts.apply(sessionKey, event);
        this.emitState();
        return;
      default:
        this.options.transcripts.apply(sessionKey, event);
    }
  }

  /**
   * One compaction, wherever the ask came from: the dialog's yes, or a schedule
   * firing at the settle.
   *
   * Compaction is part of the process, not a side note: like a run, it lights the
   * composer's Working indicator (spinner, elapsed chip, Stop button) for the
   * conversation it runs in. Tracked per session — the flag this used to share
   * with a session switch is why switching tabs mid-compaction cleared the
   * indicator and left the run invisible. Reset in `finally` — a failed
   * compaction must hand the composer back, not wedge it on "Working".
   *
   * `requestedKey` is the conversation the ask was pinned to; without it the
   * session in front is the target.
   */
  private async runCompact(instructions?: string, requestedKey?: string): Promise<void> {
    const targetKey =
      requestedKey ?? this.promptTarget() ?? this.options.services.registry.activeKeyOf();
    if (targetKey !== undefined) {
      this.compacting.add(targetKey);
    }
    this.emitState();
    try {
      await this.guard(() =>
        this.options.services.chat.compact(instructions, requestedKey ?? this.promptTarget()),
      );
    } finally {
      if (targetKey !== undefined) {
        this.compacting.delete(targetKey);
      }
      this.emitState();
    }
  }

  /**
   * Runs a compaction the reader scheduled while this conversation was working.
   *
   * pi compacts by aborting, so a prompt landing between the settle and this call
   * would be cut short: a session that is streaming again keeps its schedule for
   * the next settle rather than losing it — or the run it would have aborted.
   */
  private async runScheduledCompact(sessionKey: string): Promise<void> {
    if (!this.scheduledCompacts.has(sessionKey)) {
      return;
    }
    if (this.options.services.registry.stateOf(sessionKey)?.streaming === true) {
      return;
    }
    const instructions = this.scheduledCompacts.get(sessionKey);
    this.scheduledCompacts.delete(sessionKey);
    await this.runCompact(instructions, sessionKey);
  }

  private async handleInteraction(
    sessionKey: string,
    request: AgentInteractionRequest,
  ): Promise<void> {
    const dialogs = this.options.dialogs;
    // A form is multi-field: a QuickPick/InputBox cannot render it, so it always
    // goes to the frontend, even in a host that answers every other kind
    // natively. Those other kinds keep their native path below.
    if (!dialogs || request.kind === 'form') {
      this.pendingInteractions.set(request.requestId, { sessionKey, request });
      this.syncInteraction();
      this.publishActivity();
      return;
    }
    // A host with native dialogs (VS Code QuickPick/InputBox) answers directly,
    // and the answer goes back to the session that asked.
    const response = await this.askNatively(dialogs, request);
    await this.respondToInteraction(response, sessionKey);
  }

  /** The pending dialog the active session owns, if any. */
  private pendingFor(sessionKey: string | undefined): AgentInteractionRequest | undefined {
    if (sessionKey === undefined) {
      return undefined;
    }
    for (const entry of this.pendingInteractions.values()) {
      if (entry.sessionKey === sessionKey) {
        return entry.request;
      }
    }
    return undefined;
  }

  /**
   * Points this client's single dialog slot at the active session. Switching
   * tabs swaps the dialog with the tab: the one that was shown is dismissed and
   * the new session's pending request (if it has one) is emitted, so a background
   * conversation never answers a dialog that belongs to another session.
   */
  private syncInteraction(): void {
    const next = this.pendingFor(this.activeKey);
    const nextId = next?.requestId;
    if (this.shownInteractionId !== undefined && this.shownInteractionId !== nextId) {
      this.options.emit({
        type: 'interaction/dismiss',
        payload: { requestId: this.shownInteractionId },
      });
      this.shownInteractionId = undefined;
    }
    if (next && this.shownInteractionId !== nextId) {
      this.options.emit({
        type: 'interaction/request',
        payload: toInteractionRequest(next),
      });
      this.shownInteractionId = nextId;
    }
  }

  private async askNatively(
    dialogs: NativeDialogs,
    request: AgentInteractionRequest,
  ): Promise<AgentInteractionResponse> {
    switch (request.kind) {
      case 'select': {
        const value = await dialogs.select(request);
        return value === undefined
          ? { requestId: request.requestId, cancelled: true }
          : { requestId: request.requestId, value };
      }
      case 'confirm':
        return {
          requestId: request.requestId,
          confirmed: await dialogs.confirm(request),
        };
      case 'input': {
        const value = await dialogs.input(request);
        return value === undefined
          ? { requestId: request.requestId, cancelled: true }
          : { requestId: request.requestId, value };
      }
      case 'editor': {
        const value = await dialogs.editor(request);
        return value === undefined
          ? { requestId: request.requestId, cancelled: true }
          : { requestId: request.requestId, value };
      }
      case 'form':
        // Unreachable: a form is queued for the frontend above. A native-dialog
        // host that somehow gets here cancels rather than guessing an answer.
        return { requestId: request.requestId, cancelled: true };
    }
  }

  private async publishLists(): Promise<void> {
    // `publishSessions` also refreshes the project list: both are derived from
    // the same catalog, and the navigator needs both to place a session in a
    // group.
    await this.publishSessions();
  }

  /**
   * Projects are derived from sessions, so the caller can hand in the list it
   * just built instead of making the registry read the catalog again. That also
   * lets a brand-new project show up before pi has persisted its first session.
   */
  private async publishProjects(sessions?: readonly SessionSummary[]): Promise<void> {
    const result = await this.guard(() => this.options.services.registry.listProjects(sessions));
    if (result.ok) {
      // A workspace-scoped host only ever shows the folders it has open.
      const projects = result.value.filter((project) => this.withinScope(project.path));
      this.options.emit({ type: 'project/list', payload: { projects } });
    }
  }

  /**
   * Publishes sessions. Without `request.cwd` it is the first page of every
   * project plus the project list; with `request.cwd` it is that one project's
   * next page, merged by the frontend into what it already shows.
   */
  private async publishSessions(request: { cwd?: string } = {}): Promise<void> {
    if (request.cwd !== undefined) {
      await this.publishSessionPage(request.cwd);
      return;
    }
    const result = await this.guard(() => this.options.services.registry.listSessions());
    if (result.ok) {
      const sessions = result.value.filter((session) => this.withinScope(session.cwd));
      // A full republish must not collapse the pages a reader has already loaded:
      // for each project with more than its first page revealed, send that whole
      // revealed range back. The list is authoritative (deletions prune), so the
      // reducer still replaces — it just replaces with everything that was shown.
      const expanded = await this.revealedPages(sessions);
      for (const extra of expanded) {
        sessions.push(...extra);
      }
      // The client now holds page 1 plus whatever pages it had revealed, so that
      // is the offset "Load more" must resume from. A project the reader has not
      // paged starts (and stays) at its first-page count.
      const pageCounts = new Map<string, number>();
      for (const session of result.value.filter((session) => this.withinScope(session.cwd))) {
        pageCounts.set(session.cwd, (pageCounts.get(session.cwd) ?? 0) + 1);
      }
      for (const [cwd, count] of pageCounts) {
        if ((this.sessionOffsets.get(cwd) ?? 0) < count) {
          this.sessionOffsets.set(cwd, count);
        }
      }
      const known = new Set(sessions.map((session) => session.id));
      // A session the engine has not persisted yet is invisible in the index, so
      // the list would be missing the very session the user just created. Fold
      // the live ones in (id = registry key, which is the Morse-derived id) so
      // the list always matches reality.
      for (const key of this.options.services.registry.hotKeys()) {
        if (known.has(key)) {
          continue;
        }
        const state = this.options.services.registry.stateOf(key);
        const cwd = state?.workspace.cwd ?? this.options.services.registry.defaultWorkspace.cwd;
        if (!this.withinScope(cwd)) {
          continue;
        }
        sessions.push({
          id: key,
          title: state?.sessionTitle ?? this.derivedTitle(key) ?? UNTITLED_SESSION,
          cwd,
          updatedAt: Date.now(),
          messageCount: 0,
        });
      }
      this.summaries = new Map(sessions.map((session) => [session.id, session]));
      const hasMoreByProject = await this.projectHasMore(sessions);
      this.options.emit({
        type: 'session/list',
        payload: { sessions, hasMoreByProject },
      });
      // A session change is a project change (cwd, count, last-used), and the
      // navigator builds its groups from `project/list`. Without this the group
      // for a new project — and every session inside a project missing from the
      // last list — stayed invisible until a manual refresh.
      await this.publishProjects(sessions);
    }
  }

  /**
   * The sessions of projects a reader has paged past their first page, so a full
   * republish can send them again instead of snapping the list back to page one.
   * The newest page-1 sessions are already in the list; only the older ones that
   * were revealed are fetched.
   */
  private async revealedPages(firstPage: readonly SessionSummary[]): Promise<SessionSummary[][]> {
    const shown = new Map<string, number>();
    for (const session of firstPage) {
      shown.set(session.cwd, (shown.get(session.cwd) ?? 0) + 1);
    }
    const extra: SessionSummary[][] = [];
    for (const [cwd, revealed] of this.sessionOffsets) {
      const have = shown.get(cwd) ?? 0;
      if (revealed <= have || !this.withinScope(cwd)) {
        continue;
      }
      const result = await this.guard(() =>
        this.options.services.registry.listSessionPage({
          cwd,
          offset: have,
          limit: revealed - have,
        }),
      );
      if (result.ok) {
        extra.push(result.value.sessions.filter((session) => this.withinScope(session.cwd)));
      }
    }
    return extra;
  }

  /**
   * One project's next page, answering the sidebar's "Load more". The live
   * sessions of that project are folded in too, since an unpersisted session is
   * missing from the catalog and belongs at the top of its own project.
   */
  private async publishSessionPage(cwd: string): Promise<void> {
    if (!this.withinScope(cwd)) {
      this.options.emit({
        type: 'session/list',
        payload: { sessions: [], hasMore: false, cwd },
      });
      return;
    }
    const offset = this.sessionOffsets.get(cwd) ?? 0;
    const result = await this.guard(() =>
      this.options.services.registry.listSessionPage({ cwd, offset }),
    );
    if (!result.ok) {
      return;
    }
    const sessions = result.value.sessions.filter((session) => this.withinScope(session.cwd));
    this.sessionOffsets.set(cwd, offset + sessions.length);
    const known = new Set(sessions.map((session) => session.id));
    // A hot session is only added on the first page; a later page must not repeat
    // it (the frontend merges by id, but the count it pages by would drift).
    if (offset === 0) {
      for (const key of this.options.services.registry.hotKeys()) {
        if (known.has(key)) {
          continue;
        }
        const state = this.options.services.registry.stateOf(key);
        const sessionCwd =
          state?.workspace.cwd ?? this.options.services.registry.defaultWorkspace.cwd;
        if (sessionCwd !== cwd) {
          continue;
        }
        sessions.push({
          id: key,
          title: state?.sessionTitle ?? this.derivedTitle(key) ?? UNTITLED_SESSION,
          cwd: sessionCwd,
          updatedAt: Date.now(),
          messageCount: 0,
        });
      }
    }
    for (const session of sessions) {
      this.summaries.set(session.id, session);
    }
    this.options.emit({
      type: 'session/list',
      payload: { sessions, hasMore: result.value.hasMore, cwd },
    });
  }

  /**
   * Which projects hold more sessions than the first page delivered. The true
   * counts come from the catalog's directory listing; a project whose count is
   * above what was published (or which the catalog cannot count) is offered a
   * "Load more" row by the sidebar.
   */
  private async projectHasMore(
    sessions: readonly SessionSummary[],
  ): Promise<Record<string, boolean>> {
    const counts = await this.options.services.registry.sessionCounts();
    const shown = new Map<string, number>();
    for (const session of sessions) {
      shown.set(session.cwd, (shown.get(session.cwd) ?? 0) + 1);
    }
    const hasMore: Record<string, boolean> = {};
    for (const [cwd, total] of counts) {
      if (this.withinScope(cwd)) {
        hasMore[cwd] = total > (shown.get(cwd) ?? 0);
      }
    }
    return hasMore;
  }

  /**
   * Title for a session the engine has not persisted yet. An engine may name a
   * session only once something asks it to, and until its storage exists no
   * report can derive a title either — so derive it from the first user message
   * here, the same way a catalog does. A session must not stay "New session"
   * once the user has said something.
   */
  private derivedTitle(key: string): string | undefined {
    for (const item of this.options.transcripts.items(key)) {
      if (item.kind !== 'user' || item.text.trim().length === 0) {
        continue;
      }
      const single = item.text.replace(/\s+/g, ' ').trim();
      return single.length > 72 ? `${single.slice(0, 72)}…` : single;
    }
    return undefined;
  }

  private emitReady(): void {
    this.hostReadyEmitted = true;
    this.options.emit({
      type: 'transcript/replace',
      payload: {
        items: this.activeKey ? this.options.transcripts.items(this.activeKey) : [],
      },
    });
    this.options.emit({
      type: 'host/ready',
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: this.options.capabilities,
        state: this.currentState(),
        frontend: this.options.frontend,
      },
    });
    this.publishActivity();
  }

  private emitTranscript(key: string): void {
    this.options.emit({
      type: 'transcript/replace',
      payload: { items: this.options.transcripts.items(key) },
    });
  }

  private emitState(): void {
    this.options.emit({ type: 'session/state', payload: this.currentState() });
    this.publishActivity();
  }

  /**
   * Reports every live session (hot process), not only the selected one. The
   * navigator marks the ones the agent is actively working in, so two parallel
   * conversations both read as running instead of one silently taking over.
   */
  private publishActivity(): void {
    const sessions: SessionActivity[] = this.options.services.registry.hotKeys().map((key) => {
      const state = this.options.services.registry.stateOf(key);
      const isActive = key === this.viewKey();
      const needsInput = this.pendingFor(key) !== undefined;
      return {
        sessionKey: key,
        streaming: state?.streaming ?? false,
        busy: (isActive && this.switchBusy) || this.compacting.has(key),
        agentReady: isActive ? this.agentReady : state !== undefined,
        agentStarting: isActive ? this.agentStarting : false,
        needsInput,
        ...(isActive && this.agentError !== undefined ? { agentError: this.agentError } : {}),
      };
    });
    this.options.emit({ type: 'session/activity', payload: { sessions } });
  }

  /**
   * The session the view describes: the target of a switch while one is in
   * flight, the adopted one otherwise.
   */
  private viewKey(): string | undefined {
    return this.pendingKey ?? this.activeKey;
  }

  /** Working in the view: a switch under way, or this view's session compacting. */
  private isBusy(): boolean {
    const key = this.viewKey();
    return this.switchBusy || (key !== undefined && this.compacting.has(key));
  }

  private currentState(): SessionViewState {
    const meta = {
      agentReady: this.agentReady,
      agentStarting: this.agentStarting,
      agentError: this.agentError,
      agentFailure: this.agentFailure,
      busy: this.isBusy(),
      hasOlderHistory: this.hasOlderHistory,
      loadingOlderHistory: this.loadingOlderHistory,
      loadingThinkingLevels: this.loadingThinkingLevels,
      loadingEngine: this.loadingEngine,
    };
    const key = this.viewKey();
    const state = key === undefined ? undefined : this.options.services.registry.stateOf(key);
    if (state) {
      // The engine comes from the live gateway, never from the draft's choice:
      // a session keeps the engine it was created in.
      const view = toSessionViewState(
        state,
        meta,
        key === undefined ? undefined : this.options.services.registry.engineOf(key),
      );
      // pi names a session only when it emits `session_name`, so a *resumed*
      // session arrives without one — and the panel then falls back to the
      // workspace name for a title it already knows. The catalog is the
      // authority (it is what the sidebar lists); a session still on the
      // placeholder takes its title from its first prompt instead.
      if (view.sessionTitle === undefined && key !== undefined) {
        const catalog = this.summaries.get(key)?.title;
        view.sessionTitle =
          catalog !== undefined && catalog !== UNTITLED_SESSION ? catalog : this.derivedTitle(key);
      }
      return view;
    }
    // The autoOpen:false draft: a truthful workspace line, and — once the
    // session-less probe lands — pickers that work before any session exists.
    // This fallback is also used while a session switch is heading for a key
    // whose state has not arrived: `isDraft` keeps the engine choice hidden in
    // that gap instead of flashing a draft under a running conversation.
    const view = draftSessionViewState(
      this.draftWorkspace ?? this.options.services.registry.defaultWorkspace,
      meta,
      {
        ...(this.draftCatalog === undefined ? {} : { catalog: this.draftCatalog }),
        ...(this.draftEngine === undefined ? {} : { engine: this.draftEngine }),
        ...(this.draftMode === undefined ? {} : { mode: this.draftMode }),
        ...(this.draftModel === undefined ? {} : { model: this.draftModel }),
        ...(this.draftThinking === undefined ? {} : { thinking: this.draftThinking }),
      },
    );
    // Before any session key exists this is the initial handshake, which is a
    // draft; a pending key with no state yet is a switch and must not look like
    // one.
    view.draft = this.isDraft || this.viewKey() === undefined;
    return view;
  }

  private fail(message: string, detail?: string): void {
    const key = this.activeKey;
    if (key !== undefined) {
      this.options.transcripts.error(key, message, detail);
      return;
    }
    // No transcript to attach to (draft): say it as a notice. The wire `error`
    // stays reserved for a refusing handshake — reusing it here raised the
    // frontend's "Offline — the host wouldn't take this frontend" banner, whose
    // Reload button then wiped the panel for an error that never touched the
    // connection. A spawn failure additionally sets `agentError`, which shows
    // the banner that actually fits.
    this.options.emit(
      noticeMessage('error', detail ? `${message}\n${detail}` : message, Date.now()),
    );
  }

  /** Transient error for the client (banner), never a transcript item. */
  private emitWireError(message: string, detail?: string): void {
    this.options.emit({
      type: 'error',
      payload: { message, detail, at: Date.now() },
    });
    this.options.emit(
      noticeMessage('error', detail ? `${message}\n${detail}` : message, Date.now()),
    );
  }

  private async guard<T>(action: () => Promise<T>): Promise<Guarded<T>> {
    try {
      return { ok: true, value: await action() };
    } catch (error: unknown) {
      const message = describeError(error);
      this.options.logger.error(`Morse command failed: ${message}`, error);
      this.fail(message);
      return { ok: false };
    }
  }
}

function workspaceOf(path: string): WorkspaceRef {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return { cwd: path, name: parts.at(-1) ?? path };
}

function insideRoots(path: string, roots: string[]): boolean {
  return roots.some(
    (root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`),
  );
}

/** Domain history -> transcript items (presentation mapping stays in this layer). */
function historyItems(key: string, entries: AgentHistoryEntry[], page: number): TranscriptItem[] {
  return entries.map((entry, index): TranscriptItem => {
    const id = `${key}#history-${page}-${index}`;
    const at = entry.at ?? 0;
    if (entry.role === 'user') {
      return {
        kind: 'user',
        id,
        at,
        text: entry.text,
        ...(entry.images ? { images: entry.images } : {}),
        ...(entry.pins ? { pins: entry.pins } : {}),
      };
    }
    if (entry.role === 'tool') {
      return {
        kind: 'tool',
        id,
        at,
        name: entry.name,
        title: entry.title,
        status: entry.status,
        input: entry.input,
        output: entry.output,
        ...(entry.details !== undefined ? { details: entry.details } : {}),
        ...(entry.childSession !== undefined ? { child: entry.childSession } : {}),
      };
    }
    if (entry.role === 'compaction') {
      // A marker row, not a message: the transcript keeps every folded entry —
      // the divider says where the agent's context was reset, not where history
      // ends ("Start of conversation" belongs to the real beginning again).
      return {
        kind: 'compaction',
        id,
        at,
        summary: entry.summary,
        ...(entry.tokensBefore !== undefined ? { tokensBefore: entry.tokensBefore } : {}),
      };
    }
    return {
      kind: 'assistant',
      id,
      at,
      text: entry.text,
      thinking: entry.thinking ?? '',
      streaming: false,
      model: entry.model,
    };
  });
}

/**
 * Maps a transcript item to the fork entry pi knows.
 *
 * pi's `get_fork_messages` lists every user message with non-empty text — the
 * same messages the transcript shows as text or pins (an image-only message has
 * no text and is not forkable). Matching the same distance from the end keeps
 * the two lists aligned even when an older history page is still unloaded.
 */
function entryIdForEdit(
  items: TranscriptItem[],
  itemId: string,
  forkMessages: AgentForkMessage[],
): string | undefined {
  const forkable = items.filter(
    (item): item is UserTranscriptItem =>
      item.kind === 'user' && (item.text.trim().length > 0 || (item.pins?.length ?? 0) > 0),
  );
  const index = forkable.findIndex((item) => item.id === itemId);
  if (index === -1) {
    return undefined;
  }
  const position = forkMessages.length - 1 - (forkable.length - 1 - index);
  return position >= 0 ? forkMessages[position]?.entryId : undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** Terminal geometry the wire named: a positive integer, or the default. */
function clampGeometry(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

/** A terminal that could not open says why, the same way a command failure does. */
function describeTerminalError(error: unknown): string {
  return error instanceof MorseError ? error.message : describeError(error);
}

/**
 * The machine-readable half of a failed start. Only the codes a frontend has help
 * for cross the wire; everything else keeps its message and the host's hint — a
 * frontend that guessed would offer the wrong remedy.
 */
function describeAgentFailure(error: unknown, hint: string | undefined): AgentFailure | undefined {
  const code = agentErrorCode(error);
  const install = error instanceof AgentUnavailableError ? error.remedy?.install : undefined;
  const failure: AgentFailure = {
    ...(code ? { code } : {}),
    ...(install ? { install } : {}),
    ...(hint ? { hint } : {}),
  };
  return Object.keys(failure).length > 0 ? failure : undefined;
}

function agentErrorCode(error: unknown): AgentErrorCode | undefined {
  if (!(error instanceof MorseError)) {
    return undefined;
  }
  // `MorseError.code` is a plain string; only the two the UI can help with pass.
  return error.code === 'agent-unavailable' || error.code === 'agent-protocol'
    ? error.code
    : undefined;
}

/** The host's next step without a code: a dead process, not a resolution failure. */
function hintOnly(hint: string | undefined): AgentFailure | undefined {
  return hint ? { hint } : undefined;
}
