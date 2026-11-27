import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Knex } from 'knex';
import { join } from 'node:path';
import {
  AgentRouter,
  ChatService,
  ComposerHub,
  InteractionHub,
  ScopedBotPort,
  SessionRegistry,
  UnsupportedByHostError,
  bindTranscriptsToRegistry,
  type AgentExtras,
  type BotControllerPort,
  type BotEvent,
  type BotService,
  type MorseLogger,
  type TerminalBackend,
} from '@morse/system';
import type { PiRpcAdapter } from '@morse/integration-pi';
import {
  McpWatcher,
  parseMcpServerInput,
  parseMcpServerSpec,
  parsePromptTemplateInput,
  PI_INSTALL_COMMAND,
} from '@morse/integration-pi';
import { OPENCODE_INSTALL_COMMAND } from '@morse/integration-opencode';
import { ensureOsUser, ownOsHome } from '../os-users.js';
import {
  HostSessionController,
  SessionTranscriptStore,
  type HostCommandContext,
  type HostHandlerCommand,
  type HostSessionServices,
} from '@morse/system';
import type {
  AuthUser,
  DeclaredHostCapabilities,
  HostToClientMessage,
  UpdateHostResult,
  VsCodeHostCommand,
} from '@morse/protocol';
import type { MorseServerConfig } from '../../app/config.js';
import {
  MORSE_CONFIG,
  MORSE_DB,
  MORSE_LOGGER,
  MORSE_AGENT_ROUTER,
  MORSE_BOT_SERVICE,
  MORSE_PI_ADAPTER,
  MORSE_PROJECT_POLICY,
  MORSE_SESSION_REGISTRY,
  MORSE_TRANSCRIPT_STORE,
} from '../../app/tokens.js';
import { PgSessionStore } from '../../db/pg-store.js';
import { revokeUserTokens } from '../../db/tokens.js';
import { createUser, deleteUser, listUsers, setUserRole, updateUser } from '../../db/users.js';
import {
  describeError,
  mcpScope,
  stringArg,
} from '@morse/system';
import {
  gitPaths,
  isLoopback,
  promptScope,
  repoArg,
  resolveFixExtras,
  resolveMcpExtras,
  resolveProviderExtras,
  resolvePromptExtras,
} from './session-factory-helpers.js';
import { saveUpload } from '../uploads/upload-store.js';
import { browseDirectory } from '../workspace/directory-browser.js';
import { readWorkspaceFile } from '../workspace/file-store.js';
import {
  checkoutGit,
  commitGit,
  pullGit,
  pushGit,
  readCommitDiff,
  readCommitFiles,
  readGitBranches,
  readGitDiff,
  readGitLog,
  readGitStatus,
  readGitSync,
  stageGitPaths,
  unstageGitPaths,
} from '../workspace/git-log.js';
import { readGitRepos } from '../workspace/git-repos.js';
import { listProjectDirectory, workspaceFiles } from '../workspace/workspace-index.js';
import { searchWorkspace } from '../workspace/workspace-search.js';
import { readWorkbench, saveWorkbench, readDrafts, saveDrafts } from '@morse/system';
import { ServerProjectPolicy } from '../projects/project-policy.js';
import { ServerTerminalBackend } from '../terminal/terminal.service.js';
import { canSelfUpdate, performSelfUpdate } from '../self-update/self-update.js';

/**
 * Composition root for one client connection (clean-architecture R7): the only
 * place that knows the concrete pi adapter, the core services and the WebSocket
 * delivery. Wiring only — no business logic lives here.
 *
 * The session registry is shared by every connection, so sessions and projects
 * keep running while clients come and go.
 */
/**
 * Everything one login user (or the single user, when `multiuser` is off)
 * owns: their router over their store slice, their live processes, their
 * transcripts, their composer queue and their pending questions. Bundles are
 * built lazily and never shared — one user's sessions, drafts and queue are
 * unreachable from another user's connection.
 */
interface UserBundle {
  registry: SessionRegistry;
  transcripts: SessionTranscriptStore;
  chat: ChatService;
  composer: ComposerHub;
  interactions: InteractionHub;
  mcpWatch: McpWatcher | undefined;
  detachTranscripts: () => void;
  /** The project fence for this user: their workspace root when fenced. */
  policy: ServerProjectPolicy;
  /** The login role this bundle was built for; a role change rebuilds it. */
  role: AuthUser['role'];
  /**
   * This reader's lens over the shared bot service (Slack semantics: their
   * own DM rooms). Undefined with no bot service; the service itself on
   * single-user hosts.
   */
  botPort: BotControllerPort | undefined;
}

/** Who connected on a socket: the login user, or undefined on single-user hosts. */
export interface ClientIdentity {
  remoteAddress?: string;
  user?: AuthUser;
}

@Injectable()
export class MorseSessionFactory {
  private readonly mcpWatch: McpWatcher | undefined;
  private readonly extras: AgentExtras | undefined;
  /**
   * The bot feed each live connection subscribed to. Keyed by the controller it
   * serves, so the disconnect path can detach exactly that client's forwarding.
   */
  private readonly botFeeds = new Map<HostSessionController, () => void>();
  /** Each live connection's emitter, so host-wide state can reach every client. */
  private readonly connections = new Map<
    HostSessionController,
    { emit: (message: HostToClientMessage) => void; userId: string | undefined }
  >();
  /**
   * Per-user bundles (multi-user only). The key is the login user id; each
   * bundle owns that user's router (over their store slice), live processes,
   * transcripts, composer queue and pending questions. Built lazily on first
   * connection and kept for the host's lifetime — sessions keep running while
   * their owner is disconnected, exactly like the single-user registry does.
   */
  private readonly bundles = new Map<string, UserBundle>();
  /**
   * Login TUIs a host command staged, keyed by terminal id. The frontend only
   * sends `terminal/open` with that id; the command is injected host-side at open
   * time and never travels over the wire. One-shot: a restart cannot reuse it.
   */
  private readonly pendingTerminalCommands = new Map<
    string,
    { file: string; args: string[] }
  >();
  /** The engine each staged login TUI belongs to, for the exit broadcast. */
  private readonly providerLoginEngines = new Map<string, string>();
  /**
   * The queue and live draft state shared by every client: one owner, one
   * dispatcher, and a file under the host's own directory. Created here so it
   * keeps working while no client is connected.
   */
  private readonly composer: ComposerHub;
  /** One pending-question map for every browser connected to this host. */
  private readonly interactions = new InteractionHub();

