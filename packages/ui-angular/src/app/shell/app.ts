import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import type { ChildSessionRef } from '@morse/protocol';
import { BootSplash } from '../features/boot-splash/boot-splash';
import { ConnectionScreen } from '../features/connection-screen/connection-screen';
import { ChatComposer } from '../features/composer/composer';
import { EmptySession } from '../features/empty/empty';
import { McpPanel } from '../features/mcp-panel/mcp-panel';
import { McpEditor } from '../features/mcp-editor/mcp-editor';
import type { PromptEditor } from '../features/prompt-editor/prompt-editor';
import type { AccessPanel } from '../features/access/access-panel';
import type { GpgPanel } from '../features/gpg/gpg-panel';
import type { GitIdentityPanel } from '../features/git-identity/git-identity-panel';
import { ChatTranscript } from '../features/transcript/transcript';
import { FilePreview } from '../features/file-preview/file-preview';
import { InteractionPanel } from '../features/interaction/interaction';
import { BottomPanel } from '../features/bottom-panel/bottom-panel';
import { PiUi } from '../features/pi-ui/pi-ui';
import { TaskOverlay } from '../features/tasks/tasks';
import { TabStrip } from '../features/tab-strip/tab-strip';
import { GitPanel } from '../features/git-panel/git-panel';
import { SearchPanel } from '../features/search-panel/search-panel';
import { ActivityRail } from '../features/activity-rail/activity-rail';
import { AdminPanel } from '../features/admin/admin-panel';
import { ProvidersPanel } from '../features/providers/providers-panel';
import { AuthScreen } from '../features/auth/auth-screen';
import { AuthState } from '../host/auth-state';
import { FileExplorer } from '../features/file-explorer/file-explorer';
import { Splitter } from '../ui/splitter/splitter';
import { AnimationService } from '../ui/animation.service';
import { AttachmentStore } from '../state/attachments';
import { LayoutState } from '../state/layout-state';
import { StatusBar } from './status-bar/status-bar';
import { Toolbar } from './toolbar/toolbar';
import { DropZone } from '../ui/drop-zone';
import { MorseService } from '../host/morse.service';
import { RunNotifier } from '../services/run-notifier';
import { RunClock } from '../services/run-clock';
import { NotificationPrefs } from '../state/notification-prefs';
import { PanelState } from '../state/panel-state';
import { ModePrefs, type ShellMode } from '../state/mode-prefs';
import { RestoreState } from '../state/restore-state';
import { QueuedPrompts } from '../state/queued-prompts';
import { ShellState, type LeftPane } from '../state/shell-state';
import { WorkspaceTabs, type WorkspaceTab } from '../state/workspace-tabs';
import { WorkbenchPersistence } from '../services/workbench-persistence';
import { QueueDrain } from '../services/queue-drain';
import { ComposerSync } from '../services/composer-sync';
import { EnterDirective } from '../ui/enter.directive';
import { SessionNav } from '../features/session-nav/session-nav';
import { SettingsNav } from '../features/settings-nav/settings-nav';
import { BotNav } from '../features/bot-nav/bot-nav';
import { BotChat } from '../features/bot-chat/bot-chat';
import { BotWizard } from '../features/bot-wizard/bot-wizard';
import { BotGroupDialog } from '../features/bot-group-dialog/bot-group-dialog';
import { ProjectPicker } from '../features/project-picker/project-picker';
import { AboutDialog } from '../features/about/about-dialog';
import { ShortcutsDialog } from '../features/shortcuts-dialog/shortcuts-dialog';
import { CommandPalette } from '../features/command-palette/command-palette';
import { ShortcutService } from '../services/shortcut.service';
import { ShortcutKeys } from '../ui/shortcut-keys';
import { OverlayEscape } from '../ui/overlay-escape';
import { SelectionFocusDirective } from '../ui/selection-focus.directive';
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

/** A child the conversation in front spawned, as the subagent strip lists it. */
interface SubagentEntry extends ChildSessionRef {
  title: string;
  /** Still working; a finished child stays listed with a check instead. */
  running: boolean;
  /** When the child last changed, to order the strip newest-first. */
  at: number;
}

