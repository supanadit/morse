import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { BootSplash } from '../features/boot-splash/boot-splash';
import { ConnectionScreen } from '../features/connection-screen/connection-screen';
import { ChatComposer } from '../features/composer/composer';
import { EmptySession } from '../features/empty/empty';
import { McpPanel } from '../features/mcp-panel/mcp-panel';
import { McpEditor } from '../features/mcp-editor/mcp-editor';
import type { PromptEditor } from '../features/prompt-editor/prompt-editor';import { ChatTranscript } from '../features/transcript/transcript';
import { FilePreview } from '../features/file-preview/file-preview';
import { InteractionPanel } from '../features/interaction/interaction';
import { BottomPanel } from '../features/bottom-panel/bottom-panel';
import { PiUi } from '../features/pi-ui/pi-ui';
import { TaskOverlay } from '../features/tasks/tasks';
import { TabStrip } from '../features/tab-strip/tab-strip';
import { GitPanel } from '../features/git-panel/git-panel';
import { AnimationService } from '../ui/animation.service';
import { AttachmentStore } from '../state/attachments';
import { LayoutState } from '../state/layout-state';
import { StatusBar } from './status-bar/status-bar';
import { Toolbar } from './toolbar/toolbar';
import { DropZone } from '../ui/drop-zone';
import { MorseService } from '../host/morse.service';
import { RunNotifier } from '../services/run-notifier';
import { NotificationPrefs } from '../state/notification-prefs';
import { PanelState } from '../state/panel-state';
import { ShellState } from '../state/shell-state';
import { WorkspaceTabs } from '../state/workspace-tabs';
import { WorkbenchPersistence } from '../services/workbench-persistence';
import { QueueDrain } from '../services/queue-drain';
import { EnterDirective } from '../ui/enter.directive';
import { SessionNav } from '../features/session-nav/session-nav';
import { ProjectPicker } from '../features/project-picker/project-picker';
import { AboutDialog } from '../features/about/about-dialog';
import { ShortcutsDialog } from '../features/shortcuts-dialog/shortcuts-dialog';
import { CommandPalette } from '../features/command-palette/command-palette';
import { ShortcutService } from '../services/shortcut.service';
import { ShortcutKeys } from '../ui/shortcut-keys';
import { OverlayEscape } from '../ui/overlay-escape';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { AgentScreen } from '../features/agent-screen/agent-screen';

/**
 * `?boot=1` keeps the cold-start screen up long enough to watch it, so the
 * animation can be reviewed against the in-memory mock host.
 */
function previewBoot(): boolean {
  if (typeof location === 'undefined') {
    return false;
  }
  return new URL(location.href, 'http://localhost/').searchParams.get('boot') === '1';
}

