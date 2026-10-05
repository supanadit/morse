import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal } from '@angular/core';
import { BootSplash } from './boot/boot-splash';
import { ConnectionScreen } from './connection/connection-screen';
import { ChatComposer } from './chat/chat-composer/chat-composer';
import { ChatHeader } from './chat/chat-header/chat-header';
import { ChatTranscript } from './chat/chat-transcript/chat-transcript';
import { FilePreview } from './chat/file-preview/file-preview';
import { InteractionPanel } from './chat/interaction-panel/interaction-panel';
import { BottomPanel } from './chat/bottom-panel/bottom-panel';
import { TabStrip } from './chat/tab-strip/tab-strip';
import { GitPanel } from './git/git-panel';
import { AnimationService } from './core/animation.service';
import { AttachmentStore } from './core/attachments';
import { DropZone } from './core/drop-zone';
import { MorseService } from './core/morse.service';
import { PanelState } from './core/panel-state';
import { ShellState } from './core/shell-state';
import { WorkspaceTabs } from './core/workspace-tabs';
import { WorkbenchPersistence } from './core/workbench-persistence';
import { EnterDirective } from './shared/enter.directive';
import { SessionNav } from './nav/session-nav/session-nav';
import { ProjectPicker } from './nav/project-picker/project-picker';
import { AboutDialog } from './about/about-dialog';
import { ShortcutsDialog } from './shortcuts/shortcuts-dialog';
import { CommandPalette } from './palette/command-palette';
import { ShortcutService } from './core/shortcuts';
import { ConfirmDialog } from './shared/confirm-dialog';
import { AgentScreen } from './agent/agent-screen';

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
    SessionNav,
    ProjectPicker,
    AboutDialog,
    ShortcutsDialog,
    CommandPalette,
    AgentScreen,
    ConfirmDialog,
    ChatHeader,
    ChatTranscript,
    InteractionPanel,
    ChatComposer,
    TabStrip,
    BottomPanel,
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
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly panel = inject(PanelState);
  private readonly tabs = inject(WorkspaceTabs);
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
   */
  protected readonly bottomPanelEnabled = computed(
    () => this.morse.capabilities()?.terminal === true,
  );
  /**
   * Full-screen bottom panel: the panel takes the whole chat column and the
   * conversation behind it steps aside, the way the git panel's full mode does.
   */
  protected readonly bottomPanelFull = computed(
    () => this.bottomPanelEnabled() && this.panel.full(),
  );
  /**
   * The browser host's git panel: history and graph for the active project. VS
   * Code advertises no `gitPanel` and keeps its own Source Control view.
   */
  protected readonly gitEnabled = computed(() => this.morse.capabilities()?.gitPanel === true);
  /** The panel is a layout column, so it is only mounted (and refreshed) when shown. */
  protected readonly gitOpen = computed(() => this.gitEnabled() && this.shell.gitPanelOpen());
  /** Expanded: the git view spans the conversation area instead of the sidebar. */
  protected readonly gitExpanded = computed(
    () => this.gitOpen() && this.shell.gitPanelExpanded(),
  );
  /**
   * The dragged width of the git panel, handed to the shell as its CSS variable.
   * `null` (never dragged) leaves the default from `styles.css` in charge.
   */
  protected readonly gitWidth = computed(() => {
    const width = this.shell.gitPanelWidth();
    return width === undefined ? null : `${width}px`;
  });
  /** The file the strip is showing, or `undefined` when a session tab is in front. */
  protected readonly activeFile = computed(() => {
    const tab = this.tabs.activeTab();
    return tab?.kind === 'file' ? tab : undefined;
  });
  /** The last session the strip brought forward, so a redraw does not re-focus it. */
  private focusedSession: string | undefined;
  protected readonly projectPickerOpen = this.shell.projectPickerOpen;
  protected readonly aboutOpen = this.shell.aboutOpen;
  protected readonly shortcutsOpen = this.shell.shortcutsOpen;
  protected readonly paletteOpen = this.shell.paletteOpen;
  protected readonly navigationCollapsed = this.shell.navigationCollapsed;
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
  private readonly autoDismiss = effect(() => {
    const notice = this.toast();
    this.clearNoticeTimer();
    if (!notice) {
      return;
    }
    const ttl = notice.level === 'warn' || notice.level === 'error' ? 6_000 : 3_200;
    this.noticeTimer = setTimeout(() => this.dismissedNoticeAt.set(notice.at), ttl);
  });

  constructor() {
    // The browser host persists the shell layout (open/focused tabs, panel and
    // terminals). Constructing the service loads what the reader had open and
    // starts watching for changes worth saving; the VS Code host advertises no
    // such capability and the service stays inert there.
    inject(WorkbenchPersistence);
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

  /** Bring the full-screen connection help back after it was dismissed. */
  protected showConnectionHelp(): void {
    this.connectionDismissed.set(false);
  }

  /** Point the browser host at another server (`?server=…`) and reload into it. */
  protected onConnectionConnect(url: string): void {
    if (typeof location === 'undefined') {
      return;
    }
    const next = new URL(location.href);
    next.searchParams.set('server', url);
    location.href = next.toString();
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
  private readonly liveDropzone = effect(() => {
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