  constructor(
    @Inject(MORSE_SESSION_REGISTRY) private readonly registry: SessionRegistry,
    @Inject(MORSE_TRANSCRIPT_STORE) private readonly transcripts: SessionTranscriptStore,
    @Inject(MORSE_PROJECT_POLICY) private readonly policy: ServerProjectPolicy,
    @Inject(MORSE_LOGGER) private readonly logger: MorseLogger,
    @Inject(MORSE_CONFIG) private readonly config: MorseServerConfig,
    @Inject(ServerTerminalBackend) private readonly terminal: ServerTerminalBackend | undefined,
    @Inject(MORSE_AGENT_ROUTER) private readonly router: AgentRouter,
    @Inject(MORSE_PI_ADAPTER) private readonly pi: PiRpcAdapter,
    @Inject(MORSE_DB) private readonly db: Knex | undefined,
    // Bot mode is optional at the composition root: only a host that provides the
    // service reports `capabilities.bot` and routes `bot/*`.
    @Optional() @Inject(MORSE_BOT_SERVICE) private readonly bot?: BotService,
  ) {
    // The default engine's administration, not pi's unconditionally: with
    // OpenCode selected as the new-session engine, this host has no MCP editor,
    // no prompt editor and no pi update notice to offer.
    this.extras = this.router.defaultExtras();
    // One watcher for the whole host: every connected client subscribes, so a
    // config edited in a terminal (or by another window) reaches all of them.
    // It polls nothing until a controller is subscribed, and it does not exist at
    // all when the engine keeps no MCP config to watch.
    const mcp = this.extras?.mcp;
    this.mcpWatch =
      mcp === undefined
        ? undefined
        : new McpWatcher({
            signature: (cwd) => mcp.configSignature(cwd),
            // The global file always; a project file only while one of its
            // sessions is warm — exactly when the indicator can show it.
            cwds: () =>
              this.registry
                .hotKeys()
                .map((key) => this.registry.stateOf(key)?.workspace.cwd ?? '')
                .filter((cwd) => cwd.length > 0),
          });

    this.composer = new ComposerHub({
      chat: new ChatService({ agent: this.registry, logger: this.logger }),
      transcripts: this.transcripts,
      registry: this.registry,
      dataDir: this.config.dataDir,
      logger: this.logger,
    });
    this.composer.subscribe((message) => {
      // Single-user: every connection is the same user. Multi-user never
      // reaches here with more than one user's connections — each bundle owns
      // its own composer and fans out with a user filter (see `bundleFor`).
      for (const entry of this.connections.values()) {
        entry.emit(message);
      }
    });
    // Bots address login humans by id: the service reads them through this
    // lens so it never imports the host's database layer.
    const directoryDb = this.db;
    if (this.bot !== undefined && directoryDb !== undefined) {
      this.bot.setUserDirectory({
        listUsers: async () =>
          (await listUsers(directoryDb)).map((user) => ({
            id: user.id,
            username: user.username,
            name: user.name ?? user.username,
          })),
      });
    }
  }

  /**
   * The bundle serving one login user: their router over their store slice,
   * their live processes, transcripts, composer queue and pending questions —
   * sharing only the engine adapters with every other bundle. Built once,
   * kept for the host's lifetime.
   */
  private bundleFor(user: AuthUser): UserBundle {
    const userId = user.id;
    const existing = this.bundles.get(userId);
    // A role change rebuilds the bundle: a demoted admin must lose the global
    // policy at once, not keep it until the host restarts.
    if (existing !== undefined && existing.role === user.role) {
      return existing;
    }
    if (existing !== undefined) {
      existing.detachTranscripts();
      void existing.registry.dispose().catch(() => undefined);
      this.bundles.delete(userId);
    }
    if (this.db === undefined) {
      throw new UnsupportedByHostError('Multi-user mode needs PostgreSQL, which is not connected.');
    }
    // Own workspace, own fence: when `MORSE_WORKSPACE_ROOT` is set every user
    // works under `<root>/<username>` (created on demand). Regular users are
    // narrowed to it, so sessions, terminals, git and the folder picker cannot
    // cross into another user's tree. Admins keep the global policy and may go
    // anywhere. Unset keeps the host's global workspace for everyone.
    const homed = this.config.workspaceRoot !== undefined;
    const admin = user.role === 'admin';
    const fenced = homed && !admin;
    const cwd = homed ? join(this.config.workspaceRoot as string, user.username) : this.config.workspace.cwd;
    if (homed) {
      mkdirSync(cwd, { recursive: true });
    }
    const workspace = homed ? { cwd, name: 'Your Workspaces' } : this.config.workspace;
    // Pre-OS-user accounts (or a recreated container over a kept volume) get
    // their Linux user and home ownership on first login; the password follows
    // on their next password set, since only that carries the plaintext.
    if (homed) {
      ensureOsUser(user.username, () => undefined);
      ownOsHome(user.username, cwd, (message) => this.logger.warn(message));
    }
    const policy = fenced ? new ServerProjectPolicy([cwd]) : this.policy;
    const userRouter = new AgentRouter({
      store: new PgSessionStore(this.db, userId),
      defaultWorkspace: workspace,
      logger: this.logger,
      // Shared engines must never adopt another user's harness sessions into
      // this user's index: rows appear only for sessions they opened.
      adoptUnknown: false,
    });
    for (const registration of this.router.registrations()) {
      userRouter.register(registration.engine, registration);
    }
    const registry = new SessionRegistry({
      factory: userRouter,
      catalog: userRouter,
      defaultWorkspace: workspace,
      logger: this.logger,
      engines: userRouter.registeredEngines(),
    });
    const transcripts = new SessionTranscriptStore();
    const detachTranscripts = bindTranscriptsToRegistry(registry, transcripts);
    const chat = new ChatService({ agent: registry, logger: this.logger });
    const dataDir = this.userDataDir(userId);
    const composer = new ComposerHub({
      chat,
      transcripts,
      registry,
      dataDir,
      logger: this.logger,
    });
    composer.subscribe((message) => {
      for (const entry of this.connections.values()) {
        if (entry.userId === userId) {
          entry.emit(message);
        }
      }
    });
    const mcp = userRouter.defaultExtras()?.mcp;
    const mcpWatch =
      mcp === undefined
        ? undefined
        : new McpWatcher({
            signature: (cwd) => mcp.configSignature(cwd),
            cwds: () =>
              registry
                .hotKeys()
                .map((key) => registry.stateOf(key)?.workspace.cwd ?? '')
                .filter((cwd) => cwd.length > 0),
          });
    const bundle: UserBundle = {
      registry,
      transcripts,
      chat,
      composer,
      interactions: new InteractionHub(),
      mcpWatch,
      detachTranscripts,
      policy,
      role: user.role,
      botPort: this.bot === undefined ? undefined : new ScopedBotPort(this.bot, user),
    };
    this.bundles.set(userId, bundle);
    return bundle;
  }

  /** Where one user's host-owned files (composer queue, workbench, drafts) live. */
  private userDataDir(userId: string): string {
    return join(this.config.dataDir, 'users', userId);
  }

