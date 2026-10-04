import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import {
  createInitialView,
  type ChatPin,
  type ComposerSeed,
  type HostCommand,
  type InteractionResponse,
  type PromptImage,
  type PromptMode,
  type SessionActivity,
  type SessionView,
  type ThinkingLevel,
} from '@morse/protocol';
import { createMorseClient, type MorseActions, type MorseClient } from '@morse/ui-runtime';
import { MORSE_TRANSPORT } from './transport.token';

/**
 * What this bundle calls itself in the handshake. The version a *host* reports
 * back (`view.frontend`) comes from `webview.manifest.json`, which is generated
 * from this package's manifest at build time — that is the authoritative one, and
 * the About dialog renders it. This literal only exists because the client has no
 * manifest to read at runtime, and `core/frontend-identity.spec.ts` fails when it
 * drifts from `package.json`.
 */
export const FRONTEND_IDENTITY = { name: '@morse/ui-angular', version: '0.9.0' };
const SLOW_CONNECTION_MS = 6_000;

/**
 * Thin Angular binding over the framework-free `MorseClient`.
 *
 * This is deliberately the ONLY place where Angular meets the wire protocol:
 * a React or Svelte frontend replaces this file and the components, while
 * `@morse/protocol` and `@morse/ui-runtime` stay exactly the same.
 */
