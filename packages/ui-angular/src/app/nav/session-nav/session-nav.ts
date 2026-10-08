import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import type { SessionSummary, TranscriptItem } from '@morse/protocol';
import { MorseService } from '../../core/morse.service';
import { ShellState } from '../../core/shell-state';
import { ShortcutService } from '../../core/shortcuts';
import { toolFileName, toolGerund, toolKind, toolTitle } from '@morse/ui-runtime';
import { UpdateCheck } from '../../core/update';
import { WorkspaceTabs } from '../../core/workspace-tabs';
import { FileExplorer } from '../file-explorer/file-explorer';
import { ProjectFilter, type ProjectOption } from '../project-filter/project-filter';

interface SessionGroup {
  path: string;
  name: string;
  sessions: SessionSummary[];
  /** How many of this project's sessions are shown in "In progress" instead. */
  hiddenRunning: number;
}

/** An open session context menu, anchored at the pointer. */
interface SessionMenu {
  x: number;
  y: number;
  session: SessionSummary;
  /** True while the menu is asking for confirmation instead of listing items. */
  confirming: boolean;
}

/**
 * Navigation for both host scopes.
 *
 * - `global` (browser host): projects pi knows about, each with its sessions —
 *   a project sidebar.
 * - `workspace` (VS Code): a single group for the folder the window has open —
 *   multi-project would be a lie there.
 */