  /**
   * The fence a regular login user lives behind in multi-user mode: their own
   * `<root>/<username>`. Admins have none (the global policy decides), and
   * without `MORSE_WORKSPACE_ROOT` nobody is fenced.
   */
  private fenceFor(user?: AuthUser | null): string | undefined {
    if (
      user === undefined || user === null || user.role === 'admin' ||
      this.config.workspaceRoot === undefined
    ) {
      return undefined;
    }
    return join(this.config.workspaceRoot, user.username);
  }

  /**
   * The host-owned file directory for a connection: the shared `<MORSE_HOME>`
   * on single-user hosts, that user's directory once `multiuser` is on.
   */
  private dataDirFor(userId: string | undefined): string {
    return userId === undefined ? this.config.dataDir : this.userDataDir(userId);
  }

  /**
   * Namespaces terminal ids per user, so one user's bottom panel can never
   * attach to (or close) another user's shell by id — and enforces that
   * user's fence, so a client-named cwd outside it never spawns. The shared
   * backend still owns the processes; this is only a per-connection lens.
   */
  private scopedTerminal(userId: string, policy: ServerProjectPolicy): TerminalBackend | undefined {
    const backend = this.terminal;
    if (backend === undefined) {
      return undefined;
    }
    const prefix = `${userId}:`;
    return {
      attach: (terminalId, options, sink) => {
        if (!policy.canOpen(options.cwd)) {
          throw new UnsupportedByHostError(
            `Morse is not allowed to run a terminal in ${options.cwd}.`,
          );
        }
        return backend.attach(prefix + terminalId, options, sink);
      },
      close: (terminalId) => backend.close(prefix + terminalId),
    };
  }

  /** Tears every per-user bundle down with the host: processes, transcripts, queues. */
  async disposeBundles(): Promise<void> {
    const bundles = [...this.bundles.values()];
    this.bundles.clear();
    await Promise.all(
      bundles.map(async (bundle) => {
        bundle.detachTranscripts();
        await bundle.registry.dispose();
      }),
    );
  }

  capabilities(): DeclaredHostCapabilities {
    return {
      hostKind: 'server',
      // The browser host is global: every project pi knows about.
      scope: 'global',
      // Every installed engine, so the draft can choose one. Labels are the
      // host's presentation, not a frontend hardcoding `pi`/`opencode`.
      engines: this.router.engineOptions(),
      // The same catalog as install steps, for the screen a machine with no
      // engine at all sees. Morse is only the interface, so it offers every
      // agent it can drive instead of blaming one of them.
      engineSetup: [
        {
          kind: 'pi',
          label: 'pi',
          install: PI_INSTALL_COMMAND,
          hint: 'Install the pi CLI and make sure it is on PATH, or start the server with MORSE_PI_PATH set.',
        },
        {
          kind: 'opencode',
          label: 'OpenCode',
          install: OPENCODE_INSTALL_COMMAND,
          hint: 'Install the OpenCode CLI so it is on PATH, or start the server with MORSE_OPENCODE_URL pointing at a running `opencode serve`.',
        },
      ],
      // A browser has no local editor to read, so there is nothing to pin.
      editorContext: false,
      // A browser page streams no editor state; VS Code does.
      selectionLive: false,
      // No QuickPick/InputBox here, so the frontend renders interactions.
      nativeDialogs: false,
      insertIntoEditor: false,
      revealFile: false,
      // The server can walk the active session's directory, so the composer's
      // `@` picker works here too — the same list VS Code offers for a workspace.
      filePicker: true,
      // A browser has no editor of its own, so this host reads files for the
      // frontend's Explorer and preview tabs. VS Code keeps its native ones.
      filePreview: true,
      // The same reasoning for history: VS Code has Source Control, so the
      // browser host is the one that answers `gitLog` for its own git panel.
      gitPanel: true,
      // And the same for search: VS Code has its own Search view, so the browser
      // host is the one that greps the project's files for the search panel
      // (`searchWorkspace`) — ripgrep where it is installed, the built-in walk
      // otherwise, which the answer's `engine` reports to the panel.
      searchPanel: true,
      // VS Code already has an integrated terminal; the browser host has none, so
      // the bottom panel's terminal is this host's when a PTY backend resolved.
      // A platform without a prebuilt PTY reports `false` and the client hides
      // the panel rather than offering a terminal that cannot start.
      terminal: this.terminal !== undefined,
      // The browser host restores the tabs, panel, terminals and half-written
      // prompts the reader left open, kept under `<MORSE_HOME>`. VS Code has its
      // own tab restoration and leaves this off.
      workbench: true,
      // A browser cannot hand a dragged file's path to pi, so the host takes the
      // bytes and writes them next to the session; the frontend then `@mentions`
      // the path it gets back.
      fileUpload: true,
      // The browser host has no workspace folder, so "New session" has to ask
      // which directory the agent should run in. The frontend opens its folder
      // modal; VS Code has a folder already and leaves this off.
      directoryPicker: true,
      // The engine can cut the conversation at a past prompt, so it can be edited.
      editMessage: true,
      // The same cut can branch a new session and hand the prompt back instead.
      forkMessage: true,
      // A finished run reaches the reader through the page's own Notification
      // API; VS Code asks its host to raise one instead.
      notify: false,
      // A browser page has no editor tab to pin a session into; its tab strip
      // is the surface, and VS Code's editor tabs are its own.
      sessionTabs: false,
      // A page served by this host may ask the registry for the latest release, so
      // the sidebar can say when a newer Morse is out. A host without it stays
      // quiet; this one is on unless `MORSE_UPDATE_CHECK=0` says otherwise.
      updateCheck: this.config.updateCheck,
      // The same notice covers the engine itself: the version this host runs, so
      // the frontend can compare it against the published one.
      piVersion: this.extras?.version?.(),
      // Managing MCP servers needs an engine with a config to edit. Commands
      // name their engine, so any engine with administration enables the
      // affordance; one without it refuses with a message instead of showing
      // another engine's servers.
      mcp: this.router
        .engineOptions()
        .some((option) => this.router.extrasFor(option.kind)?.mcp !== undefined),
      // Editing prompt templates needs an engine that keeps them. Commands name
      // their engine, so any engine with a prompts port enables the affordance.
      promptEditor: this.router
        .engineOptions()
        .some((option) => this.router.extrasFor(option.kind)?.prompts !== undefined),
      // Fix rewrites an engine's config file so a later edit can land. Only a
      // host whose engines expose it answers `configFix`; the frontend hides the
      // button elsewhere (VS Code refuses it) instead of offering a dead action.
      configFix: this.router
        .engineOptions()
        .some((option) => this.router.extrasFor(option.kind)?.fix !== undefined),
      // One-click self-update: only when the operator opted in
      // (`MORSE_SELF_UPDATE=1`). The frontend turns the footer's update notice into
      // a button when this is set; the command itself re-checks the install and
      // the caller's address before it runs anything.
      selfUpdate: this.config.selfUpdate,
      // Bot mode: only a host that actually holds a `BotService` can draw a
      // roster, so the flag follows the provider instead of being a constant.
      // The extension resolves none, which is how its UI hides the mode.
      bot: this.bot !== undefined,
      // Several devices share this host, so the composer's queue and the words
      // being typed belong to the host, not to whichever browser is in front.
      sharedComposer: true,
      // Sessions are scoped per login user (`morse config set multiuser
      // true`): login gates the socket and every bundle below is per user.
      // VS Code declares false and keeps its single-user behavior.
      multiuser: this.config.multiuser,
    };
  }