@Component({
  selector: 'app-root',
  imports: [
    Toolbar,
    StatusBar,
    SessionNav,
    SettingsNav,
    BotNav,
    BotChat,
    BotWizard,
    BotGroupDialog,
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
    SearchPanel,
    ActivityRail,
    AdminPanel,
    ProvidersPanel,
    AuthScreen,
    FileExplorer,
    Splitter,
    EnterDirective,
    SelectionFocusDirective,
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
  protected readonly auth = inject(AuthState);
  private readonly modePrefs = inject(ModePrefs);
  /**
   * The shell steps aside for login while the host has no user for this
   * connection (multi-user only; single-user hosts never set it).
   */
  protected readonly needsAuth = computed(() => this.auth.needsAuth());
  protected readonly authLoading = computed(() => this.auth.status() === null);
  /**
   * Which product the window is in. Code is the shell as it has always been;
   * Bot swaps the sidebar for the roster and the conversation column for the bot
   * chat. The toolbar only reports a click — the switch itself is here, so the
   * two columns can never show different modes.
   *
   * It starts on the tab the reader left (`ModePrefs`), and every switch goes
   * through `setMode` so that choice is the one a reload comes back to.
   */
  readonly mode = signal<ShellMode>(this.modePrefs.mode());
  private readonly morse = inject(MorseService);
  private readonly restore = inject(RestoreState);
  private readonly shell = inject(ShellState);
  /**
   * Host settings (Members and Providers) are an admin surface. On a single-user
   * host `user` is null and there are no roles, so settings stay available; on a
   * multi-user host only an admin may see them. A persisted tab from a previous
   * admin login must never render a page for the regular user now signed in.
   */
  protected readonly settingsAllowed = computed(
    () => this.morse.user() === null || this.morse.user()?.role === 'admin',
  );
  /**
   * The Access page is self-service: every signed-in member manages their own
   * keys, and single-user hosts (`user` null) manage the host's own. Admin
   * pages (Members, Providers) stay behind `settingsAllowed` above.
   */
  protected readonly accessAllowed = computed(() => !this.needsAuth());
  /**
   * Bot definitions are managed by admins only (same rule as Settings above):
   * a persisted editor tab from a previous admin login must never render the
   * wizard's form for the regular user now signed in. The host refuses the
   * mutation itself — this only hides the form.
   */
  protected readonly botManageAllowed = computed(
    () => this.morse.user() === null || this.morse.user()?.role === 'admin',
  );
  protected readonly activeSettingsPage = computed(() => {
    const tab = this.tabs.activeTab();
    if (tab?.kind !== 'settings') {
      return undefined;
    }
    // Self-service: any signed-in member (or a single-user host) sees Access.
    if (tab.page === 'access' || tab.page === 'gpg' || tab.page === 'git') {
      return this.accessAllowed() ? tab.page : undefined;
    }
    if (!this.settingsAllowed()) {
      return undefined;
    }
    if (tab.page === 'members' && this.auth.status()?.multiuser !== true) {
      return undefined; // Single-user hosts have no Members page.
    }
    return tab.page;
  });
  /** Bot mode's panes: one chat per open room, one editor per open form. */
  protected readonly botTabs = computed(() =>
    this.tabs.tabs().filter(
      (tab): tab is Extract<WorkspaceTab, { kind: 'bot' | 'bot-editor' }> =>
        tab.kind === 'bot' || tab.kind === 'bot-editor',
    ),
  );
  private readonly layout = inject(LayoutState);
  private readonly panel = inject(PanelState);
  protected readonly tabs = inject(WorkspaceTabs);
  private readonly queue = inject(QueuedPrompts);
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
   * The floating composer (and anything docked with it). Measured, not guessed: the
   * transcript reserves this much at its end, so the last message clears the glass
   * slab no matter how tall the box grows — attachments, a queued card, a long draft.
   */
  private readonly dockElement = viewChild<ElementRef<HTMLElement>>('dock');
  protected readonly dockHeight = signal(0);
  /**
   * The browser host's tab strip (sessions + file previews). Gated on the host's
   * own capability, so VS Code — which has an editor already — stays as it was.
   */
  protected readonly tabsEnabled = computed(() => this.morse.capabilities()?.filePreview === true);
  /**
   * The left column's Files face: the same capability that draws the tab strip and
   * the Explorer. A host without it keeps one face, the session list, and no rail.
   */
  protected readonly filesEnabled = computed(() => {
    const capabilities = this.morse.capabilities();
    return capabilities?.hostKind === 'server' && capabilities.filePreview === true;
  });
  /**
   * The face the column shows: no files view means the list, whatever was
   * stored — except settings, which needs no file preview to configure.
   */
  protected readonly leftPane = computed<LeftPane>(() => {
    const pane = this.shell.leftPane();
    return pane === 'files' && !this.filesEnabled() ? 'sessions' : pane;
  });
  private readonly filesSeen = signal(false);
  /**
   * The Explorer mounts on the first Files selection and then stays mounted, hidden
   * behind the session list: its expanded folders, filter and scroll have to survive
   * a swap back, and a reader who never opens Files never pays for the tree.
   */
  protected readonly filesMounted = computed(
    () => this.filesEnabled() && (this.leftPane() === 'files' || this.filesSeen()),
  );
  /**
   * The rail picks which code-mode list the column shows, so bot mode — which
   * owns the column whole — stands it down rather than leaving a switch whose
   * faces are not rendered.
   */
  protected readonly railVisible = computed(
    () => this.filesEnabled() && !this.embedded() && this.mode() === 'code',
  );
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
    () => this.bottomPanelEnabled() && !this.tabs.noSessionInFront() && this.mode() === 'code',
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
  /**
   * The panel is a layout column, so it is only mounted (and refreshed) when shown.
   * The column holds one face at a time: `rightPane` says which (the git panel
   * or the search panel), so this is "the column is open *and* git holds it".
   */
  protected readonly gitOpen = computed(
    () =>
      this.mode() === 'code' &&
      this.gitEnabled() &&
      this.layout.rightVisible() &&
      !this.tabs.noSessionInFront() &&
      this.shell.rightPane() === 'git',
  );
  protected readonly gitExpanded = computed(() => this.gitOpen() && this.shell.gitPanelExpanded());
  /**
   * The browser host's Find in Files: a modal over the app,
   * not a layout column. The same gate the search column had — the host can
   * grep (`capabilities.searchPanel`) and a session is in front to name the
   * project; VS Code advertises neither and keeps its own Search view.
   */
  protected readonly findFilesOpen = computed(
    () =>
      this.mode() === 'code' &&
      this.morse.capabilities()?.searchPanel === true &&
      !this.tabs.noSessionInFront() &&
      this.shell.findFilesOpen(),
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
  /** The file the strip is showing, or `undefined` when a session tab is in front. */
  protected readonly activeFile = computed(() => {
    const tab = this.tabs.activeTab();
    return tab?.kind === 'file' ? tab : undefined;
  });
  /** The MCP editor is in front, so the panel shows it instead of a conversation. */
  protected readonly activeMcp = computed(() => this.tabs.activeTab()?.kind === 'mcp');
  /** The full-page prompt-template editor is up (the browser host's toggle). */
  protected readonly promptEditorOpen = this.shell.promptEditorOpen;
  /**
   * No session tab is in front, on the host that shows the strip. The panel shows
   * a placeholder instead of a conversation that does not exist, and the composer
   * is not mounted at all — a prompt typed with no session used to silently open
   * one. The shared signal lives on `WorkspaceTabs` so the header reads it too.
   */
  protected readonly noSessionSelected = this.tabs.noSessionInFront;
  /**
   * A saved session is still travelling back: the workbench restore has started
   * and the front tab is either not decided yet or a real (non-draft) session
   * whose transcript has not arrived. The panel shows a loading screen instead
   * of the welcome — an empty-looking panel reads as a fresh session, and a
   * prompt typed into it would race the restore. A restored draft, file or MCP
   * tab is already what the reader left, so it shows immediately.
   */
  protected readonly restoringSession = computed(() => {
    if (!this.restore.isRestoring()) {
      return false;
    }
    const tab = this.tabs.activeTab();
    return tab === undefined || (tab.kind === 'session' && tab.draft !== true);
  });
  /**
   * The session in front is a subagent: watched read-only. The dock stays
   * unmounted (nothing to prompt a subagent with — its parent steers it), and a
   * slim bar offers the way back to the conversation that spawned it.
   */
  protected readonly activeIsSubagent = this.morse.activeIsSubagent;
  protected readonly activeParent = this.morse.parentOfActive;

  /**
   * The subagents the conversation in front spawned, for the strip above its
   * composer. Finished children stay in it — otherwise the strip vanishes the
   * moment the last run settles, exactly when the reader is looking for which
   * agent finished. A child has no process of its own: the host marks it
   * streaming while its spawning tool row runs — or, for an engine whose
   * subagents run on in the background, until the engine reports the child
   * idle — and the transcript fills in a child the catalog has not listed yet
   * and names the agent running it.
   */
  protected readonly subagents = computed<SubagentEntry[]>(() => {
    const parentId = this.morse.state().sessionId;
    if (parentId === undefined || this.activeIsSubagent()) {
      return [];
    }
    const activity = this.morse.sessionActivity();
    const state = this.morse.state();
    const parentRunning =
      activity.get(parentId)?.streaming === true ||
      (state.sessionId === parentId && state.streaming === true);
    // A child that is only in the catalog (OpenCode reports it there before its
    // tool row learns the id) is working while its parent runs and it is newer
    // than the prompt that started this turn. Without the age cut a child that
    // finished in an earlier turn and never linked a row would spin forever.
    const lastPromptAt = this.morse
      .items()
      .filter((item) => item.kind === 'user')
      .reduce((latest, item) => Math.max(latest, item.at), 0);
    const rows = new Map<string, SubagentEntry>();
    for (const session of this.morse.sessions()) {
      if (session.subagent === true && session.parentId === parentId) {
        rows.set(session.id, {
          sessionId: session.id,
          title: session.title,
          running:
            activity.get(session.id)?.streaming === true ||
            (parentRunning && session.updatedAt >= lastPromptAt),
          at: session.updatedAt,
        });
      }
    }
    for (const item of this.morse.items()) {
      if (item.kind !== 'tool' || item.child === undefined) {
        continue;
      }
      const known = rows.get(item.child.sessionId);
      rows.set(item.child.sessionId, {
        ...item.child,
        title: known?.title ?? item.title,
        // The tool row knows a just-ended child before the activity does; the
        // activity knows a background child still running after its row closed.
        running:
          item.status === 'running' || activity.get(item.child.sessionId)?.streaming === true,
        at: known?.at ?? item.at,
      });
    }
    return [...rows.values()].sort((a, b) => Number(b.running) - Number(a.running) || b.at - a.at);
  });

  /** How many of them are still working, for the trigger's "2/5". */
  protected readonly runningSubagentCount = computed(
    () => this.subagents().filter((child) => child.running).length,
  );
  /** The compact list above the composer is open. */
  protected readonly subagentsOpen = signal(false);

  protected toggleSubagents(): void {
    this.subagentsOpen.update((open) => !open);
  }

  /** Opens one child from the list and folds the list away. */
  protected pickSubagent(child: SubagentEntry): void {
    this.subagentsOpen.set(false);
    this.openSubagent(child);
  }

  /** Stops a child from the parent's panel, without switching conversations. */
  protected stopSubagent(child: SubagentEntry): void {
    const parentId = this.morse.state().sessionId;
    if (parentId !== undefined) {
      this.morse.stopSubagent(child.sessionId, parentId);
    }
  }

  /**
   * Opens a spawned session from its tool row: swaps the panel to the child's
   * transcript. The catalog is refreshed first (fire and forget) because a child
   * created mid-run is often not in the list yet, and the read-only flag and the
   * back link both read from that list.
   */
  protected openSubagent(child: ChildSessionRef): void {
    // Remembered for the watching bar: OpenCode's `task` names the agent that
    // runs the child (explore, general, …), and the bar labels the view with it.
    this.childAgent.set(child.agent);
    this.morse.requestSessions();
    this.morse.activateSession(child.sessionId);
  }

  /** The agent the watched child runs as, when its spawning tool named one. */
  private readonly childAgent = signal<string | undefined>(undefined);

  /** Back from a watched subagent to the conversation that spawned it. */
  protected backToParent(): void {
    const parent = this.activeParent();
    if (parent !== undefined) {
      this.morse.activateSession(parent.id);
    }
  }

  /**
   * Pulls the watched session's transcript while it is on screen. A subagent is
   * written by its parent's process, so the view ages in place; the host skips
   * identical pages, so the poll is quiet until something actually landed.
   * Paused while this panel's own gateway is streaming — a live child needs no
   * pull, and resetting its transcript mid-run would fight the stream.
   */
  private subagentTimer: ReturnType<typeof setInterval> | undefined;
  private static readonly SUBAGENT_POLL_MS = 10_000;
  /**
   * Pi's extension chrome is worth mounting only while an extension has set a
   * widget or status for the session in front; an empty host stays out of the
   * layout entirely.
   */
  protected readonly piUiVisible = computed(() => {
    const state = this.morse.state();
    return (state.widgets?.length ?? 0) + (state.statuses?.length ?? 0) > 0;
  });
  /** The group dialog is still a shell-level overlay; the bot editor is a tab. */
  protected readonly botGroupOpen = this.morse.ui.groupOpen;

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
      return !this.notifications.enabled() && !this.notifications.bannerDismissed()
        ? 'nudge'
        : null;
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
  /**
   * The Access page is code-split like the prompt editor: its class arrives
   * from a dynamic import only while its tab is in front, keeping it out of
   * the initial bundle.
   */
  protected readonly accessComponent = signal<typeof AccessPanel | null>(null);
  private accessClass: typeof AccessPanel | null = null;
  private accessLoading = false;
  /**
   * The GPG page is code-split the same way: out of the initial bundle until
   * its own settings tab is in front.
   */
  protected readonly gpgComponent = signal<typeof GpgPanel | null>(null);
  private gpgClass: typeof GpgPanel | null = null;
  private gpgLoading = false;
  /**
   * The Git identity page is code-split the same way: out of the initial
   * bundle until its own settings tab is in front.
   */
  protected readonly gitComponent = signal<typeof GitIdentityPanel | null>(null);
  private gitClass: typeof GitIdentityPanel | null = null;
  private gitLoading = false;
  protected readonly projectPickerOpen = this.shell.projectPickerOpen;
  protected readonly aboutOpen = this.shell.aboutOpen;
  protected readonly shortcutsOpen = this.shell.shortcutsOpen;
  protected readonly mcpOpen = this.shell.mcpOpen;
  protected readonly paletteOpen = this.shell.paletteOpen;
  protected readonly navigationCollapsed = this.layout.leftCollapsed;
  protected readonly compactConfirmOpen = this.shell.compactConfirmOpen;
  protected readonly stopConfirmOpen = this.shell.stopConfirmOpen;
  /**
   * The question, with the user's own instructions echoed back when they typed
   * `/compact <instructions>` — the dialog is the last place to catch a mistake.
   */
  protected readonly compactBody = computed(() => {
    const base =
      'pi replaces the conversation it is holding with a summary, so the next turn starts from less context. The transcript in this window is untouched.';
    const instructions = this.shell.compactInstructions();
    return instructions ? `${base} Your instructions: “${instructions}”.` : base;
  });
  /**
   * "Schedule Compact" is only a real choice while the conversation is working:
   * pi compacts by aborting the run in flight, so a session that is already quiet
   * has nothing to wait for and the ordinary yes is the honest button. Empty label
   * hides the choice (the dialog renders it only when it has one).
   *
   * The conversation pinned when the question opened is the one that answers — a
   * tab switched while the dialog was up must not borrow another session's run.
   * With no pin (the shared panel) the conversation in front answers.
   */
  protected readonly compactScheduleLabel = computed(() => {
    const key = this.shell.compactSessionKey();
    const activity = key === undefined ? undefined : this.morse.sessionActivity().get(key);
    const working = activity ? activity.streaming : this.morse.state().streaming;
    return working ? 'Schedule Compact' : '';
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
  /** The failure text the reader dismissed, so the banner stays gone for it. */
  private readonly dismissedAgentError = signal<string | undefined>(undefined);
  protected readonly agentBanner = computed(
    () =>
      this.agentBlocked() &&
      !this.agentScreen() &&
      this.agentError() !== this.dismissedAgentError(),
  );
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

  /**
   * The toolbar's Code/Bot switch. The one place the mode changes, so the choice
   * is written down for the next visit (`ModePrefs`) and the two columns cannot
   * disagree about which product they are in.
   */
  protected setMode(mode: ShellMode): void {
    this.mode.set(mode);
    this.modePrefs.setMode(mode);
    this.tabs.setMode(mode);
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
    // The shell owns the mode; the tab store only needs to know which half of
    // its one strip to show. Keeping this as an effect also covers a mode set
    // straight on the signal (tests, a restored preference) without a second
    // call site that could forget to switch the strip.
    this.tabs.setMode(this.mode());
    effect(() => this.tabs.setMode(this.mode()));
    // A regular user must never inherit an admin's open admin pages. Tabs are
    // restored from the host workbench before the handshake names the user, so
    // drop them as soon as we know this connection is not an admin. The pages
    // themselves are gated by `settingsAllowed()` too, so the drop is defense in
    // depth against a stale tab surviving a reload. Access is self-service and
    // stays: it is every member's own keys, not an admin surface.
    effect(() => {
      if (!this.settingsAllowed() && this.tabs.hasAdminSettingsTabs()) {
        this.tabs.dropAdminSettingsTabs();
      }
    });
    // A provider changed on this host (here or in another window): re-read the
    // model catalog so every active client's picker offers the new models at
    // once, without a refresh or a restart.
    this.destroyRef.onDestroy(
      this.morse.onProvidersChanged(() => this.morse.refreshModels()),
    );
    // A dismissed failure comes back when the agent has a new one to report:
    // clearing it resets the dismissal, so only the exact text stays hidden.
    effect(() => {
      if (this.agentError() === undefined) {
        this.dismissedAgentError.set(undefined);
      }
    });
    // Once Files has been opened, it stays mounted (hidden) so its tree, filter and
    // scroll survive a swap back to the session list.
    effect(() => {
      const files = this.leftPane() === 'files';
      untracked(() => {
        if (files) {
          this.filesSeen.set(true);
        }
      });
    });
    // Pull the watched subagent's transcript while it is on screen: the child
    // is written by its parent's process, so the view ages in place. The host
    // skips identical pages, so the poll is quiet until something landed, and
    // it pauses while this panel's own gateway streams — a live child needs no
    // pull, and resetting its transcript mid-run would fight the stream.
    effect(() => {
      const watching = this.activeIsSubagent() && !this.morse.running();
      if (watching && this.subagentTimer === undefined) {
        this.subagentTimer = setInterval(() => {
          if (this.activeIsSubagent() && !this.morse.running()) {
            this.morse.refreshSession();
          }
        }, App.SUBAGENT_POLL_MS);
      } else if (!watching && this.subagentTimer !== undefined) {
        clearInterval(this.subagentTimer);
        this.subagentTimer = undefined;
      }
    });
    this.destroyRef.onDestroy(() => {
      if (this.subagentTimer !== undefined) {
        clearInterval(this.subagentTimer);
        this.subagentTimer = undefined;
      }
    });
    // The queue drain is shell state too: a queued follow-up must run when its
    // own session settles, even if the reader is looking at another tab.
    inject(QueueDrain);
    // And so is the run clock: it anchors a run when the host reports it, so
    // leaving the conversation for a file or the bot column never loses the time.
    inject(RunClock);
    // The shared composer: the queue and relayed draft arrive even while the
    // composer is unmounted (a file tab, the bot column), so the store is alive
    // for the whole shell.
    inject(ComposerSync);
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
      this.shortcuts.bind(
        'context.compact',
        () => this.shell.requestCompact(undefined, this.tabs.composerKey()),
        () => this.mode() === 'code' && this.morse.state().agentReady,
      ),
      this.shortcuts.bind('help.shortcuts', () => this.shell.toggleShortcuts()),
      // The palette's open flag is shell state (so `modalOpen` is honest and the
      // overlay renders from one place), so its key is bound here like the help's.
      // Its commands are code-mode ones, so bot mode does not answer the key.
      this.shortcuts.bind(
        'command.palette',
        () => this.shell.togglePalette(),
        () => this.mode() === 'code',
      ),
      // A Morse surface, not a pi command: it opens the full-page editor
      // (browser) or the host's own editor panel (VS Code). Unavailable where
      // the host cannot read pi's prompt directories.
      this.shortcuts.bind(
        'view.prompts',
        () => this.openPromptEditor(),
        () => this.mode() === 'code' && this.morse.capabilities()?.promptEditor === true,
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
      if (this.morse.connectionDetail() === 'login required') {
        void this.auth.refresh();
      }
    });
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
    /*
     * The transcript reserves the dock's height at its end, so the last message is
     * never behind the glass. It is measured, not a CSS constant: the box grows
     * with a long draft or an attachments row, and a fixed pad would be wrong by
     * exactly the amount that matters — the bottom of the answer.
     */
    effect((onCleanup) => {
      const dock = this.dockElement()?.nativeElement;
      if (!dock || typeof ResizeObserver === 'undefined') {
        this.dockHeight.set(0);
        return;
      }
      const observer = new ResizeObserver(() => {
        this.dockHeight.set(Math.round(dock.getBoundingClientRect().height));
      });
      observer.observe(dock);
      onCleanup(() => observer.disconnect());
    });
    // A stop question is only ever about the run that was in flight when it was
    // asked. A fast answer can settle before the reader confirms, leaving the
    // dialog guarding a run that no longer exists — and confirming it would abort
    // whatever run comes next. So the question retracts itself the moment that run
    // ends, exactly like the stop button it stands in for.
    effect(() => {
      if (!this.morse.state().streaming) {
        this.shell.closeStopPrompt();
      }
    });
    // A compact question is about one conversation, pinned when it opened. If that
    // conversation closes while the dialog is still up, the question no longer has a
    // subject: confirming it would fail against a dead session (the host refuses a
    // pinned key it no longer holds) when the honest answer is that there is nothing
    // left to compact. So it retracts itself.
    //
    // "Closed" means the key vanished from a live set that once held it. A host that
    // has not reported activity at all says nothing about the key, so the empty set
    // only counts as proof of closure once some activity has actually arrived —
    // otherwise a question over a still-open session would be taken down on startup.
    // The loud refusal on confirm stays the backstop for hosts that never report.
    let reportedActivity = false;
    effect(() => {
      const key = this.shell.compactSessionKey();
      const live = this.morse.sessionActivity();
      if (key === undefined) {
        return;
      }
      if (live.size === 0 && !reportedActivity) {
        return;
      }
      reportedActivity = true;
      if (!live.has(key)) {
        this.shell.closeCompactPrompt();
      }
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
          this.animation.loop(
            ring,
            { scale: [1, 1.035], opacity: [0.9, 0.25] },
            { duration: 1100 },
          ),
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
    // A session the host no longer has cannot keep a tab. Sessions leave the
    // host's list when closed or deleted from another surface, and where there is
    // no strip (VS Code) the reader has no way to close the orphan tab themselves.
    // Gated on the first `session/list`: before it the list is empty because it has
    // not been sent, not because nothing is open.
    effect(() => {
      if (!this.morse.sessionsLoaded()) {
        return;
      }
      this.tabs.reconcileSessions(this.morse.sessions());
    });
    // Load the prompt editor only while the full-page editor is up. A lazy
    // `import()` keeps its template and cheat sheet in their own chunk, unlike
    // `@defer`, whose runtime would ride in the initial bundle instead.
    effect(() => {
      if (!this.promptEditorOpen()) {
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
    // Load the Access page only while its settings tab is in front.
    effect(() => {
      if (this.activeSettingsPage() !== 'access') {
        this.accessComponent.set(null);
        return;
      }
      if (this.accessClass !== null) {
        this.accessComponent.set(this.accessClass);
        return;
      }
      void this.loadAccess();
    });
    // Load the GPG page only while its settings tab is in front.
    effect(() => {
      if (this.activeSettingsPage() !== 'gpg') {
        this.gpgComponent.set(null);
        return;
      }
      if (this.gpgClass !== null) {
        this.gpgComponent.set(this.gpgClass);
        return;
      }
      void this.loadGpg();
    });
    // Load the Git identity page only while its settings tab is in front.
    effect(() => {
      if (this.activeSettingsPage() !== 'git') {
        this.gitComponent.set(null);
        return;
      }
      if (this.gitClass !== null) {
        this.gitComponent.set(this.gitClass);
        return;
      }
      void this.loadGit();
    });
  }

  private async loadAccess(): Promise<void> {
    if (this.accessLoading) {
      return;
    }
    this.accessLoading = true;
    try {
      const { AccessPanel: Panel } = await import('../features/access/access-panel');
      this.accessClass = Panel;
      if (this.activeSettingsPage() === 'access') {
        this.accessComponent.set(Panel);
      }
    } finally {
      this.accessLoading = false;
    }
  }

  private async loadGpg(): Promise<void> {
    if (this.gpgLoading) {
      return;
    }
    this.gpgLoading = true;
    try {
      const { GpgPanel: Panel } = await import('../features/gpg/gpg-panel');
      this.gpgClass = Panel;
      if (this.activeSettingsPage() === 'gpg') {
        this.gpgComponent.set(Panel);
      }
    } finally {
      this.gpgLoading = false;
    }
  }

  private async loadGit(): Promise<void> {
    if (this.gitLoading) {
      return;
    }
    this.gitLoading = true;
    try {
      const { GitIdentityPanel: Panel } = await import('../features/git-identity/git-identity-panel');
      this.gitClass = Panel;
      if (this.activeSettingsPage() === 'git') {
        this.gitComponent.set(Panel);
      }
    } finally {
      this.gitLoading = false;
    }
  }

  private async loadPromptEditor(): Promise<void> {
    if (this.promptEditorLoading) {
      return;
    }
    this.promptEditorLoading = true;
    try {
      const { PromptEditor: Editor } = await import('../features/prompt-editor/prompt-editor');
      this.promptEditorClass = Editor;
      if (this.promptEditorOpen()) {
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
   * Opens the prompt-template editor: a full-page editor on a host with a Morse
   * tab strip, the host's own editor panel where there is none (VS Code). The
   * host branch lives on `WorkspaceTabs`, so the toolbar button takes the same
   * path.
   */
  protected openPromptEditor(): void {
    this.tabs.openPromptEditor();
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
   *
   * The session key pinned when the question opened rides along, so a dialog asked
   * over session A cannot compact session B just because the reader switched tabs
   * while it was up — compaction rewrites what pi remembers, and it must rewrite the
   * conversation the question was about.
   */
  protected confirmCompact(): void {
    const instructions = this.shell.compactInstructions();
    const sessionKey = this.shell.compactSessionKey();
    this.shell.closeCompactPrompt();
    this.morse.compactSession(instructions, sessionKey);
  }

  protected cancelCompact(): void {
    this.shell.closeCompactPrompt();
  }

  /**
   * The reader keeps the run (and the follow-ups queued behind it): the dialog
   * steps aside and the compaction joins the queue, where it can be dragged
   * before or after those follow-ups — or removed — until it runs. The same pin
   * as `confirmCompact`, for the same reason: the question is about one
   * conversation, whatever tab is in front by the time it is answered.
   */
  protected scheduleCompact(): void {
    const instructions = this.shell.compactInstructions();
    const sessionKey = this.shell.compactSessionKey() ?? this.tabs.composerKey();
    this.shell.closeCompactPrompt();
    this.queue.enqueueCompaction(instructions, sessionKey);
  }

  /**
   * The user said yes: the dialog steps aside, then the host aborts the run.
   * Closing first mirrors `confirmCompact` — no stale question over a request
   * already in flight, and the abort's own UI updates are not competing with it.
   *
   * The streaming check is the second half of the race guard: the dialog retracts
   * itself when the run ends (the effect above), but a confirm and the run settling
   * can still land on the same tick, so this drops a yes that has nothing left to
   * stop. Aborting an idle session would be a no-op at best and could cut a run the
   * reader started after the question was asked.
   */
  protected confirmStop(): void {
    this.shell.closeStopPrompt();
    if (!this.morse.state().streaming) {
      return;
    }
    this.morse.abort();
  }

  protected cancelStop(): void {
    this.shell.closeStopPrompt();
  }

  protected closeNavigation(): void {
    this.shell.closeNavigation();
  }

  /**
   * The scrim's job: whatever overlay is in front steps aside. On a narrow window
   * the git panel and the navigation drawer are both full-height overlays with a
   * strip of conversation beside them, and that strip is this scrim — so one
   * click has to put away whichever one the reader opened.
   */
  protected closeOverlays(): void {
    this.closeNavigation();
    if (this.gitOpen()) this.layout.setVisible('right', false);
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

  /** Hides the spawn-failure bar without pretending the agent recovered. */
  protected dismissAgentBanner(): void {
    this.dismissedAgentError.set(this.agentError());
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
