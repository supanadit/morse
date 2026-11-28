import * as vscode from 'vscode';
import {
  ChatService,
  ComposerHub,
  DraftCardStore,
  SessionRegistry,
  UnsupportedByHostError,
  describeError,
  mcpScope,
  numberArg,
  stringArg,
  type AgentExtras,
  type AgentMcpExtras,
  type AgentPromptExtras,
  type EditorContextProvider,
  type HostHandlerCommand,
  type MorseLogger,
} from '@morse/system';
import {
  McpWatcher,
  parseMcpServerInput,
  parseMcpServerSpec,
  parsePromptTemplateInput,
  type McpInspector,
} from '@morse/integration-pi';
import {
  HostSessionController,
  readDrafts,
  readWorkbench,
  saveDrafts,
  saveWorkbench,
  type HostSessionServices,
  type ProjectPolicy,
  type SessionTranscriptStore,
} from '@morse/system';
import {
  parseClientMessage,
  type ClientToHostMessage,
  type DeclaredHostCapabilities,
  type EngineOption,
  type EngineSetupOption,
  type HostToClientMessage,
  type NoticeLevel,
  type ServerHostCommand,
} from '@morse/protocol';
import { VsCodeDialogs } from './vscode-dialogs';
import {
  renderFailureHtml,
  toSelectionPayload,
  toWorkspacePath,
} from './view-helpers';
import { renderWebviewHtml } from './webview-html';
import { SelectionPreviewTracker } from './selection-preview';
import { workspaceFiles } from './workspace-index';

/** The MCP editor panel's view type; also the `onWebviewPanel` activation event. */
const MCP_EDITOR_VIEW_TYPE = 'morse.mcpEditor';
/** The prompt-template editor panel's view type; also its activation event. */
const PROMPT_EDITOR_VIEW_TYPE = 'morse.promptEditor';
/**
 * The session-tab view type. One type for every session (VS Code registers one
 * serializer per view type, and a window reload must be able to restore each
 * restored panel), so which session a tab is travels in the webview state the
 * pinned surface wrote — see `SESSION_TAB_STATE_KEY`.
 */
const SESSION_TAB_VIEW_TYPE = 'morse.sessionTab';
/**
 * Where the pinned surface records which session its tab is, so a reload can
 * restore the tab to the same conversation. Namespaced the way `ViewState`
 * writes it (`morse.view.`), because the frontend is what writes it.
 */
const SESSION_TAB_STATE_KEY = 'morse.view.sessionTab';
/**
 * The hash route a session tab boots. The session id is the only thing the
 * surface needs from its host: the tab is pinned to it, so it never learns the
 * id from `session/state` and never has to be told which conversation it is.
 */
function sessionRoute(sessionId: string): string {
  return `/session?id=${encodeURIComponent(sessionId)}`;
}

/**
 * The session id a restored session tab was pinned to, or `undefined` when the
 * state carries none. The frontend writes it under `SESSION_TAB_STATE_KEY` via
 * the webview's `setState`; anything else in the blob is the surface's own
 * business and is left alone.
 */