  createFor(
    emit: (message: HostToClientMessage) => void,
    client?: ClientIdentity,
  ): HostSessionController {
    const user = this.config.multiuser ? client?.user ?? null : null;
    if (this.config.multiuser && (user === null || this.db === undefined)) {
      throw new UnsupportedByHostError(
        user === null
          ? 'Login is required on this host.'
          : 'Multi-user mode needs PostgreSQL, which is not connected.',
      );
    }
    const userId = user?.id;
    // Multi-user: the caller's bundle (their router, processes, transcripts,
    // queue and questions). Single-user: the host singletons, as before.
    const bundle = user === null || user === undefined ? undefined : this.bundleFor(user);
    const mcpWatch = bundle?.mcpWatch ?? this.mcpWatch;
    // Single-user keeps the service itself (unscoped: everything visible).
    const botPort = bundle?.botPort ?? this.bot;
    const services: HostSessionServices = {
      registry: bundle?.registry ?? this.registry,
      chat: bundle?.chat ?? new ChatService({ agent: this.registry, logger: this.logger }),
      composer: bundle?.composer ?? this.composer,
      interactions: bundle?.interactions ?? this.interactions,
      ...(mcpWatch === undefined ? {} : { mcpWatch }),
    };

    const controller = new HostSessionController({
      services,
      capabilities: this.capabilities(),
      emit: (message) => {
        emit(message);
        // A provider login TUI just ended: its credential was written by the
        // engine, so refresh every client's providers and models. The map entry
        // carries the engine the TUI was staged for.
        if (message.type === 'terminal/exit' && message.payload.terminalId.startsWith('provider-')) {
          const engine = this.providerLoginEngines.get(message.payload.terminalId) ?? '';
          this.providerLoginEngines.delete(message.payload.terminalId);
          void this.broadcastProvidersChanged({ engine }, user);
        }
      },
      logger: this.logger,
      transcripts: bundle?.transcripts ?? this.transcripts,
      policy: bundle?.policy ?? this.policy,
      scope: { kind: 'global' },
      // Who this connection authenticated as (display only — the services
      // above are already scoped, so this carries no authority).
      ...(user === undefined ? {} : { user }),
      // The bundle this host serves, so the panel can name its own version.
      ...(this.config.frontend ? { frontend: this.config.frontend } : {}),
      // The registry outlives this connection on purpose.
      ownsRegistry: false,
      // A page load must not create a session; the first prompt opens one.
      autoOpen: false,
      // The caller's address rides along so `updateHost` can refuse anyone who is
      // not on this machine.
      onHostCommand: (command, args, context) =>
        this.runHostCommand(
          command,
          args,
          context,
          client?.remoteAddress,
          user,
          bundle?.policy ?? this.policy,
        ),
      // The bottom panel's shell, namespaced per user when `multiuser` is on.
      terminal: userId === undefined ? this.terminal : this.scopedTerminal(userId, bundle?.policy ?? this.policy),
      takeTerminalCommand: (terminalId) => {
        const command = this.pendingTerminalCommands.get(terminalId);
        this.pendingTerminalCommands.delete(terminalId);
        return command;
      },
      agentHint:
        'Install the pi CLI and make sure it is on PATH, or start the server with MORSE_PI_PATH set.',
      // Bot mode's commands, through this connection's lens when multi-user
      // (their own rooms), or the service itself on single-user hosts. The
      // same socket's `emit` also carries the service's events (see
      // `subscribeBot`).
      ...(botPort === undefined ? {} : { bot: botPort }),
    });
    if (this.bot !== undefined && botPort !== undefined) {
      this.botFeeds.set(
        controller,
        this.subscribeBot(this.bot, botPort, userId, emit),
      );
    }
    this.connections.set(controller, { emit, userId });
    return controller;
  }

  /**
   * Detaches one connection's bot feed. The gateway calls this on disconnect,
   * before the controller is disposed, so a closed socket stops receiving roster
   * and transcript events at once instead of being written to by a service it no
   * longer has.
   */
  release(controller: HostSessionController): void {
    this.botFeeds.get(controller)?.();
    this.botFeeds.delete(controller);
    this.connections.delete(controller);
  }

  /**
   * Forwards the shared bot service's events to one connection. The service is
   * host-wide, so every connected client sees the same roster, routing state and
   * transcript lines — a second window is a viewer, not a second owner.
   */
  private subscribeBot(
    bot: BotService,
    port: BotControllerPort,
    ownerId: string | undefined,
    emit: (message: HostToClientMessage) => void,
  ): () => void {
    // Slack semantics per connection: a reader only ever sees their own rooms.
    // Unscoped (single-user) passes everything through, as before.
    const visible = (conversationId: string): boolean =>
      ownerId === undefined || bot.ownerOf(conversationId) === ownerId;
    const shownAs = (conversationId: string): string =>
      port instanceof ScopedBotPort ? port.displayId(conversationId) : conversationId;
    return bot.subscribe((event: BotEvent) => {
      switch (event.type) {
        case 'roster':
          // The event names the change, not the new list: read it back so the
          // client gets one authoritative roster (scoped to their rooms).
          emit({ type: 'bot/roster', payload: port.roster() });
          return;
        case 'transcript':
          if (!visible(event.conversationId)) {
            return;
          }
          emit({
            type: 'bot/transcript',
            payload: {
              conversationId: shownAs(event.conversationId),
              entries: event.entries,
              replace: event.replace,
            },
          });
          return;
        case 'routing':
          if (!visible(event.conversationId)) {
            return;
          }
          emit({
            type: 'bot/routing',
            payload: { conversationId: shownAs(event.conversationId), state: event.state },
          });
          return;
        case 'usage': {
          const usage = event.usage;
          if (!visible(usage.conversationId)) {
            return;
          }
          emit({
            type: 'bot/usage',
            payload: { ...usage, conversationId: shownAs(usage.conversationId) },
          });
          return;
        }
      }
    });
  }