@Component({
  selector: 'app-root',
  imports: [
    Toolbar,
    StatusBar,
    SessionNav,
    ProjectPicker,
    AboutDialog,
    ShortcutsDialog,
    CommandPalette,
    AgentScreen,
    ConfirmDialog,
    McpPanel,
    McpEditor,
    NgComponentOutlet,
    ChatTranscript,
    InteractionPanel,
    ChatComposer,
    EmptySession,
    TabStrip,
    BottomPanel,
    PiUi,
    TaskOverlay,
    FilePreview,
    GitPanel,
    EnterDirective,
    BootSplash,
    ConnectionScreen,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  /**
   * This app is the whole document inside a host surface that already has a
   * surrounding UI — a VS Code editor tab showing one session. There is no
   * Morse sidebar to show (the window has its own), no tab strip, and the shell
   * is one column. Read as an input so the same component serves both surfaces;
   * the default `false` is the standalone app.
   */
  readonly embedded = input(false);
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly layout = inject(LayoutState);
  private readonly panel = inject(PanelState);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly notifier = inject(RunNotifier);
  private readonly notifications = inject(NotificationPrefs);
  private readonly shortcuts = inject(ShortcutService);
  private readonly dropZone = inject(DropZone);
  private readonly animation = inject(AnimationService);
  private readonly attachments = inject(AttachmentStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dismissedNoticeAt = signal<number | null>(null);
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The cold-start overlay is only for a handshake that is still pending when
   * the app boots. If the host already answered (the in-memory mock, a warm
   * webview) there is nothing to cover, so it never mounts.
   */
  private readonly bootPreview = previewBoot();
  private readonly bootPending =
    this.animation.isEnabled && (this.bootPreview || this.morse.connection() === 'connecting');
  private bootForceTimer: ReturnType<typeof setTimeout> | undefined;
  protected readonly bootVisible = signal(this.bootPending);
  private readonly bootForced = signal(false);

  /** Once the reader chooses to look around, the full-screen state steps aside. */
  private readonly connectionDismissed = signal(false);
  /**
   * Sticky "no host": set on the first failure and cleared only when the
   * handshake really succeeds. The transport re-announces `connecting` on every
   * retry, so keying the screen off the momentary status made it bounce between
   * the app and the error page every few seconds.
   */
  protected readonly offline = signal(false);

  protected readonly navigationOpen = this.shell.navigationOpen;
  /**
   * The browser host's tab strip (sessions + file previews). Gated on the host's
   * own capability, so VS Code — which has an editor already — stays as it was.
   */
  protected readonly tabsEnabled = computed(() => this.morse.capabilities()?.filePreview === true);
  /**
   * The browser host's bottom panel. VS Code leaves `terminal` off (its own
   * panel has the terminal), so this is only ever mounted by the server host.
   *
   * Mounted for the whole lifetime of a terminal-capable host, not gated on the
   * session in front: unmounting it would destroy every `Terminal` and with it
   * the host-owned shells. `bottomPanelVisible` is what hides it on the empty
   * view while the panel — and its running shells — stay alive.
   */
  protected readonly bottomPanelEnabled = computed(
    () => this.morse.capabilities()?.terminal === true,
  );
  /**
   * Whether the bottom panel takes space. `noSessionInFront` hides it, but the
   * panel and its shells stay mounted (see `bottomPanelEnabled`).
   */
  protected readonly bottomPanelVisible = computed(
    () => this.bottomPanelEnabled() && !this.tabs.noSessionInFront(),
  );
  /**
   * Full-screen bottom panel: the panel takes the whole chat column and the
   * conversation behind it steps aside, the way the git panel's full mode does.
   */
  protected readonly bottomPanelFull = computed(
    () => this.bottomPanelVisible() && this.panel.full(),
  );
  /**
   * The browser host's git panel: history and graph for the active project. VS
   * Code advertises no `gitPanel` and keeps its own Source Control view.
   */
  protected readonly gitEnabled = computed(() => this.morse.capabilities()?.gitPanel === true);
  /** The panel is a layout column, so it is only mounted (and refreshed) when shown. */
  protected readonly gitOpen = computed(
    () => this.gitEnabled() && this.layout.rightVisible() && !this.tabs.noSessionInFront(),
  );
  /** Expanded: the git view spans the conversation area instead of the sidebar. */
  protected readonly gitExpanded = computed(
    () => this.gitOpen() && this.shell.gitPanelExpanded(),
  );
  /**
   * The dragged width of the git panel, handed to the shell as its CSS variable.
   * `null` (never dragged) leaves the default from `styles.css` in charge.
   */
  protected readonly gitWidth = computed(() => {
    const width = this.layout.rightSize();
    return width === undefined ? null : `${width}px`;
  });
  /**
   * The dragged width of the navigation column, handed to the shell as its CSS variable.
   * `null` (never dragged) leaves the default from `styles.css` in charge.
   */
  protected readonly navWidth = computed(() => {
    const width = this.layout.leftSize();
    return width === undefined ? null : `${width}px`;
  });
  /**
   * The dragged heights of the two panes that are sized but never placed — the Explorer and
   * the git panel's Changes section. The shell puts them on screen, so a drag repaints the
   * layout instead of re-rendering the rows inside the pane.
   */
  protected readonly explorerHeight = computed(() => {
    const height = this.layout.explorerSize();
    return height === undefined ? null : `${height}px`;
  });
  protected readonly changesHeight = computed(() => {
    const height = this.layout.changesSize();
    return height === undefined ? null : `${height}px`;
  });
  /** The file the strip is showing, or `undefined` when a session tab is in front. */
  protected readonly activeFile = computed(() => {
    const tab = this.tabs.activeTab();
    return tab?.kind === 'file' ? tab : undefined;
  });
  /** The MCP editor is in front, so the panel shows it instead of a conversation. */
  protected readonly activeMcp = computed(() => this.tabs.activeTab()?.kind === 'mcp');
  /** The prompt-template editor is in front. */
  protected readonly activePrompt = computed(() => this.tabs.activeTab()?.kind === 'prompt');
  /**
   * No session tab is in front, on the host that shows the strip. The panel shows
   * a placeholder instead of a conversation that does not exist, and the composer
   * is not mounted at all — a prompt typed with no session used to silently open
   * one. The shared signal lives on `WorkspaceTabs` so the header reads it too.
   */
  protected readonly noSessionSelected = this.tabs.noSessionInFront;
  /**
   * Pi's extension chrome is worth mounting only while an extension has set a
   * widget or status for the session in front; an empty host stays out of the
   * layout entirely.
   */
  protected readonly piUiVisible = computed(() => {
    const state = this.morse.state();
    return (state.widgets?.length ?? 0) + (state.statuses?.length ?? 0) > 0;
  });

  /**
   * The notification banner, or nothing when there is no channel to fix:
   *
   * - `nudge` — first visit, or the reader turned it off; offers **Turn on**;
   * - `blocked` — it is switched on but the browser is not letting the
   *   notification through (the permission was reset or blocked after the fact),
   *   so the reader thinks it works when it does not.
   *
   * VS Code raises its own notifications, so only its on/off choice matters there.
   */
  protected readonly notificationPrompt = computed<'nudge' | 'blocked' | null>(() => {
    if (this.morse.capabilities()?.notify === true) {
      return !this.notifications.enabled() && !this.notifications.bannerDismissed() ? 'nudge' : null;
    }
    const permission = this.notifier.permission();
    if (permission === 'unsupported') {
      return null;
    }
    if (!this.notifications.enabled()) {
      return this.notifications.bannerDismissed() ? null : 'nudge';
    }
    return permission === 'granted' ? null : 'blocked';
  });
  /** Whether any session tab is open behind the placeholder, so it can say so. */
  protected readonly hasSessionTabs = computed(() =>
    this.tabs.tabs().some((tab) => tab.kind === 'session'),
  );
  /** The last session the strip brought forward, so a redraw does not re-focus it. */
  private focusedSession: string | undefined;
  /**
   * The prompt editor is code-split: its class arrives from a dynamic import
   * only while its tab is in front, and `ngComponentOutlet` mounts it. Keeping
   * it out of `imports` is what keeps its form out of the initial bundle.
   */
  protected readonly promptEditorComponent = signal<typeof PromptEditor | null>(null);
  private promptEditorClass: typeof PromptEditor | null = null;
  private promptEditorLoading = false;
  protected readonly projectPickerOpen = this.shell.projectPickerOpen;
  protected readonly aboutOpen = this.shell.aboutOpen;
  protected readonly shortcutsOpen = this.shell.shortcutsOpen;
  protected readonly mcpOpen = this.shell.mcpOpen;
  protected readonly paletteOpen = this.shell.paletteOpen;
  protected readonly navigationCollapsed = this.layout.leftCollapsed;
  protected readonly compactConfirmOpen = this.shell.compactConfirmOpen;
  /**
   * The question, with the user's own instructions echoed back when they typed
   * `/compact <instructions>` — the dialog is the last place to catch a mistake.
   */
  protected readonly compactBody = computed(() => {
    const base =
      'pi replaces the conversation it is holding with a summary, so the next turn starts from less context. The transcript in this window is untouched.';
    const instructions = this.shell.compactInstructions();
    return instructions
      ? `${base} Your instructions: “${instructions}”.`
      : base;
  });
  protected readonly connection = this.morse.connection;
  protected readonly agentReady = this.morse.agentReady;
  protected readonly agentStarting = this.morse.agentStarting;
  protected readonly agentError = this.morse.agentError;
  /**
   * The agent is down (spawn failure, not a slow start) — the one situation the
   * panel cannot recover from on its own. Nothing is running, so nothing will
   * arrive from the agent to fix it: the UI has to explain it.
   */
  private readonly agentBlocked = computed(
    () =>
      this.connection() === 'ready' &&
      !this.agentReady() &&
      !this.agentStarting() &&
      this.agentError() !== undefined,
  );
  /**
   * With an empty panel there is nothing to show but the problem, so the setup
   * screen takes the whole column. With a transcript there is something worth
   * reading (yesterday's answers do not need a running agent), so the failure
   * shrinks to a bar above it.
   */
  protected readonly agentScreen = computed(
    () => this.agentBlocked() && this.morse.items().length === 0,
  );
  protected readonly agentBanner = computed(() => this.agentBlocked() && !this.agentScreen());
  protected readonly lastError = this.morse.lastError;
  /**
   * Warnings pi reported about its own configuration (a prompt template it
   * refused). They belong to the shell, not the conversation: one warning row
   * above the transcript, with the files listed behind a click, so no session's
   * history is rewritten by a configuration problem.
   */
  protected readonly diagnostics = computed(() => this.morse.state().diagnostics ?? []);
  /** Whether the reader opened the warning's file list. */
  protected readonly diagnosticsOpen = signal(false);

  protected toggleDiagnostics(): void {
    this.diagnosticsOpen.update((open) => !open);
  }
  /** Highlight while files are dragged over the chat. */
  protected readonly dragging = this.dropZone.active;
  protected readonly toast = computed(() => {
    // Host notices and local attachment feedback share one slot; the newest wins.
    const host = this.morse.lastNotice();
    const local = this.attachments.notice();
    const notice = local && (!host || local.at >= host.at) ? local : host;
    if (!notice || notice.at === this.dismissedNoticeAt()) {
      return null;
    }
    return notice;
  });

  /**
   * A toast is transient, so it dismisses itself: an info note goes quickly, a
   * warning lingers a little. The manual close stays for "I read it, go away".
   */
  constructor() {
    // The browser host persists the shell layout (open/focused tabs, panel and
    // terminals). Constructing the service loads what the reader had open and
    // starts watching for changes worth saving; the VS Code host advertises no
    // such capability and the service stays inert there.
    inject(WorkbenchPersistence);
    // The queue drain is shell state too: a queued follow-up must run when its
    // own session settles, even if the reader is looking at another tab.
    inject(QueueDrain);
    // The keyboard's DOM half: constructing it attaches the one document keydown
    // listener the registry is decided by (`ui/shortcut-keys.ts`).
    inject(ShortcutKeys);
    // And the other DOM half: one document Escape listener that hands the press to
    // the topmost dialog, so two open dialogs cannot close on one press
    // (`ui/overlay-escape.ts`).
    inject(OverlayEscape);
    // The two shortcuts whose action belongs to the shell itself. The rest are
    // bound where their state lives: the sidebar owns the search field and the
    // project filter, the composer owns the model chooser, the thinking picker
    // its own panel — so a missing owner shows up as an unavailable row.
    const unbind = [
      this.shortcuts.bind('context.compact', () => this.shell.requestCompact(), () => this.morse.state().agentReady),
      this.shortcuts.bind('help.shortcuts', () => this.shell.toggleShortcuts()),
      // The palette's open flag is shell state (so `modalOpen` is honest and the
      // overlay renders from one place), so its key is bound here like the help's.
      this.shortcuts.bind('command.palette', () => this.shell.togglePalette()),
      // A Morse surface, not a pi command: it opens a tab (browser) or the
      // host's own editor panel (VS Code). Unavailable where the host cannot
      // read pi's prompt directories.
      this.shortcuts.bind(
        'view.prompts',
        () => this.openPromptEditor(),
        () => this.morse.capabilities()?.promptEditor === true,
      ),
    ];
    this.destroyRef.onDestroy(() => {
      for (const off of unbind) {
        off();
      }
    });
    if (this.bootPending) {
      // A hard cap so a decorative screen never becomes a hostage situation;
      // the overlay also releases itself once the intro has had its moment.
      this.bootForceTimer = setTimeout(() => this.bootForced.set(true), 7_000);
    }
    // A reconnection arms the full-screen state again, so a mid-session drop
    // still explains itself even after the reader once dismissed it. A retry
    // that flips back to `connecting` must not clear it: only `ready` does.
    effect(() => {
      const connection = this.morse.connection();
      if (connection === 'ready') {
        this.offline.set(false);
        this.connectionDismissed.set(false);
        return;
      }
      if (connection === 'error' || connection === 'closed' || this.morse.slowConnection()) {
        this.offline.set(true);
      }
    });
    this.destroyRef.onDestroy(() => {
      this.clearNoticeTimer();
      this.clearBootTimer();
    });
    // A toast is transient, so it dismisses itself: an info note goes quickly, a
    // warning lingers a little. The manual close stays for "I read it, go away".
    effect(() => {
      const notice = this.toast();
      this.clearNoticeTimer();
      if (!notice) {
        return;
      }
      const ttl = notice.level === 'warn' || notice.level === 'error' ? 6_000 : 3_200;
      this.noticeTimer = setTimeout(() => this.dismissedNoticeAt.set(notice.at), ttl);
    });
    // While files hover the chat, the target is alive: the ring pings outwards,
    // the card breathes and the icon bobs. Stopped as soon as the drag ends, so
    // nothing animates off screen.
    effect(() => {
      const dragging = this.dragging();
      this.stopDropzoneLoops();
      if (!dragging) {
        return;
      }
      // The overlay is created by this change, so it is measured after the DOM
      // settles.
      setTimeout(() => {
        if (!this.dragging()) {
          return;
        }
        const host: HTMLElement | undefined =
          (globalThis as { document?: Document }).document?.querySelector('.dropzone') ?? undefined;
        if (!host) {
          return;
        }
        const card = host.querySelector('.dropzone-card');
        const icon = host.querySelector('.dropzone-icon');
        const ring = host.querySelector('.dropzone-ring');
        this.dropzoneStops = [
          this.animation.loop(ring, { scale: [1, 1.035], opacity: [0.9, 0.25] }, { duration: 1100 }),
          this.animation.loop(card, { scale: [1, 1.03] }, { duration: 700 }),
          this.animation.loop(icon, { translateY: [1.5, -3] }, { duration: 520 }),
        ];
      }, 0);
    });
    // The strip follows the host's active session: a resume or a fresh session
    // brings its tab forward, while a file tab stays put as the agent streams.
    // Tracked in both hosts — the strip only *renders* where `filePreview` is set
    // — because the composer keys its per-session draft off the active tab, and a
    // draft must be promoted to the session the first prompt opens in every host.
    effect(() => {
      const state = this.morse.state();
      const id = state.sessionId;
      if (id === undefined) {
        // The host dropped to an empty draft (a session closed behind us, a
        // retry): no real session tab is showing it, so none stays highlighted.
        this.focusedSession = undefined;
        this.tabs.clearActiveSession();
        return;
      }
      const session = {
        id,
        title: this.sessionTitle(id, state.sessionTitle),
        cwd: state.workspace.cwd,
      };
      if (id === this.focusedSession) {
        // Same session: keep the tab's title current without stealing focus — and
        // without bringing back a tab the user closed.
        this.tabs.refreshSession(session);
        return;
      }
      this.focusedSession = id;
      this.tabs.showSession(session);
    });
    // Load the prompt editor only while its tab is in front. A lazy `import()`
    // keeps its template and cheat sheet in their own chunk, unlike `@defer`,
    // whose runtime would ride in the initial bundle instead.
    effect(() => {
      if (!this.activePrompt()) {
        this.promptEditorComponent.set(null);
        return;
      }
      // The class is cached, so a switch away and back re-mounts without a
      // second `import()` (and an in-flight load never leaves the tab empty).
      if (this.promptEditorClass !== null) {
        this.promptEditorComponent.set(this.promptEditorClass);
        return;
      }
      void this.loadPromptEditor();
    });
  }

  private async loadPromptEditor(): Promise<void> {
    if (this.promptEditorLoading) {
      return;
    }
    this.promptEditorLoading = true;
    try {
      const { PromptEditor: Editor } = await import('../features/prompt-editor/prompt-editor');
      this.promptEditorClass = Editor;
      if (this.activePrompt()) {
        this.promptEditorComponent.set(Editor);
      }
    } finally {
      this.promptEditorLoading = false;
    }
  }

  protected onBootDismissed(): void {
    this.bootVisible.set(false);
    this.clearBootTimer();
  }

  /**
   * A tab's label. The host puts a session's title in `session/list` (where the
   * sidebar reads it) and, once it can derive one, in `session/state` too — so
   * prefer the state's, and fall back to the list for a host that sends only it.
   */
  private sessionTitle(id: string, stateTitle?: string): string {
    if (stateTitle !== undefined && stateTitle.length > 0) {
      return stateTitle;
    }
    const summary = this.morse.sessions().find((session) => session.id === id);
    return summary?.title ?? 'New session';
  }

  protected onConnectionExplore(): void {
    this.connectionDismissed.set(true);
  }

  /**
   * Opens the prompt-template editor: a tab on a host with a Morse tab strip,
   * the host's own editor panel where there is none (VS Code).
   */
  protected openPromptEditor(): void {
    if (this.morse.capabilities()?.filePreview === true) {
      this.tabs.openPrompt();
    } else {
      void this.morse.requestHostCommand('openPromptEditor', {}).catch(() => undefined);
    }
  }

  /** Bring the full-screen connection help back after it was dismissed. */
  protected showConnectionHelp(): void {
    this.connectionDismissed.set(false);
  }

  /** Point the browser host at another server (`?server=…`) and reload into it. */
  protected onConnectionConnect(url: string): void {
    if (typeof location === 'undefined') {
      return;
    }
    try {
      // Rebuilt from the page's own origin+path (never the raw `location.href`),
      // so the navigation target can only be this same document with a changed
      // `server` query parameter — it can never become a redirect elsewhere.
      const current = new URL(location.href);
      const next = new URL(`${current.origin}${current.pathname}`);
      next.search = current.search;
      next.searchParams.set('server', url);
      location.assign(next.toString());
    } catch {
      // The page's own URL was not parseable: there is nothing to reload into.
    }
  }

  private clearBootTimer(): void {
    if (this.bootForceTimer !== undefined) {
      clearTimeout(this.bootForceTimer);
      this.bootForceTimer = undefined;
    }
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimer !== undefined) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
  }

  /**
   * Reveal the app once the host has answered with its state. A session is
   * created lazily (on the first prompt), so a fresh window has no agent to wait
   * for — only the handshake matters. A failure or the slow-handshake watchdog
   * also reveals the app, so the error state can explain itself.
   */
  protected readonly bootReady = computed(() => {
    if (this.bootForced()) {
      return true;
    }
    const connection = this.morse.connection();
    if (connection === 'error' || connection === 'closed' || this.morse.slowConnection()) {
      return true;
    }
    return connection === 'ready';
  });

  /** What the overlay is waiting for, in the user's words. */
  protected readonly bootStatus = computed(() => {
    if (this.morse.connection() !== 'ready') {
      return 'Connecting to the host…';
    }
    if (this.morse.agentStarting()) {
      return 'Starting the pi agent…';
    }
    if (this.morse.agentError() !== undefined) {
      return 'The agent could not start';
    }
    return 'Ready';
  });

  /**
   * The friendly full-screen state for "there is no host to talk to". It only
   * appears once the cold start has finished, and steps aside for good the
   * moment the user asks to look around (the compact bar stays behind).
   */
  protected readonly connectionScreen = computed<{
    eyebrow: string;
    title: string;
    body: string;
    detail: string;
  } | null>(() => {
    if (this.bootVisible() || this.connectionDismissed() || !this.offline()) {
      return null;
    }
    const refused = this.lastError();
    if (refused) {
      return {
        eyebrow: 'Handshake refused',
        title: 'The host turned this frontend away',
        body: 'The socket is up, but the handshake was rejected. That usually means the frontend and the host disagree on the wire protocol — rebuild both together.',
        detail: refused.detail ? `${refused.message} — ${refused.detail}` : refused.message,
      };
    }
    if (this.morse.slowConnection() && this.morse.connection() === 'connecting') {
      return {
        eyebrow: 'No answer yet',
        title: 'The host is not answering',
        body: 'A socket opened but the handshake never came back. The host may still be starting, or this address is not a Morse host.',
        detail: this.morse.connectionDetail() ?? '',
      };
    }
    return {
      eyebrow: 'Offline · reconnecting',
      title: 'Morse is waiting for a host',
      // The page is a copy the browser is holding, and that is exactly what
      // confuses someone who just stopped the host: say so, and say what survived.
      body: 'This window is only the frontend, and it keeps working while the host is away. Nothing is lost — your sessions live with the host and in pi’s session files — so start the host again and this screen will clear itself.',
      detail: this.morse.connectionDetail() ?? '',
    };
  });

  /**
   * The user said yes: the dialog steps aside, then the host asks pi to compact.
   * Closing first keeps a slow request from leaving a stale question on screen.
   */
  protected confirmCompact(): void {
    const instructions = this.shell.compactInstructions();
    this.shell.closeCompactPrompt();
    this.morse.compactSession(instructions);
  }

  protected cancelCompact(): void {
    this.shell.closeCompactPrompt();
  }

  protected closeNavigation(): void {
    this.shell.closeNavigation();
  }

  /**
   * The empty panel's "New session": the sidebar's own action, host-aware (a
   * global host asks which folder first), rather than a second implementation
   * that could drift from the button and the key.
   */
  protected newSession(): void {
    this.shortcuts.run('session.new');
  }

  /** The nudge's "Turn on": opt in — the browser prompt lands on this click. */
  protected enableNotifications(): void {
    void this.notifier.optIn();
  }

  protected dismissNotificationPrompt(): void {
    this.notifications.dismissBanner();
  }

  /** The blocked banner's way out: stop asking for notifications at all. */
  protected turnOffNotifications(): void {
    this.notifications.disable();
  }

  protected retryConnection(): void {
    // Re-sends the handshake; transports queue it until they are connected.
    this.morse.ready();
  }

  protected reload(): void {
    if (typeof location !== 'undefined') {
      location.reload();
    }
  }

  protected retryAgent(): void {
    this.morse.newSession();
  }

  protected openSettings(): void {
    this.morse.hostCommand('openSettings');
  }

  protected showLog(): void {
    this.morse.hostCommand('showOutput');
  }

  protected dismissToast(): void {
    this.dismissedNoticeAt.set(this.toast()?.at ?? this.morse.lastNotice()?.at ?? null);
  }

  /**
   * While files hover the chat, the target is alive: the ring pings outwards, the
   * card breathes and the icon bobs. Stopped as soon as the drag ends, so nothing
   * animates off screen.
   */
  private dropzoneStops: Array<() => void> = [];

  private stopDropzoneLoops(): void {
    for (const stop of this.dropzoneStops) {
      stop();
    }
    this.dropzoneStops = [];
  }

  protected onDragEnter(event: DragEvent): void {
    this.dropZone.onDragEnter(event);
  }

  protected onDragOver(event: DragEvent): void {
    this.dropZone.onDragOver(event);
  }

  protected onDragLeave(): void {
    this.dropZone.onDragLeave();
  }

  protected onDrop(event: DragEvent): void {
    void this.dropZone.onDrop(event, this.morse.state().workspace.cwd);
  }
}