function readSessionTabState(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) {
    return undefined;
  }
  const value = (state as Record<string, unknown>)[SESSION_TAB_STATE_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface ChatViewProviderDeps {
  registry: SessionRegistry;
  transcripts: SessionTranscriptStore;
  chat: ChatService;
  /** The engines this window can start, for the draft's engine picker. */
  engines: EngineOption[];
  /**
   * How to install each engine this window knows, in this host's own words. Sent
   * always; the frontend uses it only when `engines` is empty, for the setup
   * screen a fresh install sees — Morse is engine-agnostic, so that screen
   * offers every agent it can drive instead of blaming one.
   */
  engineSetup: EngineSetupOption[];
  editor: EditorContextProvider;
  policy: ProjectPolicy;
  /** Directories this window is scoped to. */
  roots: string[];
  logger: MorseLogger & { show(): void };
  webviewRoot: vscode.Uri;
  frontend?: { name: string; version: string };
  /** The selected engine's MCP administration; absent hides the MCP manager. */
  mcp?: AgentMcpExtras;
  /** Probes an MCP server before it is added; Morse's own client. */
  inspector: McpInspector;
  /** The selected engine's prompt templates; absent hides the prompt editor. */
  prompts?: AgentPromptExtras;
  /** The selected engine's config-Fix action; absent hides Fix in the panels. */
  fix?: AgentExtras['fix'];
  /** The selected engine's provider sign-ins; absent hides the provider page. */
  providers?: AgentExtras['providers'];
  mcpAvailable: boolean;
  /** The installed pi version, for the "a newer pi is out" notice. */
  piVersion?: string;
  /**
   * Where the window persists its shell layout (`workbench.json`) and drafts
   * (`drafts.json`) across a reload. VS Code's own per-window storage, so two
   * windows on different folders never share a layout.
   */
  workbenchDataDir: string;
}

/** What this host can do — the frontend reads this instead of guessing.
 *
 * The return type is the parity contract: every capability in the protocol must
 * be DECIDED here — `false` where this host does not offer a feature, never
 * omitted. A field added to `HostCapabilities` fails this build (and the server
 * host's) until both declare it, so a shared feature flag cannot quietly stay
 * `undefined` on one host while the other turns it on.
 */
function buildCapabilities(deps: ChatViewProviderDeps): DeclaredHostCapabilities {
  const { engines, engineSetup, mcpAvailable: mcp, piVersion, prompts } = deps;
  return {
    hostKind: 'vscode',
    // VS Code is scoped to the folders this window has open:
    // no project switcher, only sessions inside them.
    scope: 'workspace',
    // Every engine this window can start. The draft's engine picker needs the
    // list; a window that could not initialize OpenCode reports pi alone.
    engines,
    // The same engines as install steps. `engines` being empty is what makes the
    // frontend draw the full-screen setup card, so it needs a way to name every
    // agent the reader could install rather than one hardcoded package.
    engineSetup,
    // The host can answer `getEditorContext` so the frontend can pin a selection
    // chip; the context itself is an attachment, never prompt text.
    editorContext: true,
    // The host streams what the user selects (`context/selectionLive`), so the
    // composer can show a live chip that follows the drag until it is clicked.
    selectionLive: true,
    nativeDialogs: true,
    insertIntoEditor: true,
    revealFile: true,
    filePicker: true,
    // The engine can cut the conversation at a past prompt, so it can be edited.
    editMessage: true,
    // The same cut can branch a new session and hand the prompt back instead.
    forkMessage: true,
    // The panel may ask the registry for the latest release, so a reader of a VSIX
    // installed by hand still hears about a newer one. VS Code itself only does
    // that for a Marketplace install. The webview's CSP names the registry origin
    // for exactly this request (see `webview-html.ts`). The same request also
    // covers pi (`@earendil-works/pi-coding-agent`), so one origin serves both.
    updateCheck: true,
    // The pi this window runs, so the panel can say when a newer one is out.
    piVersion,
    // A webview has no Web Notifications, so the panel asks the host to raise one
    // when a run finishes while the reader is looking elsewhere.
    notify: true,
    // pi's MCP servers can be listed and edited through the `pi` CLI.
    mcp,
    // Editing prompt templates needs an engine that loads them from files; this
    // host can reach those directories whether or not the CLI is on PATH.
    promptEditor: prompts !== undefined,
    // Fix rewrites an engine's config file so a later edit can land. This host
    // answers it for the engine whose administration it wires (the default);
    // the frontend hides the button otherwise, exactly like the browser host
    // hides it for an engine without a fix.
    configFix: deps.fix !== undefined,
    // A whole conversation can be shown as its own editor tab, pinned to that
    // session, and revealed again instead of opened twice.
    sessionTabs: true,
    // The window can store the frontend's shell layout under its own storage, so
    // reopening it lands on the session that was in front instead of empty.
    workbench: true,
    // The panels below are the browser host's stand-ins for views VS Code
    // already has; this window keeps the native ones and never answers the
    // commands behind them. Declared false so the frontend hides them here.
    fileUpload: false,
    directoryPicker: false,
    filePreview: false,
    gitPanel: false,
    searchPanel: false,
    terminal: false,
    // VS Code updates through the Marketplace, not a self-installed server.
    selfUpdate: false,
    // Bot mode is a browser-host surface today; no bot service runs in this
    // window, so the frontend hides the mode switch instead of showing a
    // roster that can never load.
    bot: false,
    // One window, one queue: the hub owns every session's queued follow-ups
    // and scheduled compactions, persists them under the window's own storage
    // and broadcasts to every chat surface — exactly like the browser host.
    // Nothing queue-shaped lives in the page, so a reload cannot lose it.
    sharedComposer: true,
    // Single-user only: the VS Code window never scopes sessions per login.
    multiuser: false,
  };
}

/**
 * Driving adapter: hosts the Morse chat webview inside VS Code and bridges it to
 * `HostSessionController` — the same controller the NestJS host uses.
 */
export class MorseChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'morse.chat';

  private controller: HostSessionController | undefined;
  private view: vscode.WebviewView | undefined;
  private frontendConnected = false;
  /** The one MCP editor panel; "Add server" reveals it instead of opening a second. */
  private mcpPanel: vscode.WebviewPanel | undefined;
  /** The one prompt-template editor panel; `/prompts` reveals it. */
  private promptPanel: vscode.WebviewPanel | undefined;
  /**
   * One editor tab per session, keyed by session id. A second request for the
   * same session reveals the tab that is already open instead of opening a
   * second one, which is what makes "open it again" mean *re-focus*.
   */
  private readonly sessionPanels = new Map<string, vscode.WebviewPanel>();
  /** The window's one MCP config watcher; shared by every panel that shows it. */
  private mcpWatcher: McpWatcher | undefined;
  /**
   * The window's one composer queue. Owned by the host (persisted under the
   * window's storage), never by a webview: every chat surface in this window
   * shows the same items, and a reload finds them still there.
   */
  private composerHub: ComposerHub | undefined;

  /**
   * The shared queue, created on first use. Its broadcasts fan out to every
   * live chat surface, so a queue change in a session tab shows in the
   * sidebar too; each controller's start snapshot covers a surface that opens
   * later.
   */
  private composer(): ComposerHub {
    if (this.composerHub === undefined) {
      const hub = new ComposerHub({
        chat: this.deps.chat,
        transcripts: this.deps.transcripts,
        registry: this.deps.registry,
        dataDir: this.deps.workbenchDataDir,
        logger: this.deps.logger,
      });
      hub.subscribe((message) => {
        if (this.view !== undefined) {
          void this.view.webview.postMessage(message);
        }
        for (const panel of this.sessionPanels.values()) {
          void panel.webview.postMessage(message);
        }
      });
      this.composerHub = hub;
      // Reopens sessions with queued items, so the queue drains with no
      // webview connected. Runs once: the hub persists the queue, and later
      // connects only add broadcasts.
      if (!this.queueWarmed) {
        this.queueWarmed = true;
        for (const state of hub.snapshot().states) {
          if (state.queue.length === 0) {
            continue;
          }
          void this.deps.registry.activate(state.sessionId).catch((error: unknown) => {
            this.deps.logger.warn(
              `The queued session ${state.sessionId} could not be reopened`,
              error,
            );
          });
        }
      }
    }
    return this.composerHub;
  }

  /** The host-owned queue entry every chat controller in this window shares. */
  private composerServices(): { composer: ComposerHub } {
    return { composer: this.composer() };
  }

  /**
   * Draft tabs' compositions, persisted under the window's storage. One store
   * for the window: every chat surface restores the same picks, and the queue
   * keeps its rule — host-owned, never a webview's.
   */
  private draftCardsStore: DraftCardStore | undefined;
  /** Warmed once: sessions with queued items reopen without a client. */
  private queueWarmed = false;

  /**
   * The host-owned draft compositions every chat controller in this window
   * shares.
   */
  private draftCardsServices(): { draftCards: DraftCardStore } {
    this.draftCardsStore ??= new DraftCardStore(this.deps.workbenchDataDir, this.deps.logger);
    return { draftCards: this.draftCardsStore };
  }

  /**
   * Routes a webview message to its controller, after pruning any session tabs
   * a close/delete makes stale. Every surface (the sidebar, the MCP and prompt
   * editors, and each session tab) funnels through here so that closing or
   * deleting a session disposes its editor tab no matter which panel asked — a
   * tab is only ever as alive as the conversation it is pinned to.
   */
  private async handleClientMessage(
    controller: HostSessionController,
    message: ClientToHostMessage,
  ): Promise<void> {
    if (message.type === 'session/close' || message.type === 'session/delete') {
      this.disposeSessionTab(message.payload.sessionId);
    }
    await controller.handleClientMessage(message);
    // A rename must reach the tab label too: the tab is the session's place in
    // the editor, so a stale label reads exactly like the rename did nothing.
    if (message.type === 'session/rename') {
      this.relabelSessionTab(message.payload.sessionId, message.payload.title);
    }
  }

  /** Renames the editor tab pinned to `sessionId`, when it is open. */
  private relabelSessionTab(sessionId: string, title: string): void {
    // The input is capped at the host's maximum, so the trimmed title is what
    // the host accepted; an empty one is refused before it gets here.
    const name = title.trim();
    const panel = this.sessionPanels.get(sessionId);
    if (panel !== undefined && name.length > 0) {
      panel.title = name;
    }
  }

  /**
   * Disposes the editor tab pinned to `sessionId`, if any, and drops its map
   * entry. Called when the session is closed or deleted, and by the restore path
   * for a tab whose conversation no longer exists. A no-op when the session has
   * no tab, so the common close-in-the-sidebar case stays cheap.
   */
  private disposeSessionTab(sessionId: string): void {
    const panel = this.sessionPanels.get(sessionId);
    if (panel === undefined) {
      return;
    }
    // `onDidDispose` deletes the map entry only when it still points at this
    // panel, so dropping it here keeps a panel that is already being disposed
    // (e.g. the tab closed itself) from being deleted twice.
    panel.dispose();
    if (this.sessionPanels.get(sessionId) === panel) {
      this.sessionPanels.delete(sessionId);
    }
  }

  constructor(private readonly deps: ChatViewProviderDeps) {}

  /**
   * One watcher per window, created on first use. Every panel that subscribes
   * shares it, and it polls nothing once the last one is disposed.
   */
  private mcpWatch(): McpWatcher | undefined {
    const mcp = this.deps.mcp;
    if (mcp === undefined) {
      return undefined;
    }
    this.mcpWatcher ??= new McpWatcher({
      signature: (cwd) => mcp.configSignature(cwd),
      // The global file always; a project file only while one of its sessions is
      // warm — exactly when the indicator can show it.
      cwds: () =>
        this.deps.registry
          .hotKeys()
          .map((key) => this.deps.registry.stateOf(key)?.workspace.cwd ?? '')
          .filter((cwd) => cwd.length > 0),
    });
    return this.mcpWatcher;
  }

  /** The watcher option, omitted entirely for an engine without MCP configs. */
  private mcpWatchOption(): { mcpWatch?: McpWatcher } {
    const watch = this.mcpWatch();
    return watch === undefined ? {} : { mcpWatch: watch };
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.deps.webviewRoot],
    };

    try {
      view.webview.html = await renderWebviewHtml(view.webview, this.deps.webviewRoot, {
        title: 'Morse',
      });
    } catch (error: unknown) {
      // A rejected resolveWebviewView leaves the panel blank with no explanation,
      // so a failure to read the bundle is shown in the webview itself.
      this.deps.logger.error('Could not load the Morse frontend bundle', error);
      view.webview.html = renderFailureHtml(
        'Morse could not load its frontend bundle.',
        describeError(error),
        'Run `npm run build:ui && npm run sync-webview` in packages/extension, then reload the window.',
      );
      return;
    }

    const services: HostSessionServices = {
      registry: this.deps.registry,
      chat: this.deps.chat,
      ...this.composerServices(),
      ...this.draftCardsServices(),
      ...this.mcpWatchOption(),
    };

    const controller = new HostSessionController({
      services,
      capabilities: buildCapabilities(this.deps),
      emit: (message) => this.post(message),
      logger: this.deps.logger,
      dialogs: new VsCodeDialogs(),
      transcripts: this.deps.transcripts,
      // The registry belongs to the window, not to the webview.
      ownsRegistry: false,
      // Do not spawn a session on load: an empty panel must stay empty until the
      // user actually says something. Every reload used to create a throwaway
      // "New session".
      autoOpen: false,
      policy: this.deps.policy,
      scope: { kind: 'workspace', roots: this.deps.roots },
      frontend: this.deps.frontend,
      onHostCommand: (command, args, context) => this.runHostCommand(command, args, context),
      agentHint: 'Set "morse.pi.path" or install the pi CLI so that it is on PATH.',
    });
    this.controller = controller;

    // Live selection preview: the chip in the composer follows what the user is
    // drawing in the editor, in real time, until they click it to lock it. The
    // tracker dies with the view, so the host stops posting into a dead webview.
    const liveSelection = new SelectionPreviewTracker((preview) =>
      this.post({ type: 'context/selectionLive', payload: preview }),
    );
    // Something may already be selected right now (the user selected, then
    // opened the panel): show it, do not wait for a selection event.
    liveSelection.flush();

    const subscription = view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseClientMessage(raw);
      if (!message) {
        this.deps.logger.warn('Ignoring an unrecognised webview message');
        return;
      }
      // The handshake is the only proof that the frontend actually booted inside
      // the webview; a blank panel and a silent log look identical otherwise.
      if (message.type === 'client/ready' && !this.frontendConnected) {
        this.frontendConnected = true;
        this.deps.logger.info(
          `The Morse webview connected${this.deps.frontend ? ` (${this.deps.frontend.name}@${this.deps.frontend.version})` : ''}`,
        );
        // The webview booted fresh, so it does not know about the preview we
        // already posted while it was starting up: repost the current state.
        liveSelection.flush();
      }
      void this.handleClientMessage(controller, message);
    });

    view.onDidDispose(() => {
      subscription.dispose();
      liveSelection.dispose();
      this.controller = undefined;
      this.view = undefined;
      // A reload re-resolves this view with a fresh webview, so treat it as a
      // brand-new frontend: the next handshake logs again instead of being
      // swallowed by the stale "already connected" flag.
      this.frontendConnected = false;
      void controller.dispose();
    });

    try {
      await controller.start();
    } catch (error: unknown) {
      // The webview is already showing, so report this where the user can see it
      // instead of failing the whole view.
      this.deps.logger.error('Morse could not start its session controller', error);
      this.postNotice('error', `Morse could not start: ${describeError(error)}`);
    }
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${MorseChatViewProvider.viewType}.focus`);
  }

  /**
   * The MCP editor as its own editor tab. VS Code has no Morse tab strip, so the
   * editor gets a `WebviewPanel` instead — the same Angular bundle, routed with
   * `#/mcp`, and its own `HostSessionController` so the panel's `mcpInspect` /
   * `mcpAdd` commands reach the same registry the sidebar does. At most one panel
   * is open: a second "Add server" reveals the one already up.
   */
  openMcpEditor(): void {
    if (this.mcpPanel !== undefined) {
      this.mcpPanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      MCP_EDITOR_VIEW_TYPE,
      'MCP server',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.deps.webviewRoot],
      },
    );
    this.attachMcpPanel(panel);
  }

  /**
   * The prompt-template editor as its own editor tab, the same shape as the MCP
   * editor: the routed bundle with `#/prompts` and its own `HostSessionController`,
   * so the panel's `promptTemplates` commands reach the same registry the sidebar
   * does. At most one panel is open; `/prompts` reveals the one already up.
   */
  openPromptEditor(): void {
    if (this.promptPanel !== undefined) {
      this.promptPanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PROMPT_EDITOR_VIEW_TYPE,
      'Prompt templates',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.deps.webviewRoot],
      },
    );
    this.attachPromptPanel(panel);
  }

  /**
   * One session as its own editor tab: the pinned controller, so the tab holds
   * exactly that conversation whatever the sidebar is showing. Reveals the tab
   * when this session already has one — the same session must not be open twice.
   */
  openSessionTab(sessionId: string, title?: string): void {
    const existing = this.sessionPanels.get(sessionId);
    if (existing !== undefined) {
      existing.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      SESSION_TAB_VIEW_TYPE,
      title !== undefined && title.length > 0 ? title : 'Morse session',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.deps.webviewRoot],
      },
    );
    this.attachSessionPanel(panel, sessionId, title);
  }

  /**
   * Every open session tab, for the palette's QuickPick when the command is run
   * without naming a session. Sorted newest-first by the catalog itself.
   */
  async pickSessionTab(): Promise<void> {
    const sessions = await this.deps.registry.listSessions().catch(() => []);
    const roots = this.deps.roots;
    const scoped = sessions.filter(
      (session) =>
        roots.length === 0 ||
        roots.some(
          (root) =>
            session.cwd === root ||
            session.cwd.startsWith(`${root}/`) ||
            session.cwd.startsWith(`${root}\\`),
        ),
    );
    if (scoped.length === 0) {
      void vscode.window.showInformationMessage('Morse: no sessions in this window yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      scoped.map((session) => ({
        label: session.title || 'New session',
        description: this.sessionPanels.has(session.id) ? 'open in a tab' : session.cwd,
        sessionId: session.id,
      })),
      { title: 'Open a Morse session in an editor tab', placeHolder: 'Which session?' },
    );
    if (picked !== undefined) {
      this.openSessionTab(picked.sessionId, picked.label);
    }
  }

  /**
   * Wires a session tab (fresh or restored) to a controller pinned to that one
   * session. Mirrors `attachMcpPanel`, with the one difference that matters: the
   * controller is told which session it shows, so its prompts, Stop and model
   * picks stay in this conversation.
   */
  private attachSessionPanel(
    panel: vscode.WebviewPanel,
    sessionId: string,
    preferredTitle?: string,
  ): void {
    this.sessionPanels.set(sessionId, panel);
    // The tab keeps the session's own title once the catalog knows it; the tab
    // is a place, and a place that renames itself to "New session" is noise.
    void this.labelSessionTab(panel, sessionId, preferredTitle);

    const services: HostSessionServices = {
      registry: this.deps.registry,
      chat: this.deps.chat,
      ...this.composerServices(),
      ...this.draftCardsServices(),
      ...this.mcpWatchOption(),
    };
    const controller = new HostSessionController({
      services,
      capabilities: buildCapabilities(this.deps),
      emit: (message) => void panel.webview.postMessage(message),
      logger: this.deps.logger,
      dialogs: new VsCodeDialogs(),
      transcripts: this.deps.transcripts,
      ownsRegistry: false,
      autoOpen: false,
      // The session this tab is: activated on start (reusing the warm process
      // when the sidebar already holds it) and addressed by every command.
      pinnedSessionId: sessionId,
      policy: this.deps.policy,
      scope: { kind: 'workspace', roots: this.deps.roots },
      frontend: this.deps.frontend,
      onHostCommand: (command, args, context) => this.runHostCommand(command, args, context),
      agentHint: 'Set "morse.pi.path" or install the pi CLI so that it is on PATH.',
    });

    const subscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseClientMessage(raw);
      if (message) {
        void this.handleClientMessage(controller, message);
      }
    });

    panel.onDidDispose(() => {
      subscription.dispose();
      // Only drop the mapping this panel owns: a replaced panel for the same
      // session must not delete the new one's entry.
      if (this.sessionPanels.get(sessionId) === panel) {
        this.sessionPanels.delete(sessionId);
      }
      void controller.dispose();
    });

    void renderWebviewHtml(panel.webview, this.deps.webviewRoot, {
      title: 'Morse session',
      route: sessionRoute(sessionId),
    })
      .then((html) => {
        panel.webview.html = html;
      })
      .catch((error: unknown) => {
        this.deps.logger.error('Could not load the Morse frontend bundle for a session tab', error);
        panel.webview.html = renderFailureHtml(
          'Morse could not load its frontend bundle.',
          describeError(error),
          'Run `npm run build:ui && npm run sync-webview` in packages/extension, then reload the window.',
        );
      });

    void controller.start().catch((error: unknown) => {
      this.deps.logger.error('Morse could not start a session tab controller', error);
    });
  }

  private async labelSessionTab(
    panel: vscode.WebviewPanel,
    sessionId: string,
    preferred?: string,
  ): Promise<void> {
    if (preferred !== undefined && preferred.length > 0) {
      panel.title = preferred;
      return;
    }
    // The caller (a restored tab) had no title to offer, so ask the catalog. A
    // failure just leaves the panel's own default title in place.
    const sessions = await this.deps.registry.listSessions().catch(() => []);
    const found = sessions.find((session) => session.id === sessionId);
    if (found !== undefined && found.title.length > 0) {
      panel.title = found.title;
    }
  }

  /**
   * Registers the panel serializer with the extension context, so a window
   * reload restores the MCP editor instead of closing it. VS Code passes back
   * the webview state it kept (the frontend's `setState`), which is how the
   * half-filled entry survives.
   */
  registerSerializers(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(MCP_EDITOR_VIEW_TYPE, {
        deserializeWebviewPanel: (panel: vscode.WebviewPanel) => {
          this.attachMcpPanel(panel);
          return Promise.resolve();
        },
      }),
      vscode.window.registerWebviewPanelSerializer(PROMPT_EDITOR_VIEW_TYPE, {
        deserializeWebviewPanel: (panel: vscode.WebviewPanel) => {
          this.attachPromptPanel(panel);
          return Promise.resolve();
        },
      }),
      vscode.window.registerWebviewPanelSerializer(SESSION_TAB_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown) => {
          // Which session this tab was lives in the webview state the pinned
          // surface wrote (`SESSION_TAB_STATE_KEY`). A tab restored without it
          // cannot be re-pinned to a conversation, so it is closed rather than
          // silently becoming an unrelated session.
          const sessionId = readSessionTabState(state);
          if (sessionId === undefined || !(await this.sessionExists(sessionId))) {
            // A tab whose conversation was deleted while the window was closed
            // would otherwise come back pinned to a session that is gone; there
            // is nothing to restore it to.
            panel.dispose();
            return;
          }
          this.attachSessionPanel(panel, sessionId);
        },
      }),
    );
  }

  /**
   * Whether a session still exists, warm in the registry or stored on disk. A
   * session that is not hot can still be resumed from its file, so the catalog is
   * the fallback; a catalog that cannot be read leaves the tab alone rather than
   * closing a conversation that may well be there.
   */
  private async sessionExists(sessionId: string): Promise<boolean> {
    if (this.deps.registry.stateOf(sessionId) !== undefined) {
      return true;
    }
    const sessions = await this.deps.registry.listSessions().catch(() => undefined);
    return sessions === undefined || sessions.some((session) => session.id === sessionId);
  }

  /**
   * Wires a panel (fresh or restored) to a session controller and the routed
   * bundle. Kept separate from `openMcpEditor` because the serializer hands us
   * a panel we did not create.
   */
  private attachMcpPanel(panel: vscode.WebviewPanel): void {
    this.mcpPanel = panel;

    const services: HostSessionServices = {
      registry: this.deps.registry,
      chat: this.deps.chat,
      ...this.composerServices(),
      ...this.draftCardsServices(),
      ...this.mcpWatchOption(),
    };
    const controller = new HostSessionController({
      services,
      capabilities: buildCapabilities(this.deps),
      emit: (message) => void panel.webview.postMessage(message),
      logger: this.deps.logger,
      dialogs: new VsCodeDialogs(),
      transcripts: this.deps.transcripts,
      ownsRegistry: false,
      autoOpen: false,
      policy: this.deps.policy,
      scope: { kind: 'workspace', roots: this.deps.roots },
      frontend: this.deps.frontend,
      onHostCommand: (command, args, context) => this.runHostCommand(command, args, context),
      agentHint: 'Set "morse.pi.path" or install the pi CLI so that it is on PATH.',
    });

    const subscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseClientMessage(raw);
      if (message) {
        void this.handleClientMessage(controller, message);
      }
    });

    panel.onDidDispose(() => {
      subscription.dispose();
      this.mcpPanel = undefined;
      void controller.dispose();
    });

    void renderWebviewHtml(panel.webview, this.deps.webviewRoot, {
      title: 'MCP server',
      route: '/mcp',
    })
      .then((html) => {
        panel.webview.html = html;
      })
      .catch((error: unknown) => {
        this.deps.logger.error(
          'Could not load the Morse frontend bundle for the MCP editor',
          error,
        );
        panel.webview.html = renderFailureHtml(
          'Morse could not load its frontend bundle.',
          describeError(error),
          'Run `npm run build:ui && npm run sync-webview` in packages/extension, then reload the window.',
        );
      });

    void controller.start().catch((error: unknown) => {
      this.deps.logger.error('Morse could not start the MCP editor controller', error);
    });
  }

  /**
   * Wires a prompt-editor panel (fresh or restored) to a session controller and
   * the routed bundle, exactly like the MCP editor's `attachMcpPanel`.
   */
  private attachPromptPanel(panel: vscode.WebviewPanel): void {
    this.promptPanel = panel;

    const services: HostSessionServices = {
      registry: this.deps.registry,
      chat: this.deps.chat,
      ...this.composerServices(),
      ...this.draftCardsServices(),
    };
    const controller = new HostSessionController({
      services,
      capabilities: buildCapabilities(this.deps),
      emit: (message) => void panel.webview.postMessage(message),
      logger: this.deps.logger,
      dialogs: new VsCodeDialogs(),
      transcripts: this.deps.transcripts,
      ownsRegistry: false,
      autoOpen: false,
      policy: this.deps.policy,
      scope: { kind: 'workspace', roots: this.deps.roots },
      frontend: this.deps.frontend,
      onHostCommand: (command, args, context) => this.runHostCommand(command, args, context),
      agentHint: 'Set "morse.pi.path" or install the pi CLI so that it is on PATH.',
    });

    const subscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseClientMessage(raw);
      if (message) {
        void this.handleClientMessage(controller, message);
      }
    });

    panel.onDidDispose(() => {
      subscription.dispose();
      this.promptPanel = undefined;
      void controller.dispose();
    });

    void renderWebviewHtml(panel.webview, this.deps.webviewRoot, {
      title: 'Prompt templates',
      route: '/prompts',
    })
      .then((html) => {
        panel.webview.html = html;
      })
      .catch((error: unknown) => {
        this.deps.logger.error(
          'Could not load the Morse frontend bundle for the prompt editor',
          error,
        );
        panel.webview.html = renderFailureHtml(
          'Morse could not load its frontend bundle.',
          describeError(error),
          'Run `npm run build:ui && npm run sync-webview` in packages/extension, then reload the window.',
        );
      });

    void controller.start().catch((error: unknown) => {
      this.deps.logger.error('Morse could not start the prompt editor controller', error);
    });
  }

  async newSession(): Promise<void> {
    await this.dispatch({ type: 'session/new', payload: {} });
  }

  async attachSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selections.every((selection) => selection.isEmpty)) {
      void vscode.window.showInformationMessage('Morse: select some text in the editor first.');
      return;
    }
    if (!this.view) {
      // The chip lives in the chat webview, so an unpinned webview cannot show it.
      void vscode.window.showInformationMessage('Morse: open the chat panel first.');
      return;
    }
    // The frontend owns the attachment: it renders the chip and the prompt keeps
    // the words the user typed. The host only reports what it can see.
    this.post({
      type: 'context/selection',
      payload: toSelectionPayload(
        vscode.workspace.asRelativePath(editor.document.uri, false),
        editor,
      ),
    });
  }

  postNotice(level: NoticeLevel, text: string): void {
    this.post({ type: 'notice', payload: { level, text, at: Date.now() } });
  }

  private async dispatch(message: ClientToHostMessage): Promise<void> {
    if (!this.controller) {
      await this.focus();
      this.postNotice('warn', 'Morse chat is still starting — try again in a moment.');
      return;
    }
    await this.controller.handleClientMessage(message);
  }

  private post(message: HostToClientMessage): void {
    void this.view?.webview.postMessage(message);
  }

  /** The directory MCP commands run in: the folder the panel is viewing, then the first root. */
  /** The MCP port, or a refusal for an engine without one. */
  private requireMcp(): AgentMcpExtras {
    if (this.deps.mcp === undefined) {
      throw new UnsupportedByHostError('The selected agent engine has no MCP administration.');
    }
    return this.deps.mcp;
  }

  /** The provider port, or a refusal for an engine without one. */
  private requireProviders(): NonNullable<AgentExtras['providers']> {
    if (this.deps.providers === undefined) {
      throw new UnsupportedByHostError('The selected agent engine has no provider management.');
    }
    return this.deps.providers;
  }

  /**
   * Subscription sign-ins run the engine's own login TUI. VS Code has an
   * integrated terminal, so the command opens there instead of the webview's
   * bottom panel (which this host leaves off).
   */
  private async openProviderLogin(args: Record<string, unknown> | undefined): Promise<unknown> {
    const providers = this.requireProviders();
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
    if (file.length === 0 || rawArgs.some((one) => typeof one !== 'string')) {
      return { ok: false, message: 'This provider has no usable sign-in command.' };
    }
    const terminal = vscode.window.createTerminal({
      name: `Sign in: ${String(args?.['providerId'] ?? 'provider')}`,
      shellPath: file,
      shellArgs: rawArgs as string[],
    });
    terminal.show();
    return { ok: true };
  }

  /** The prompt-template port, or a refusal for an engine without one. */
  private requirePrompts(): AgentPromptExtras {
    if (this.deps.prompts === undefined) {
      throw new UnsupportedByHostError('The selected agent engine has no prompt templates.');
    }
    return this.deps.prompts;
  }

  private mcpCwd(context?: { cwd: string }): string {
    return context?.cwd || this.deps.roots[0] || process.cwd();
  }

  /**
   * The directory prompt commands run in. An explicit `cwd` wins, even when it
   * is empty: the editor sends `''` for "no project in front", which means the
   * user prompts only rather than falling back to the first workspace folder.
   */
  private promptCwd(
    context: { cwd: string } | undefined,
    args: Record<string, unknown> | undefined,
  ): string {
    if (args !== undefined && typeof args['cwd'] === 'string') {
      return args['cwd'];
    }
    return this.mcpCwd(context);
  }

  private async runHostCommand(
    command: HostHandlerCommand,
    args: Record<string, unknown> | undefined,
    context?: { cwd: string },
  ): Promise<unknown> {
    switch (command) {
      case 'listFiles': {
        // Feeds the frontend's file picker. A webview cannot read the workspace,
        // and VS Code does not deliver Explorer drags to it, so this is how files
        // get attached in this host.
        //
        // No notice is posted here: the frontend re-reads this list on a timer,
        // so a toast per answer flashed on every poll. `workspaceFiles` already
        // logs the count (and a zero count) for diagnosis; the browser host keeps
        // the same quiet, its `listFiles` never raising a notice either.
        const files = await workspaceFiles(this.deps.logger);
        return { files };
      }
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'morse.');
        return;
      case 'readWorkbench':
        // The frontend's shell layout, or `null` on a first run (or when the file
        // was written by a frontend this build cannot read). Same envelope the
        // browser host stores, so one frontend restores both hosts identically.
        return readWorkbench(this.deps.workbenchDataDir) ?? null;
      case 'saveWorkbench':
        return { ok: saveWorkbench(this.deps.workbenchDataDir, args) };
      case 'readDrafts':
        return readDrafts(this.deps.workbenchDataDir) ?? null;
      case 'saveDrafts':
        return { ok: saveDrafts(this.deps.workbenchDataDir, args) };
      case 'showOutput':
        this.deps.logger.show();
        return;
      case 'copyToClipboard':
        await vscode.env.clipboard.writeText(stringArg(args, 'text'));
        return;
      case 'insertIntoEditor': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          throw new UnsupportedByHostError('There is no active editor to insert into.');
        }
        const text = stringArg(args, 'text');
        await editor.edit((builder) => builder.insert(editor.selection.active, text));
        return;
      }
      case 'getEditorContext': {
        // Read-only editor snapshot for the frontend's pinned-selection chip;
        // what the agent should read is decided by the user in the composer.
        return this.deps.editor.snapshot();
      }
      case 'revealFile': {
        const raw = stringArg(args, 'path');
        if (!raw) {
          throw new UnsupportedByHostError('revealFile needs a "path" argument.');
        }
        const document = await vscode.workspace.openTextDocument(toWorkspacePath(raw));
        await vscode.window.showTextDocument(document, { preview: true });
        return;
      }
      case 'notify': {
        // A finished run the reader stepped away from. VS Code's webview has no
        // Web Notifications, so the panel asks the host to raise one.
        const title = stringArg(args, 'title') || 'Morse';
        const body = stringArg(args, 'body');
        void vscode.window.showInformationMessage(body ? `${title}: ${body}` : title);
        return;
      }
      case 'mcpStatus': {
        // The session directory is the window's workspace folder; a probe asks
        // pi to connect each enabled server, the fast read answers from the files.
        const mcp = this.requireMcp();
        try {
          return await mcp.status(this.mcpCwd(context), { probe: args?.probe === true });
        } catch (error: unknown) {
          return { servers: [], errors: [describeError(error)] };
        }
      }
      case 'configFix': {
        // The default engine's fix, validated like the server's: complete
        // arguments, an allowed directory, and the file named by the issue
        // passed as-is (the engine refuses any path outside its own configs).
        const fix = this.deps.fix;
        if (fix === undefined) {
          throw new UnsupportedByHostError('The selected agent engine has no config Fix action.');
        }
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
        // A project fix lands in the folder the panel is viewing; a global one
        // needs no directory, and an explicit cwd is only passed on when the
        // policy would let a session live there.
        let cwd: string | undefined;
        if (scope === 'project') {
          cwd = this.mcpCwd(context);
        } else {
          const requested = args?.cwd;
          const active = context?.cwd ?? this.deps.roots[0];
          const candidate = typeof requested === 'string' && requested.length > 0 ? requested : active;
          cwd = candidate !== undefined && this.deps.policy.canOpen(candidate) ? candidate : undefined;
        }
        return fix({ fileId, path, scope, ...(cwd === undefined ? {} : { cwd }) });
      }
      case 'providerStatus':
        return this.requireProviders().list();
      case 'providerConnect':
        return this.requireProviders().connect(args);
      case 'providerDisconnect':
        return this.requireProviders().disconnect(args);
      case 'providerDiscover': {
        const discover = this.requireProviders().discover;
        return discover === undefined
          ? { ok: false, message: 'This engine has no model discovery.' }
          : discover(args);
      }
      case 'providerLogin':
        return this.openProviderLogin(args);
      case 'mcpAdd':
        return this.requireMcp().add(parseMcpServerInput(args), this.mcpCwd(context));
      case 'mcpInspect': {
        // Nothing is written: the reader checks a server before committing it.
        this.requireMcp();
        const spec = parseMcpServerSpec(args);
        const cwd = spec.cwd || this.mcpCwd(context);
        spec.cwd = cwd;
        return this.deps.inspector.inspect(spec, { cwd });
      }
      case 'openMcpEditor':
        // The panel is the editor on this host; the browser host's frontend opens
        // a tab itself and never asks.
        this.openMcpEditor();
        return { ok: true };
      case 'openPromptEditor':
        this.openPromptEditor();
        return { ok: true };
      case 'openSessionTab': {
        const sessionId = stringArg(args, 'sessionId');
        if (sessionId.length === 0) {
          throw new UnsupportedByHostError('openSessionTab needs a "sessionId" argument.');
        }
        this.openSessionTab(sessionId, stringArg(args, 'title') || undefined);
        return { ok: true };
      }
      case 'closeSessionTab': {
        const sessionId = stringArg(args, 'sessionId');
        // Closing the tab is not closing the session: the conversation stays
        // open and resumable in the sidebar, which is what a tab means.
        this.sessionPanels.get(sessionId)?.dispose();
        return { ok: true };
      }
      case 'mcpRemove':
        return this.requireMcp().remove(
          stringArg(args, 'name'),
          this.mcpCwd(context),
          mcpScope(args),
        );
      case 'mcpSetEnabled':
        return this.requireMcp().setEnabled(
          stringArg(args, 'name'),
          args?.enabled === true,
          this.mcpCwd(context),
          mcpScope(args),
        );
      case 'trustProject':
        return this.requireMcp().trustProject(this.mcpCwd(context));
      case 'promptTemplates':
        return this.requirePrompts().list(this.promptCwd(context, args));
      case 'promptTemplateSave':
        return this.requirePrompts().save(
          parsePromptTemplateInput(args),
          this.promptCwd(context, args),
        );
      case 'promptTemplateDelete':
        return this.requirePrompts().delete(
          stringArg(args, 'name'),
          args?.scope === 'project' ? 'project' : 'global',
          this.promptCwd(context, args),
        );
      case 'confirmDeleteSession': {
        // Deleting a stored conversation cannot be undone, so VS Code asks with
        // its own modal warning. The browser host has no native dialogs and
        // renders the question in the session menu instead (see `nativeDialogs`
        // in the capabilities).
        const title = stringArg(args, 'title');
        const answer = await vscode.window.showWarningMessage(
          `Delete \u201c${title || 'this session'}\u201d and its conversation? This cannot be undone.`,
          { modal: true },
          'Delete',
        );
        return { confirmed: answer === 'Delete' };
      }
      case 'confirmDeleteProject': {
        // The project-wide twin: the same irreversible loss, once per session in
        // the directory, so the modal names the count and says what survives.
        const name = stringArg(args, 'name');
        const count = numberArg(args, 'count');
        const answer = await vscode.window.showWarningMessage(
          `Delete the ${count} session${count === 1 ? '' : 's'} in \u201c${name || 'this project'}\u201d? Their conversations cannot be recovered. The folder itself stays on disk.`,
          { modal: true },
          'Delete',
        );
        return { confirmed: answer === 'Delete' };
      }
      default: {
        // Exhaustive by construction: the shared and VS Code surfaces are named
        // cases above, so `command` here is exactly `ServerHostCommand` — the
        // browser host's own panels (git, search, Explorer, upload, self-update).
        // The frontend asks only where the matching capability is on, so this
        // refusal is unreachable in a healthy window; naming the group keeps a
        // future mis-route loud instead of silent. A command added to
        // `SharedHostCommand` or `VsCodeHostCommand` without a case above fails
        // THIS build — that is the never-forget guarantee.
        const browserOnly: ServerHostCommand = command;
        throw new UnsupportedByHostError(
          `"${browserOnly}" is answered by the browser host, not this window.`,
        );
      }
    }
  }
}