  /**
   * The host commands this host answers: browsing the filesystem for a project
   * folder, listing the active session's files — the flat index behind the
   * `@mention` picker, and one directory level at a time behind the Explorer's
   * lazy tree — and writing a browser upload down next to the session.
   *
   * `listDirectories` is read-only and may look anywhere the server can read;
   * the commands that touch a session are scoped to its cwd (which
   * `ProjectPolicy` already approved when the session was opened), never to a
   * path the client names.
   */
  private async runHostCommand(
    command: HostHandlerCommand,
    args: Record<string, unknown> | undefined,
    context?: HostCommandContext,
    remoteAddress?: string,
    user?: AuthUser | null,
    policy: ServerProjectPolicy = this.policy,
  ): Promise<unknown> {
    switch (command) {
      case 'listDirectories': {
        // Feeds the frontend's "New session" folder modal. Browsing is harmless,
        // but the chosen folder still has to pass the policy before a session
        // may run there, so the result says so (`canOpen`). A fenced regular
        // user never sees outside their own workspace: an outside path (or no
        // path) lists the fence, the shortcuts stay inside it, and the way up
        // stops at its root.
        const requested = typeof args?.path === 'string' ? args.path : undefined;
        const fence = this.fenceFor(user);
        const start =
          fence !== undefined && (requested === undefined || !policy.canOpen(requested))
            ? fence
            : requested;
        const listing = await browseDirectory(start, {
          roots: fence !== undefined ? [fence] : policy.allowList,
          defaultPath: fence ?? this.registry.defaultWorkspace.cwd,
        });
        const parent =
          fence !== undefined &&
          listing.parent !== undefined &&
          !policy.canOpen(listing.parent)
            ? undefined
            : listing.parent;
        const roots =
          fence === undefined
            ? listing.roots
            : listing.roots.filter((root) => policy.canOpen(root.path));
        return { ...listing, parent, roots, canOpen: policy.canOpen(listing.path) };
      }
      case 'readWorkbench': {
        // The shell layout the reader left behind. Read-only and host-scoped —
        // per user once `multiuser` is on — so it never consults the policy.
        return readWorkbench(this.dataDirFor(user?.id)) ?? null;
      }
      case 'saveWorkbench': {
        // The frontend owns the inner shape; the store guards version and size.
        return { ok: saveWorkbench(this.dataDirFor(user?.id), args) };
      }
      case 'readDrafts': {
        // The half-written prompts, keyed by tab. Same host-scoped file as the
        // layout, but its own file because a draft can carry inline images.
        return readDrafts(this.dataDirFor(user?.id)) ?? null;
      }
      case 'saveDrafts': {
        return { ok: saveDrafts(this.dataDirFor(user?.id), args) };
      }
      case 'listFiles': {
        const cwd = this.requireWritableCwd(context, policy);
        // There is no workspace folder here, so the list is the directory the
        // client is viewing (its session, or the draft it is about to open) —
        // exactly what pi resolves a mention against. `fresh` skips the index
        // cache: the Explorer polls, so a file added on disk has to appear.
        const files = await workspaceFiles(cwd, this.logger, { fresh: args?.fresh === true });
        return { files };
      }
      case 'listDir': {
        // The Explorer's lazy tree: the root level the pane draws first, then
        // one folder's level as it opens. One `readdir`, no index cap, so every
        // entry of the level is listed — ignored files and directories included,
        // which is what the flat index's `git ls-files` could not promise. A
        // directory deleted since the row was drawn answers `missing`, so the
        // tree can drop it instead of showing an empty ghost.
        const cwd = this.requireWritableCwd(context, policy);
        const path = typeof args?.path === 'string' ? args.path : '';
        return await listProjectDirectory(cwd, path);
      }
      case 'readFile': {
        // The Explorer and the preview tabs. `readWorkspaceFile` resolves the
        // path inside the session's directory and refuses anything that escapes.
        const cwd = this.commandCwd(context, args, policy);
        const path = typeof args?.path === 'string' ? args.path : '';
        if (path.length === 0) {
          throw new UnsupportedByHostError('readFile needs a "path" argument.');
        }
        return readWorkspaceFile(cwd, path);
      }
      case 'searchWorkspace': {
        // The search panel's grep over the project in view. `commandCwd` is
        // `readFile`'s rule — a restored preview tab names its own project —
        // and the engine validates the query and the patterns themselves.
        const cwd = this.commandCwd(context, args, policy);
        return searchWorkspace(cwd, {
          query: typeof args?.query === 'string' ? args.query : '',
          caseSensitive: typeof args?.caseSensitive === 'boolean' ? args.caseSensitive : undefined,
          include: args?.include,
          exclude: args?.exclude,
        });
      }
      case 'uploadFile': {
        const cwd = this.requireWritableCwd(context, policy);
        const saved = await saveUpload(cwd, args ?? {}, this.config.uploadDir);
        this.logger.info(`Upload stored: ${saved.path} (${saved.bytes} bytes)`);
        return saved;
      }
      case 'gitRepos': {
        // The repositories under the viewing project: its own, plus any nested
        // ones (submodules, separate checkouts). The panel lists one accordion
        // section per repository, the way VS Code's source-control view does.
        const cwd = this.requireWritableCwd(context, policy);
        return readGitRepos(cwd);
      }
      case 'gitLog': {
        // The git panel's history and graph. Like `readFile`, the repository is
        // the viewing session's directory, never a path the client names. `skip`
        // pages towards the root commit as the panel scrolls.
        const cwd = this.requireWritableCwd(context, policy);
        const max = typeof args?.max === 'number' ? args.max : undefined;
        const skip = typeof args?.skip === 'number' ? args.skip : undefined;
        const ref = typeof args?.ref === 'string' ? args.ref : undefined;
        return readGitLog(cwd, max, skip, repoArg(args), ref);
      }
      case 'gitStatus': {
        // The working tree's changes, for the Explorer's per-file badges. Polled
        // alongside `listFiles`, so the two always describe the same moment.
        const cwd = this.requireWritableCwd(context, policy);
        return readGitStatus(cwd, repoArg(args));
      }
      case 'gitDiff': {
        // One file's unified diff for the preview's diff modes. The path is
        // resolved inside the session's directory, exactly like `readFile`.
        const cwd = this.commandCwd(context, args, policy);
        const path = typeof args?.path === 'string' ? args.path : '';
        if (path.length === 0) {
          throw new UnsupportedByHostError('gitDiff needs a "path" argument.');
        }
        return readGitDiff(cwd, path, repoArg(args));
      }
      case 'gitStage': {
        // Staging writes the index of the viewing session's repository. Paths are
        // resolved inside it, exactly like `readFile`, and the answer is the
        // fresh working tree so the panel updates in one round trip.
        const cwd = this.requireWritableCwd(context, policy);
        return stageGitPaths(cwd, gitPaths(args), repoArg(args));
      }
      case 'gitUnstage': {
        const cwd = this.requireWritableCwd(context, policy);
        return unstageGitPaths(cwd, gitPaths(args), repoArg(args));
      }
      case 'gitCommitFiles': {
        // The graph's expandable row: the paths one commit touched. The hash is
        // client-named, so it is validated as a hex object id, never a ref.
        const cwd = this.requireWritableCwd(context, policy);
        const hash = typeof args?.hash === 'string' ? args.hash : '';
        return readCommitFiles(cwd, hash, repoArg(args));
      }
      case 'gitCommitDiff': {
        const cwd = this.commandCwd(context, args, policy);
        const hash = typeof args?.hash === 'string' ? args.hash : '';
        const path = typeof args?.path === 'string' ? args.path : '';
        if (path.length === 0) {
          throw new UnsupportedByHostError('gitCommitDiff needs a "path" argument.');
        }
        return readCommitDiff(cwd, hash, path, repoArg(args));
      }
      case 'gitSync': {
        // How far HEAD is from its upstream, for the panel's pull/push controls.
        const cwd = this.requireWritableCwd(context, policy);
        return readGitSync(cwd, repoArg(args));
      }
      case 'gitPull': {
        // Network commands: git runs with prompts disabled, so a missing
        // credential fails instead of blocking the host on stdin.
        const cwd = this.requireWritableCwd(context, policy);
        return pullGit(cwd, repoArg(args));
      }
      case 'gitPush': {
        const cwd = this.requireWritableCwd(context, policy);
        return pushGit(cwd, repoArg(args));
      }
      case 'gitCommit': {
        // Commits the staged changes. The message is client-named but passed as
        // a single argv element, never through a shell.
        const cwd = this.requireWritableCwd(context, policy);
        const message = typeof args?.message === 'string' ? args.message : '';
        const amend = args?.amend === true;
        return commitGit(cwd, message, repoArg(args), amend);
      }
      case 'gitBranches': {
        const cwd = this.requireWritableCwd(context, policy);
        return readGitBranches(cwd, repoArg(args));
      }
      case 'gitCheckout': {
        const cwd = this.requireWritableCwd(context, policy);
        const branch = typeof args?.branch === 'string' ? args.branch : '';
        return checkoutGit(cwd, branch, args?.create === true, repoArg(args));
      }
      case 'mcpStatus': {
        // The viewing session's MCP servers. `pi mcp list --json` connects every
        // enabled server, so a failure is reported as a value (the panel renders
        // it) rather than thrown — the panel has something to say either way.
        // `scope: 'global'` is the empty-session view: no project, so no session
        // is required and only the user's `mcp.json` is read.
        const cwd = args?.scope === 'global' ? undefined : this.requireWritableCwd(context, policy);
        const mcp = this.mcpFor(args);
        try {
          return await mcp.status(cwd, { probe: args?.probe === true });
        } catch (error: unknown) {
          return { servers: [], errors: [describeError(error)] };
        }
      }
      case 'mcpAdd': {
        const input = parseMcpServerInput(args);
        const cwd = input.scope === 'project' ? this.requireWritableCwd(context, policy) : undefined;
        return this.mcpFor(args).add(input, cwd);
      }
      case 'mcpInspect': {
        // Probing spawns the server, so its directory is policy-checked like a
        // session's. Nothing is written: this answers "would it work?" before
        // the reader commits an entry to `mcp.json`. With no project the probe
        // runs in the host's default workspace.
        const spec = parseMcpServerSpec(args);
        const cwd = this.optionalCwd(context, args, policy);
        if (spec.cwd === undefined && cwd.length > 0) {
          spec.cwd = cwd;
        }
        this.mcpFor(args);
        return this.pi.inspector.inspect(spec, {
          cwd: spec.cwd ?? this.registry.defaultWorkspace.cwd,
        });
      }
      case 'mcpRemove': {
        const scope = mcpScope(args);
        const cwd = scope === 'project' ? this.requireWritableCwd(context, policy) : undefined;
        return this.mcpFor(args).remove(stringArg(args, 'name'), cwd, scope);
      }
      case 'mcpSetEnabled': {
        const scope = mcpScope(args);
        const cwd = scope === 'project' ? this.requireWritableCwd(context, policy) : undefined;
        return this.mcpFor(args).setEnabled(
          stringArg(args, 'name'),
          args?.enabled === true,
          cwd,
          scope,
        );
      }
      case 'trustProject': {
        // Trusting loads the project's `.pi` resources for every future pi
        // process (mcp.json, settings, skills, prompts), the same decision pi's
        // own prompt writes. Nothing else about the project is touched.
        const cwd = this.requireWritableCwd(context, policy);
        return this.mcpFor(args).trustProject(cwd);
      }
      case 'promptTemplates': {
        // The user's prompts, plus this project's once it is trusted. No session
        // is required: with no directory, the user templates still list.
        return this.promptsFor(args).list(this.optionalCwd(context, args, policy));
      }
      case 'promptTemplateSave': {
        return this.promptsFor(args).save(
          parsePromptTemplateInput(args),
          this.optionalCwd(context, args, policy),
        );
      }
      case 'promptTemplateDelete': {
        return this.promptsFor(args).delete(
          stringArg(args, 'name'),
          promptScope(args),
          this.optionalCwd(context, args, policy),
          typeof args?.['source'] === 'string' ? args['source'] : undefined,
        );
      }
      case 'configFix': {
        // A config issue names its own file; the engine is the one that knows
        // whether that path is one of its configs, so the host checks only that
        // the request is complete and that the directory is allowed, then hands
        // the issue's `file` over as-is (never re-derived or normalised here).
        const fileId = stringArg(args, 'fileId');
        if (fileId.length === 0) {
          throw new UnsupportedByHostError('configFix needs a "fileId" argument.');
        }
        const path = stringArg(args, 'path');
        if (path.length === 0) {
          throw new UnsupportedByHostError('configFix needs a "path" argument.');
        }
        const scope =
          args?.scope === 'project' ? 'project' : args?.scope === 'global' ? 'global' : undefined;
        if (scope === undefined) {
          throw new UnsupportedByHostError('configFix needs a "scope" of "global" or "project".');
        }
        const cwd = this.fixCwd(context, args, scope, policy);
        return this.fixFor(args)({
          fileId,
          path,
          scope,
          ...(cwd === undefined ? {} : { cwd }),
        });
      }
      case 'providerStatus': {
        // The engine named by the command (or the default one) reads its own
        // auth/config files. No credential value comes back to the client.
        this.assertProviderAdmin(user);
        return this.providersFor(args).list();
      }
      case 'providerConnect': {
        this.assertProviderAdmin(user);
        const result = await this.providersFor(args).connect(args);
        // The engine's config just changed; tell every client on this host so
        // their provider page and model picker re-read without a refresh.
        await this.broadcastProvidersChanged(args, user);
        return result;
      }
      case 'providerDisconnect': {
        this.assertProviderAdmin(user);
        const result = await this.providersFor(args).disconnect(args);
        await this.broadcastProvidersChanged(args, user);
        return result;
      }
      case 'providerDiscover': {
        this.assertProviderAdmin(user);
        const discover = this.providersFor(args).discover;
        if (discover === undefined) {
          return { ok: false, message: 'This engine has no model discovery.' };
        }
        return discover(args);
      }
      case 'providerLogin': {
        this.assertProviderAdmin(user);
        // The engine's own login TUI signs providers in; its exit is broadcast
        // by the terminal close path (see onModuleDestroy / terminal/exit).
        return this.stageProviderLogin(args);
      }
      case 'adminUsers': {
        // Every login identity, newest last — the admin page's roster.
        // Password hashes never leave this host.
        return listUsers(this.requireAdminDb(user));
      }
      case 'adminCreateUser': {
        const db = this.requireAdminDb(user);
        const username = typeof args?.username === 'string' ? args.username : '';
        const password = typeof args?.password === 'string' ? args.password : '';
        const name = typeof args?.name === 'string' ? args.name : undefined;
        const email = typeof args?.email === 'string' ? args.email : undefined;
        const role = args?.role === 'admin' ? 'admin' : 'regular';
        try {
          const created = await createUser(db, { username, password, name, email, role });
          this.logger.info(`Admin ${user?.username} created user "${created.username}" (${created.role}).`);
          return {
            id: created.id,
            username: created.username,
            name: created.name,
            email: created.email,
            role: created.role,
            createdAt: created.createdAt,
          };
        } catch (error: unknown) {
          throw new UnsupportedByHostError(error instanceof Error ? error.message : 'Could not create the user.');
        }
      }
      case 'adminSetRole': {
        const db = this.requireAdminDb(user);
        const userId = typeof args?.userId === 'string' ? args.userId : '';
        const role = args?.role === 'admin' ? 'admin' : 'regular';
        if (userId.length === 0) {
          throw new UnsupportedByHostError('adminSetRole needs a "userId" argument.');
        }
        if (!(await setUserRole(db, userId, role))) {
          throw new UnsupportedByHostError('No such user.');
        }
        this.logger.info(`Admin ${user?.username} set ${userId} to ${role}.`);
        return { ok: true };
      }
      case 'adminUpdateUser': {
        const db = this.requireAdminDb(user);
        const userId = typeof args?.userId === 'string' ? args.userId : '';
        if (userId.length === 0) {
          throw new UnsupportedByHostError('adminUpdateUser needs a "userId" argument.');
        }
        const patch: {
          name?: string;
          email?: string;
          role?: 'admin' | 'regular';
          password?: string;
        } = {};
        if (typeof args?.name === 'string') {
          patch.name = args.name;
        }
        if (typeof args?.email === 'string') {
          patch.email = args.email;
        }
        if (args?.role === 'admin' || args?.role === 'regular') {
          patch.role = args.role;
        }
        if (typeof args?.password === 'string' && args.password.length > 0) {
          patch.password = args.password;
        }
        try {
          const updated = await updateUser(db, userId, patch);
          if (updated === undefined) {
            throw new UnsupportedByHostError('No such user.');
          }
          // A new password invalidates every session still held for that user.
          if (patch.password !== undefined) {
            await revokeUserTokens(db, userId);
          }
          this.logger.info(`Admin ${user?.username} updated user ${userId}.`);
          return updated;
        } catch (error: unknown) {
          throw new UnsupportedByHostError(error instanceof Error ? error.message : 'Could not update the user.');
        }
      }
      case 'adminDeleteUser': {
        const db = this.requireAdminDb(user);
        const userId = typeof args?.userId === 'string' ? args.userId : '';
        if (userId.length === 0) {
          throw new UnsupportedByHostError('adminDeleteUser needs a "userId" argument.');
        }
        if (userId === user?.id) {
          throw new UnsupportedByHostError('You cannot delete your own account.');
        }
        const result = await deleteUser(db, userId);
        if (!result.deleted) {
          throw new UnsupportedByHostError(result.reason ?? 'No such user.');
        }
        this.logger.info(`Admin ${user?.username} deleted user ${userId} (and their sessions).`);
        return { ok: true };
      }
      case 'updateHost': {
        return this.updateHost(remoteAddress);
      }
      default: {
        // Exhaustive by construction: the shared and browser-host surfaces are
        // named cases above, so `command` here is exactly `VsCodeHostCommand` —
        // the editor-integration surface (insert, reveal, session tabs, native
        // dialogs, notifications). The frontend asks only where the matching
        // capability is on, so this refusal is unreachable from this host's own
        // pages; naming the group keeps a future mis-route loud instead of
        // silent. A command added to `SharedHostCommand` or `ServerHostCommand`
        // without a case above fails THIS build — that is the never-forget
        // guarantee.
        const editorOnly: VsCodeHostCommand = command;
        throw new UnsupportedByHostError(
          `"${editorOnly}" is answered by the VS Code host, not the browser.`,
        );
      }
    }
  }