@Injectable({ providedIn: 'root' })
export class MorseService {
  private readonly transport = inject(MORSE_TRANSPORT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly view = signal<SessionView>(createInitialView());
  private readonly client: MorseClient;
  private readonly actions: MorseActions;
  private slowConnectionTimer: ReturnType<typeof setTimeout> | undefined;

  readonly connection = computed(() => this.view().connection);
  readonly connectionDetail = computed(() => this.view().connectionDetail);
  /** The wire version the host and this bundle agreed on. */
  readonly protocolVersion = computed(() => this.view().protocolVersion);
  /**
   * Which frontend bundle this is, as the host read it from
   * `webview.manifest.json` — the only place that knows the real version.
   */
  readonly frontend = computed(() => this.view().frontend);
  /**
   * The build that is talking. The host's manifest is the authority, and a host
   * with no manifest to read (a bare dev directory) still gets an answer from the
   * constant compiled into this bundle — a version the UI can print either way.
   */
  readonly version = computed(() => this.frontend()?.version ?? FRONTEND_IDENTITY.version);
  /** True only once a connect attempt has been pending long enough to matter. */
  readonly slowConnection = signal(false);
  readonly capabilities = computed(() => this.view().capabilities);
  readonly state = computed(() => this.view().state);
  readonly items = computed(() => this.view().items);
  readonly projects = computed(() => this.view().projects);
  readonly sessions = computed(() => this.view().sessions);
  /** Every live agent session (not only the selected one). */
  readonly activity = computed(() => this.view().activity);
  /** The same activity keyed by session id, for the navigator's running marks. */
  readonly sessionActivity = computed(() => {
    const byKey = new Map<string, SessionActivity>();
    for (const entry of this.view().activity) {
      byKey.set(entry.sessionKey, entry);
    }
    return byKey;
  });
  readonly pendingInteraction = computed(() => this.view().pendingInteraction);
  readonly lastNotice = computed(() => this.view().lastNotice);
  readonly lastError = computed(() => this.view().lastError);
  readonly agentReady = computed(() => this.view().state.agentReady);
  readonly agentStarting = computed(() => this.view().state.agentStarting);
  readonly agentError = computed(() => this.view().state.agentError);
  /** What `agentError` means and what to do about it (see `AgentFailure`). */
  readonly agentFailure = computed(() => this.view().state.agentFailure);
  readonly running = computed(() => this.view().state.streaming || this.view().state.busy);
  readonly workspace = computed(() => this.view().state.workspace);
  readonly model = computed(() => this.view().state.model);
  readonly thinkingLevel = computed(() => this.view().state.thinkingLevel);
  readonly availableModels = computed(() => this.view().state.availableModels);
  readonly availableThinkingLevels = computed(() => this.view().state.availableThinkingLevels);
  /** Commands pi exposes (`get_commands`); the frontend merges its own built-ins. */
  readonly availableCommands = computed(() => this.view().state.availableCommands);
  readonly usage = computed(() => this.view().state.usage);
  /** True when older transcript entries can still be loaded. */
  readonly hasOlderHistory = computed(() => this.view().state.hasOlderHistory === true);
  /** True while the host is fetching the previous history page. */
  readonly loadingOlderHistory = computed(
    () => this.view().state.loadingOlderHistory === true,
  );

  constructor() {
    this.client = createMorseClient({ transport: this.transport, frontend: FRONTEND_IDENTITY });
    this.actions = this.client.actions;
    const initial = this.client.getView();
    this.view.set(initial);
    // The transport publishes its first status before anyone subscribes, so the
    // initial view must be fed to the tracker too.
    this.trackSlowConnection(initial.connection);
    this.client.subscribe((view) => {
      this.view.set(view);
      this.trackSlowConnection(view.connection);
    });
    this.destroyRef.onDestroy(() => {
      this.clearSlowConnectionTimer();
      this.client.dispose();
    });
  }

  /**
   * A silent hang (host accepts the socket but never answers the handshake) must
   * not look like a healthy idle UI. Reported only after a real delay, so a
   * normal fast handshake never flashes a warning.
   */
  private trackSlowConnection(connection: SessionView['connection']): void {
    if (connection !== 'connecting') {
      this.clearSlowConnectionTimer();
      this.slowConnection.set(false);
      return;
    }
    if (this.slowConnectionTimer === undefined) {
      this.slowConnectionTimer = setTimeout(() => {
        this.slowConnection.set(true);
      }, SLOW_CONNECTION_MS);
    }
  }

  private clearSlowConnectionTimer(): void {
    if (this.slowConnectionTimer !== undefined) {
      clearTimeout(this.slowConnectionTimer);
      this.slowConnectionTimer = undefined;
    }
  }

  prompt(text: string, mode: PromptMode = 'new', images?: PromptImage[], pins?: ChatPin[]): void {
    this.actions.prompt(text, mode, images, pins);
  }

  /** Replaces a past user message by forking the conversation before it. */
  editMessage(itemId: string, text: string): void {
    this.actions.editMessage(itemId, text);
  }

  /**
   * Branches a new session before a past user message. Nothing is sent; the
   * host hands the forked prompt back to the composer (`onComposerSeed`).
   */
  forkMessage(itemId: string): void {
    this.actions.forkMessage(itemId);
  }

  /**
   * A prompt a fork handed back: the composer drops it into the editor so the
   * user continues the new branch, optionally editing it first.
   */
  onComposerSeed(listener: (seed: ComposerSeed) => void): () => void {
    return this.client.onComposerSeed(listener);
  }

  /**
   * Selections the host pinned (the title-bar attach command). The composer
   * turns them into attachment chips in the composer strip.
   */
  onContextSelection(
    listener: (pin: { path: string; startLine?: number; endLine?: number }) => void,
  ): () => void {
    return this.client.onContextSelection(listener);
  }

  /**
   * Live selection previews, streamed while the user draws a selection. The
   * composer shows one unlocked chip that updates in real time until clicked.
   */
  onContextSelectionLive(
    listener: (preview: { path: string; startLine?: number; endLine?: number }) => void,
  ): () => void {
    return this.client.onContextSelectionLive(listener);
  }

  /** Re-sends the handshake (used by a "retry connection" affordance). */
  ready(): void {
    this.actions.ready();
  }

  abort(): void {
    this.actions.abort();
  }

  newSession(cwd?: string): void {
    this.actions.newSession(cwd);
  }

  openProject(path: string): void {
    this.actions.openProject(path);
  }

  requestProjects(): void {
    this.actions.requestProjects();
  }

  activateSession(sessionId: string, cwd?: string): void {
    this.actions.activateSession(sessionId, cwd);
  }

  closeSession(sessionId: string): void {
    this.actions.closeSession(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.actions.deleteSession(sessionId);
  }

  compactSession(instructions?: string): void {
    this.actions.compactSession(instructions);
  }

  /** Asks the host for the previous page of history (scroll reached the top). */
  loadOlderHistory(): void {
    this.actions.loadOlderHistory();
  }

  loadSession(sessionId: string): void {
    this.actions.loadSession(sessionId);
  }

  requestSessions(): void {
    this.actions.requestSessions();
  }

  /** Re-reads the prompt templates and other commands the palette lists. */
  refreshCommands(): void {
    this.actions.refreshCommands();
  }

  setModel(provider: string, id: string): void {
    this.actions.setModel(provider, id);
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.actions.setThinkingLevel(level);
  }

  respond(response: InteractionResponse): void {
    this.actions.respond(response);
  }

  hostCommand(command: HostCommand, args?: Record<string, unknown>): void {
    void this.actions.hostCommand(command, args);
  }

  /**
   * Runs a host command and waits for its value. Resolves `undefined` when the
   * host does not answer, so a caller can fall back instead of hanging.
   */
  requestHostCommand(command: HostCommand, args?: Record<string, unknown>): Promise<unknown> {
    return this.actions.hostCommand(command, args);
  }
}