@Component({
  selector: 'morse-session-nav',
  imports: [ProjectFilter, FileExplorer],
  templateUrl: './session-nav.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        height: 100%;
        background: var(--morse-nav-bg);
        border-right: 1px solid var(--morse-border);
      }
      .head {
        flex: none;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: var(--morse-head-height);
        padding: 0 10px;
        border-bottom: 1px solid var(--morse-border);
      }
      .head button.primary {
        flex: 1;
        padding: 6px 10px;
      }
      .filters {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px 10px 6px;
      }
      .filters input {
        padding: 6px 9px;
      }
      /*
       * The project button. It replaces the old promise that one search box could
       * find both projects and sessions: that box filtered sessions by title and
       * kept a project whose *name* matched, so the group showed up empty.
       *
       * A normal secondary button, full width — same height as the field under it,
       * same look as Refresh — with the label left-aligned like a chooser rather
       * than centred like an action.
       */
      .scope {
        display: flex;
        align-items: center;
        gap: 6px;
        justify-content: flex-start;
        width: 100%;
      }
      /* An active filter changes what the list means, so it is worth noticing. */
      .scope.filtered {
        border-color: var(--morse-accent);
      }
      .scope-glyph {
        flex: none;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .scope-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
      }
      input {
        width: 100%;
      }
      .empty-action {
        display: block;
        width: calc(100% - 16px);
        margin: 0 8px 6px;
        padding: 4px 8px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-link);
        font-size: 11.5px;
        text-align: left;
        cursor: pointer;
      }
      .empty-action:hover {
        background: var(--morse-hover);
      }
      input {
        width: 100%;
      }
      .list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 6px 8px 12px;
      }
      .pane + .pane {
        margin-top: 12px;
      }
      /*
       * A section heading — "In progress", a project, "Sessions". Uppercase
       * and quiet, with the count trailing: structure without a second toolbar.
       */
      .pane-head {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 7px 5px;
      }
      .pane-title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.07em;
        text-transform: uppercase;
      }
      .pane-count {
        flex: none;
        color: var(--morse-fg-muted);
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
      }
      /*
       * A project header: the fold affordance owns the row (name, session
       * count, chevron at the far right of the title) and the per-project "new
       * session" sits after it as a small plus, so the action lives where the
       * project is named instead of under whichever session happens to be open.
       */
      .group-head {
        display: flex;
        align-items: center;
        gap: 2px;
      }
      .group-title {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
        min-width: 0;
        padding: 5px 6px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        cursor: pointer;
      }
      .group-title:hover:not(:disabled) {
        background: var(--morse-hover);
      }
      .group-title .name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
      }
      .group-title .count {
        flex: none;
      }
      .group-new {
        flex: none;
        padding: 1px 6px 2px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 15px;
        line-height: 1.2;
        cursor: pointer;
      }
      .group-new:hover:not(:disabled),
      .group-new:focus-visible:not(:disabled) {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .group-title .path {
        max-width: 45%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        direction: rtl;
        font-weight: 400;
        text-transform: none;
      }
      .chevron {
        transition: transform 120ms ease;
      }
      .chevron.open {
        transform: rotate(90deg);
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .session {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 8px;
        border: 0;
        border-radius: var(--morse-radius-md);
        background: transparent;
        color: var(--morse-fg);
        text-align: left;
        cursor: pointer;
        transition: background 120ms ease;
      }
      .session:hover {
        background: var(--morse-hover);
      }
      .session.active {
        background: var(--morse-active);
        box-shadow: inset 2px 0 0 var(--morse-accent);
      }
      /* Two lines: the title, and — for a live session — what it is doing now. */
      .session .body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .session .title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12.5px;
        font-weight: 500;
      }
      .session.active .title {
        font-weight: 600;
      }
      .session .subtitle {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .session .meta {
        flex: none;
        font-size: 10.5px;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-variant-numeric: tabular-nums;
      }
      /*
       * The live mark in "In progress": a spinning ring while the agent works,
       * a plain amber dot while a session is still starting or switching. A CSS
       * loop (not anime.js) so it keeps beating in a hidden webview.
       */
      .session .mark {
        flex: none;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--morse-fg-muted);
      }
      .session .mark.running {
        background: transparent;
        border: 1.6px solid color-mix(in srgb, var(--morse-accent) 30%, transparent);
        border-top-color: var(--morse-accent);
        animation: nav-spin 0.8s linear infinite;
      }
      @keyframes nav-spin {
        to {
          transform: rotate(360deg);
        }
      }
      /*
       * The session context menu. Named context-menu, not menu: the shell
       * already ships a .menu for the navigation toggle, and a shared name makes
       * every query (and every future stylesheet) ambiguous.
       */
      .context-menu-layer {
        position: fixed;
        inset: 0;
        z-index: 40;
      }
      .context-menu {
        position: fixed;
        z-index: 41;
        width: 220px;
        max-width: min(280px, 90vw);
        padding: 4px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
      }
      .context-menu-question {
        margin: 3px 7px 0;
        font-size: 11.5px;
        color: var(--morse-fg);
      }
      .context-menu-title {
        margin: 2px 7px 6px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        color: var(--morse-fg-muted);
      }
      .context-menu-item {
        display: block;
        width: 100%;
        padding: 5px 8px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }
      .context-menu-item:hover:not(:disabled),
      .context-menu-item:focus-visible:not(:disabled) {
        background: var(--morse-hover);
      }
      .context-menu-item.danger {
        color: var(--morse-error);
      }
      .empty {
        padding: 8px;
        font-size: 12px;
        color: var(--morse-fg-muted);
      }
      /*
       * Credits sit at the bottom of the sidebar: the one surface both hosts
       * always render, and quiet enough to read as a colophon rather than a
       * button begging to be pressed.
       */
      .foot {
        flex: none;
        padding: 4px 6px 6px;
        border-top: 1px solid var(--morse-border);
      }
      .foot button,
      .foot .notice {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 5px 8px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 11px;
        text-align: left;
        cursor: pointer;
      }
      .foot button:hover {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      /*
       * A newer release, next to the version it is newer than. A link rather than
       * a command: nothing here updates itself, and the hint says what would.
       */
      .foot .notice {
        color: var(--morse-accent);
        text-decoration: none;
      }
      .foot .notice:hover {
        background: var(--morse-hover);
        color: var(--morse-accent);
      }
      .foot .notice .notice-glyph {
        flex: none;
        font-size: 11px;
      }
      .foot .stamp {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: right;
        font-family: var(--morse-font-mono);
        font-size: 10px;
      }
    `,
  ],
})
export class SessionNav {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly shortcuts = inject(ShortcutService);
  private readonly update = inject(UpdateCheck);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly destroyRef = inject(DestroyRef);
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly query = signal('');
  protected readonly collapsed = signal<Record<string, boolean>>({});
  protected readonly menu = signal<SessionMenu | undefined>(undefined);
  /** Which project the list is narrowed to; `''` shows every one of them. */
  protected readonly projectFilter = this.shell.projectFilterPath;
  /**
   * The filter panel's open flag lives in `ShellState`: the shortcut opens it from
   * outside this component, and the shell watches it to know a dialog is up.
   */
  protected readonly filterOpen = this.shell.projectFilterOpen;
  private readonly nativeDialogs = computed(
    () => this.morse.capabilities()?.nativeDialogs === true,
  );
  /**
   * The host can show a session as its own editor tab (VS Code). The row's menu
   * only offers it where that is true: a menu item that does nothing is worse
   * than an absent one.
   */
  protected readonly sessionTabs = computed(
    () => this.morse.capabilities()?.sessionTabs === true,
  );
  protected readonly activeSessionId = computed(() => this.morse.state().sessionId);
  /** The build this host is serving, printed beside the notice it explains. */
  protected readonly version = this.morse.version;
  /** A newer release, when the host allowed the check and the registry confirmed one. */
  protected readonly updateNotice = this.update.available;
  /** A newer pi, when the host could read the one it runs and the registry had it. */
  protected readonly piUpdateNotice = this.update.piAvailable;
  protected readonly sessionActivity = this.morse.sessionActivity;
  protected readonly scope = computed(() => this.morse.capabilities()?.scope ?? 'global');

  /**
   * The browser host's Explorer belongs in the sidebar; VS Code has its own and
   * advertises `filePreview: false`, so this is the one switch for it.
   */
  protected readonly filePreview = computed(
    () => this.morse.capabilities()?.filePreview === true,
  );
  /**
   * No tab is in front, so there is no project to browse: the Explorer stays out
   * of the sidebar instead of showing the last project's tree.
   */
  protected readonly noSessionInFront = this.tabs.noSessionInFront;
  /** The browser host opens a folder modal for "New session" (see ProjectPicker). */
  private readonly directoryPicker = computed(
    () => this.morse.capabilities()?.directoryPicker === true,
  );

  /**
   * What the agent is doing in that session right now. `busy` (a session switch
   * or start in progress) and `starting` are transient but worth showing; an
   * `error` session is not "in progress", it failed and stays in its project.
   */
  /**
   * True only when the agent is producing a turn in that session.
   *
   * Opening a session makes the host spawn its agent, which flips
   * `agentStarting` (and `busy` while it switches) for a beat — but nothing is
   * being worked on, so those must not put a row in "In progress". Only
   * `streaming` means the agent is actually running; a session that is merely
   * open or warm is not.
   */
  protected isRunning(session: SessionSummary): boolean {
    const activity = this.sessionActivity().get(session.id);
    if (activity !== undefined) {
      return activity.streaming;
    }
    // A session opened before its id is known cannot match the activity key yet.
    return session.id === this.activeSessionId() && this.morse.state().streaming;
  }

  /** The "what is happening now" line, for the rows in the In progress section. */
  protected activityLabel(session: SessionSummary): string {
    // An extension dialog blocks that agent until it is answered. Naming it
    // beats a generic "Working…", especially for a background conversation the
    // reader cannot see waiting.
    if (this.sessionActivity().get(session.id)?.needsInput === true) {
      return 'Waiting for your answer';
    }
    // The active session's transcript is the only one this frontend holds, so
    // only it can name the exact step; a background run stays generic.
    if (session.id === this.activeSessionId()) {
      return this.activeStep() ?? 'Working…';
    }
    return 'Working…';
  }

  /** The newest step of the active session, phrased as a status line. */
  private readonly activeStep = computed<string | undefined>(() => {
    const items = this.morse.items();
    const last = items.at(-1);
    return last === undefined ? undefined : actionLabel(last);
  });

  /**
   * Sessions the agent is working in right now, newest first. They move to the
   * top of the sidebar and out of their project, so a long list cannot bury a
   * live run. A project filter narrows this section too — narrowing the sidebar
   * must not leave another project's run pinned at the top.
   */
  protected readonly inProgress = computed<SessionSummary[]>(() => {
    const filter = this.projectFilter();
    return this.morse
      .sessions()
      .filter(
        (session) =>
          (filter.length === 0 || session.cwd === filter) && this.isRunning(session),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });

  protected readonly groups = computed<SessionGroup[]>(() => {
    const sessions = this.morse.sessions();
    if (this.scope() === 'workspace') {
      const workspace = this.morse.workspace();
      const project = this.morse.projects()[0];
      return [
        {
          path: project?.path ?? workspace.cwd,
          name: workspace.name || project?.name || 'workspace',
          sessions,
          hiddenRunning: 0,
        },
      ];
    }
    return this.morse.projects().map((project) => ({
      path: project.path,
      name: project.name,
      sessions: sessions.filter((session) => session.cwd === project.path),
      hiddenRunning: 0,
    }));
  });

  protected readonly visibleGroups = computed<SessionGroup[]>(() => {
    const query = this.query().trim().toLowerCase();
    const filter = this.projectFilter();
    // A session already shown at the top does not repeat inside its project —
    // a live run you can see twice is a list you have to read twice.
    const inProgress = new Set(this.inProgress().map((session) => session.id));
    // The session box asks about session titles only. Project names used to match
    // here too, which showed the project with an empty list under it — `buku` was
    // there, so it looked empty. Finding a project is the chip's job.
    const scoped = filter.length === 0
      ? this.groups()
      : this.groups().filter((group) => group.path === filter);
    return scoped
      .map((group) => {
        const matched =
          query.length === 0
            ? group.sessions
            : group.sessions.filter((session) => session.title.toLowerCase().includes(query));
        const sessions = matched.filter((session) => !inProgress.has(session.id));
        return { ...group, sessions, hiddenRunning: matched.length - sessions.length };
      })
      // A project with no matching session is not a result of a session search…
      .filter((group) => filter.length > 0 || query.length === 0 || group.sessions.length > 0);
  });

  /** The chip sits next to the search box; only a host with many projects needs it. */
  protected readonly filterable = computed(() => this.scope() === 'global');

  /** The projects as the chip's panel lists them, counted the way the list shows. */
  protected readonly projectOptions = computed<ProjectOption[]>(() =>
    this.groups().map((group) => ({
      path: group.path,
      name: group.name,
      sessionCount: group.sessions.length,
    })),
  );

  protected readonly selectedProject = computed(() =>
    this.projectOptions().find((project) => project.path === this.projectFilter()),
  );

  protected readonly totalSessions = computed(() => this.morse.sessions().length);

  /**
   * Projects whose name or path the session query matches. The empty state offers
   * them as a jump, because typing a project name here is a natural mistake and
   * the answer is one click away.
   */
  protected readonly projectMatches = computed<ProjectOption[]>(() => {
    const needle = this.query().trim().toLowerCase();
    if (needle.length === 0 || this.projectFilter().length > 0) {
      return [];
    }
    return this.projectOptions().filter((project) =>
      `${project.name} ${project.path}`.toLowerCase().includes(needle),
    );
  });

  constructor() {
    // Three shortcuts belong to the sidebar, because it owns what they act on:
    // the search field, the project filter, and "New session" — the last one
    // because the button's meaning depends on the host (a global host asks which
    // folder first), and the key has to mean exactly what the button means.
    const unbind = [
      this.shortcuts.bind('session.new', () => this.startSession()),
      this.shortcuts.bind('session.search', () => this.focusSearch()),
      this.shortcuts.bind('project.filter', () => this.openFilterFromKeyboard(), () => this.filterable()),
    ];
    this.destroyRef.onDestroy(() => {
      for (const off of unbind) {
        off();
      }
    });
  }

  protected isCollapsed(path: string): boolean {
    // The project you asked for is never folded: filtering to it and then seeing a
    // collapsed header is the same empty-list confusion this control removed.
    if (this.projectFilter() === path) {
      return false;
    }
    return this.collapsed()[path] === true;
  }

  protected toggleGroup(path: string): void {
    // The filtered list is one project, always open: nothing to fold.
    if (this.projectFilter() === path) {
      return;
    }
    this.collapsed.update((state) => ({ ...state, [path]: state[path] !== true }));
  }

  protected activate(session: SessionSummary): void {
    // The tab strip (browser host) opens the session's tab; the host also
    // replays its transcript. VS Code has no strip and this is still the switch.
    this.tabs.focusSession({ id: session.id, title: session.title, cwd: session.cwd });
    this.shell.closeNavigation();
  }

  /**
   * The row's own actions, behind a right-click. A row is a button (open the
   * session), so the old inline "✕" competed with that click; a menu keeps the
   * row single-purpose.
   */
  protected openMenu(event: MouseEvent, session: SessionSummary): void {
    event.preventDefault();
    event.stopPropagation();
    // Anchor at the pointer but pull back from the edges: the nav is narrow and
    // the row can sit anywhere, so the menu must stay inside the viewport.
    const width = 200;
    const height = 104;
    this.menu.set({
      x: Math.max(0, Math.min(event.clientX, window.innerWidth - width)),
      y: Math.max(0, Math.min(event.clientY, window.innerHeight - height)),
      session,
      confirming: false,
    });
  }

  protected closeMenu(): void {
    this.menu.set(undefined);
  }

  protected closeNow(session: SessionSummary): void {
    this.closeMenu();
    // The tab goes with the session: closing only the host's agent would leave a
    // tab pointing at a conversation the host no longer shows.
    this.tabs.forget(session.id);
    this.closeHostTab(session.id);
    this.morse.closeSession(session.id);
  }

  /**
   * Opens this session in the host's own editor tab (VS Code): the same
   * conversation, in a full editor surface rather than the narrow sidebar. The
   * host reveals the tab when it is already open, so this doubles as "go back to
   * it". A host without the capability never offers the menu row.
   */
  protected openInEditorTab(session: SessionSummary): void {
    this.closeMenu();
    void this.morse
      .requestHostCommand('openSessionTab', {
        sessionId: session.id,
        title: session.title,
      })
      .catch(() => undefined);
  }

  /**
   * Drops the host's editor tab for a session. A host that shows no session tabs
   * ignores the command; there is nothing to synchronize in that case.
   */
  private closeHostTab(sessionId: string): void {
    if (!this.sessionTabs()) {
      return;
    }
    void this.morse
      .requestHostCommand('closeSessionTab', { sessionId })
      .catch(() => undefined);
  }

  /**
   * Deleting is destructive, so it asks first: a host with native dialogs (VS
   * Code) answers with its own modal, the browser has none and the menu turns
   * into the question itself. A host that claims the capability but never
   * answers still gets the in-app question — never a blind delete.
   */
  protected askDelete(open: SessionMenu): void {
    if (this.nativeDialogs()) {
      void this.confirmOnHost(open);
      return;
    }
    this.menu.set({ ...open, confirming: true });
  }

  private async confirmOnHost(open: SessionMenu): Promise<void> {
    const answer = await this.morse.requestHostCommand('confirmDeleteSession', {
      sessionId: open.session.id,
      title: open.session.title,
    });
    if (answer === undefined) {
      this.menu.set({ ...open, confirming: true });
      return;
    }
    this.closeMenu();
    if ((answer as { confirmed?: boolean }).confirmed === true) {
      this.morse.deleteSession(open.session.id);
    }
  }

  protected deleteNow(session: SessionSummary): void {
    this.closeMenu();
    this.tabs.forget(session.id);
    this.closeHostTab(session.id);
    this.morse.deleteSession(session.id);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    // Innermost thing first: the panel, then the menu.
    if (this.filterOpen()) {
      this.closeFilter();
      return;
    }
    if (this.menu() !== undefined) {
      this.closeMenu();
    }
  }

  protected openFilter(): void {
    this.shell.openProjectFilter();
  }

  protected closeFilter(): void {
    this.shell.closeProjectFilter();
  }

  protected onProjectSelect(path: string): void {
    this.shell.setProjectFilter(path);
    this.closeFilter();
  }

  /** The empty state's way out: jump to the project whose name the reader typed. */
  protected filterToProject(project: ProjectOption): void {
    this.shell.setProjectFilter(project.path);
    // The reader asked for that project, not for those characters in a session
    // title — keeping the query would land them in a filtered project with an
    // empty list, which is the confusion this jump exists to fix.
    this.query.set('');
    this.closeFilter();
  }

  /** Opens the About/credits overlay; it lives at the app level, not in here. */
  protected openAbout(): void {
    this.shell.openAbout();
  }

  /** Opens the keyboard help, which lives at the app level for the same reason. */
  protected openShortcuts(): void {
    this.shell.openShortcuts();
  }

  protected newSession(event: Event, path?: string): void {
    event.stopPropagation();
    this.startSession(path);
  }

  /**
   * The sidebar's "New session", and the shortcut for it — one implementation, so
   * the key cannot drift from the button. On a global host there is no current
   * project to inherit, so it asks for a folder first; the per-project "+" passes
   * a path and creates the draft directly.
   */
  private startSession(path?: string): void {
    if (path === undefined && this.directoryPicker()) {
      this.shell.openProjectPicker();
      this.shell.closeNavigation();
      return;
    }
    this.tabs.startDraft(path ?? this.morse.workspace().cwd);
    this.shell.closeNavigation();
  }

  /**
   * Brings the sidebar on screen whichever way it is hidden. The wide-layout
   * column folds with `visibility: hidden`, the narrow drawer slides off canvas
   * with a transform — and neither makes `offsetParent` null, so this measures
   * the search field's box instead of trusting the DOM flag. CSS owns the
   * breakpoint, so no width is repeated here either.
   */
  private revealNavigation(): void {
    this.shell.unfoldNavigation();
    const rect = this.searchInput()?.nativeElement.getBoundingClientRect();
    // A box with no width, or one parked at/beyond the left edge, is the closed
    // drawer (or a field that never rendered).
    if (rect === undefined || rect.width === 0 || rect.right <= 0) {
      this.shell.openNavigation();
    }
  }

  /**
   * `/` from outside a text field. A field nobody can see cannot take focus, so
   * the sidebar is revealed first, then the caret lands.
   */
  private focusSearch(): void {
    this.revealNavigation();
    // Both reveals are class changes, so the field only takes focus once the
    // layout has settled — and `select()` makes the next word replace the old
    // query instead of extending it.
    setTimeout(() => {
      const open = this.searchInput()?.nativeElement;
      open?.focus();
      open?.select();
    }, 0);
  }

  /**
   * The project filter panel lives inside this sidebar, so the shortcut has to
   * reveal the sidebar before the panel is worth opening — same reason `/` does.
   */
  private openFilterFromKeyboard(): void {
    this.revealNavigation();
    this.shell.openProjectFilter();
  }

  protected refresh(): void {
    this.morse.requestProjects();
    this.morse.requestSessions();
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected age(at: number): string {
    if (at <= 0) {
      return '';
    }
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return `${hours}h`;
    }
    return `${Math.round(hours / 24)}d`;
  }
}

/**
 * One line naming what the newest transcript item is doing. The transcript is
 * the active session's alone, so this is only ever asked about that one.
 */
function actionLabel(item: TranscriptItem): string | undefined {
  if (item.kind === 'tool') {
    const kind = toolKind(item.name);
    const verb = toolGerund(item);
    const raw = toolTitle(item);
    if (kind === 'shell') {
      return `${verb} ${clip(raw.replace(/\s+/g, ' ').trim(), 40)}`;
    }
    if (kind === 'search') {
      return `${verb} ${clip(raw, 40)}`;
    }
    return `${verb} ${toolFileName(raw)}`;
  }
  if (item.kind === 'assistant') {
    if (item.thinking.trim().length > 0 && item.text.trim().length === 0) {
      return 'Thinking…';
    }
    if (item.text.trim().length > 0 || item.streaming) {
      return 'Writing…';
    }
  }
  return undefined;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