  /**
   * The multi-user database for admin commands. Refuses when the caller is not
   * an admin — the frontend gates the page on `role`, but this is the real
   * boundary, checked per command at the moment of the call.
   */
  /**
   * Provider credentials are host-wide, so in multi-user mode the UI's admin
   * gate is not enough: every provider command checks the caller too. A
   * single-user host has no roles and stays usable.
   */
  private assertProviderAdmin(user?: AuthUser | null): void {
    if (this.config.multiuser && user?.role !== 'admin') {
      throw new UnsupportedByHostError('Only an admin can manage provider sign-ins.');
    }
  }

  /**
   * A provider change is host-wide: credentials are per engine, shared by every
   * session on this machine. Re-read the draft catalog (what new sessions offer)
   * and every live session's model list, then tell every connected client to
   * refresh its provider page and model picker. No restart, no manual refresh.
   */
  private async broadcastProvidersChanged(
    args: Record<string, unknown> | undefined,
    user?: AuthUser | null,
  ): Promise<void> {
    const engine = typeof args?.['engine'] === 'string' ? args['engine'] : undefined;
    const registries = user === undefined || user === null
      ? [this.registry]
      : [...this.bundles.values()].map((bundle) => bundle.registry);
    for (const registry of registries) {
      registry.refreshDraftDefaults();
      await registry.refreshAllModels();
    }
    const message: HostToClientMessage = {
      type: 'providers/changed',
      payload: { engine: engine ?? '' },
    };
    for (const entry of this.connections.values()) {
      if (user === undefined || user === null || entry.userId === user.id) {
        entry.emit(message);
      }
    }
  }

  private requireAdminDb(user?: AuthUser | null): Knex {
    if (!this.config.multiuser || this.db === undefined) {
      throw new UnsupportedByHostError('User management needs multi-user mode.');
    }
    if (user?.role !== 'admin') {
      throw new UnsupportedByHostError('Only an admin can manage users.');
    }
    return this.db;
  }

  /**
   * Install a newer Morse and relaunch this host.
   *
   * Every gate is checked here, at the moment of the call, rather than trusted
   * from the capability the frontend saw at handshake time:
   *
   * - the operator opted in (`MORSE_SELF_UPDATE=1`),
   * - the caller is on this machine (the browser UI has no auth, so a `--lan`
   *   host must not expose a remote `npm install -g`),
   * - the running module is an npm-global install this user can rewrite.
   *
   * A refused request answers with `ok: false` and a reason; the frontend falls
   * back to the command it already prints in the hint.
   */
  private async updateHost(remoteAddress?: string): Promise<UpdateHostResult> {
    const from = this.config.frontend?.version ?? 'unknown';
    if (!this.config.selfUpdate) {
      return {
        ok: false,
        from,
        message:
          'This host was not started with MORSE_SELF_UPDATE=1. Run npm install -g @supanadit/morse-web@latest and restart it.',
      };
    }
    if (!isLoopback(remoteAddress)) {
      this.logger.warn(`Refused a self-update from ${remoteAddress ?? 'an unknown address'}`);
      return {
        ok: false,
        from,
        message: 'Self-update is only allowed from this machine.',
      };
    }
    if (!(await canSelfUpdate())) {
      return {
        ok: false,
        from,
        message:
          'This Morse is not a writable npm-global install, so it cannot replace itself. Run npm install -g @supanadit/morse-web@latest yourself.',
      };
    }
    return performSelfUpdate({
      dataDir: this.config.dataDir,
      currentVersion: from,
      logger: this.logger,
    });
  }

  /**
   * The MCP port of the engine the command names (`args.engine`), or the
   * default engine's when the client is older and names none. An engine that
   * has no MCP administration is a refusal — never another engine's config.
   */
  private mcpFor(args?: Record<string, unknown>): NonNullable<AgentExtras['mcp']> {
    return resolveMcpExtras(this.router, args?.['engine']);
  }

  /** The prompt port of the engine the command names, or the default engine's. */
  private promptsFor(args?: Record<string, unknown>): NonNullable<AgentExtras['prompts']> {
    return resolvePromptExtras(this.router, args?.['engine']);
  }

  /** The config-Fix port of the engine the command names, or the default engine's. */
  private fixFor(args?: Record<string, unknown>): NonNullable<AgentExtras['fix']> {
    return resolveFixExtras(this.router, args?.['engine']);
  }

  /**
   * Stage an engine's own login TUI under a terminal id and return that id. The
   * frontend opens a terminal pane with the id; the command is injected host-side
   * when that pane attaches, so a client can never name the program it runs.
   */
  private async stageProviderLogin(
    args: Record<string, unknown> | undefined,
  ): Promise<{ ok: boolean; terminalId?: string; message?: string }> {
    const providers = this.providersFor(args);
    if (providers.loginCommand === undefined) {
      return { ok: false, message: 'This engine has no TUI sign-in.' };
    }
    const login = await providers.loginCommand({ providerId: args?.['providerId'] });
    const data =
      typeof login === 'object' && login !== null && !Array.isArray(login)
        ? (login as Record<string, unknown>)
        : undefined;
    const file = typeof data?.['file'] === 'string' ? data['file'] : '';
    const rawArgs = Array.isArray(data?.['args']) ? data['args'] : [];
    if (
      file.length === 0 ||
      rawArgs.some((one) => typeof one !== 'string')
    ) {
      return { ok: false, message: 'This provider has no usable sign-in command.' };
    }
    const terminalId = `provider-${randomUUID()}`;
    this.pendingTerminalCommands.set(terminalId, { file, args: rawArgs as string[] });
    this.providerLoginEngines.set(
      terminalId,
      typeof args?.['engine'] === 'string' ? args['engine'] : '',
    );
    return { ok: true, terminalId };
  }

  /** The provider-sign-in port of the engine the command names, or the default engine's. */
  private providersFor(args?: Record<string, unknown>): NonNullable<AgentExtras['providers']> {
    return resolveProviderExtras(this.router, args?.['engine']);
  }

  /**
   * The directory a config fix resolves against. A project file is only
   * meaningful inside an allowed project, so that names one exactly as a session
   * would; a global file may be fixed with no project in front (the empty-session
   * view), and an explicit directory is policy-checked like every file command.
   */
  private fixCwd(
    context: HostCommandContext | undefined,
    args: Record<string, unknown> | undefined,
    scope: 'global' | 'project',
    policy: ServerProjectPolicy,
  ): string | undefined {
    if (scope === 'project') {
      return this.commandCwd(context, args, policy);
    }
    const requested = args?.['cwd'];
    if (typeof requested === 'string' && requested.length > 0) {
      if (!policy.canOpen(requested)) {
        throw new UnsupportedByHostError(`Morse is not allowed to work in ${requested}.`);
      }
      return requested;
    }
    const active = context?.cwd ?? this.activeCwd();
    return active !== undefined && active.length > 0 && policy.canOpen(active)
      ? active
      : undefined;
  }

  private requireWritableCwd(
    context: HostCommandContext | undefined,
    policy: ServerProjectPolicy,
  ): string {
    const cwd = context?.cwd ?? this.activeCwd();
    if (!cwd) {
      throw new UnsupportedByHostError('No active Morse session yet.');
    }
    if (!policy.canOpen(cwd)) {
      throw new UnsupportedByHostError(`Morse is not allowed to work in ${cwd}.`);
    }
    return cwd;
  }

  /**
   * The directory a file command works in. A restored preview tab carries the
   * project it was read from (`args.cwd`), because the host may still be on
   * another session when that tab is loaded; the policy checks it exactly like a
   * terminal's directory. Without one, the viewing session's directory is used.
   */
  private commandCwd(
    context: HostCommandContext | undefined,
    args: Record<string, unknown> | undefined,
    policy: ServerProjectPolicy,
  ): string {
    const requested = args?.cwd;
    if (typeof requested === 'string' && requested.length > 0) {
      if (!policy.canOpen(requested)) {
        throw new UnsupportedByHostError(`Morse is not allowed to work in ${requested}.`);
      }
      return requested;
    }
    return this.requireWritableCwd(context, policy);
  }

  /**
   * Like `commandCwd`, but an absent directory is not an error: `''` means "no
   * project", which the prompt editor uses to edit only the user templates.
   */
  private optionalCwd(
    context: HostCommandContext | undefined,
    args: Record<string, unknown> | undefined,
    policy: ServerProjectPolicy,
  ): string {
    // An explicit `cwd` is authoritative, even when empty: the editor sends `''`
    // for "no project in front", which must not fall back to a default workspace.
    if (args !== undefined && typeof args['cwd'] === 'string') {
      const requested = args['cwd'];
      return requested.length > 0 && policy.canOpen(requested) ? requested : '';
    }
    const active = context?.cwd ?? this.activeCwd();
    return active && policy.canOpen(active) ? active : '';
  }

  /** The cwd of the session this connection is showing. */
  private activeCwd(): string | undefined {
    const key = this.registry.activeKeyOf();
    const workspace = key === undefined ? undefined : this.registry.stateOf(key)?.workspace;
    return workspace?.cwd ?? this.registry.defaultWorkspace.cwd;
  }
}
