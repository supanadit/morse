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
import { MorseService } from '../../host/morse.service';
import { LayoutState } from '../../state/layout-state';
import { ShellState } from '../../state/shell-state';
import { ShortcutService } from '../../services/shortcut.service';
import { toolFileName, toolGerund, toolKind, toolTitle } from '@morse/ui-runtime';
import type { TreeNode } from '@morse/ui-runtime';
import { UpdateCheck } from '../../services/update';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { FileExplorer } from '../file-explorer/file-explorer';
import { Pane } from '../../ui/pane/pane';
import { Splitter } from '../../ui/splitter/splitter';
import { TreeList } from '../../ui/tree-list/tree-list';
import { ProjectFilter, type ProjectOption } from '../project-filter/project-filter';

interface SessionGroup {
  path: string;
  name: string;
  sessions: SessionSummary[];
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
  imports: [ProjectFilter, FileExplorer, Pane, Splitter, TreeList],
  templateUrl: './session-nav.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './session-nav.css',
})
export class SessionNav {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly layout = inject(LayoutState);
  private readonly shortcuts = inject(ShortcutService);
  private readonly update = inject(UpdateCheck);
  private readonly tabs = inject(WorkspaceTabs);
  private readonly destroyRef = inject(DestroyRef);
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly query = signal('');
  /** The whole session section folds to its title bar, the way the Explorer does. */
  protected readonly sessionsFolded = signal(false);
  protected readonly collapsed = signal<Record<string, boolean>>({});
  protected readonly menu = signal<SessionMenu | undefined>(undefined);
  /**
   * Sessions under each project for the shared tree. A project is a `group` whose
   * children are its sessions; a session is a `leaf` carrying the summary itself,
   * so a click opens it without looking an id back up.
   *
   * The tree only lists what is not already pinned at the top as in progress, so
   * nothing is shown twice — the same rule the old flat list used.
   */
  protected readonly treeNodes = computed<TreeNode<SessionSummary>[]>(() => {
    const inProgress = new Set(this.inProgress().map((session) => session.id));
    // A workspace host has one project, so a group row for it is a header with
    // nothing to contrast against — the sessions are simply the tree's roots.
    if (this.scope() === 'workspace') {
      return this.visibleGroups().flatMap((group) => this.sessionNodes(group, inProgress));
    }
    return this.visibleGroups().map((group) => ({
      id: projectNodeId(group.path),
      label: group.name,
      // A group's own data is never acted on — only its sessions are.
      data: undefined as unknown as SessionSummary,
      badge: group.sessions.length.toString(),
      kind: 'group' as const,
      action: {
        glyph: '+',
        label: `New session in ${group.name}`,
        run: () => this.startSession(group.path),
      },
      children: this.sessionNodes(group, inProgress),
    }));
  });

  /** A project's sessions as tree nodes, with each fork nested under the session it was forked from. */
  private sessionNodes(
    group: SessionGroup,
    inProgress: ReadonlySet<string>,
  ): TreeNode<SessionSummary>[] {
    const sessions = group.sessions.filter((session) => !inProgress.has(session.id));
    const byId = new Map(sessions.map((session) => [session.id, session] as const));
    // A child is nested only when its parent is in this same list: a parent pinned
    // as in progress, or one from another project, leaves the child a root rather
    // than hiding it under a row that is not there.
    const childrenOf = new Map<string, SessionSummary[]>();
    const roots: SessionSummary[] = [];
    for (const session of sessions) {
      const parentId = session.parentId;
      if (parentId !== undefined && parentId !== session.id && byId.has(parentId)) {
        const siblings = childrenOf.get(parentId) ?? [];
        siblings.push(session);
        childrenOf.set(parentId, siblings);
      } else {
        roots.push(session);
      }
    }
    const toNode = (session: SessionSummary): TreeNode<SessionSummary> => {
      const children = (childrenOf.get(session.id) ?? []).map(toNode);
      return {
        id: session.id,
        label: session.title,
        data: session,
        badge: this.age(session.updatedAt),
        // A session with forks unfolds like a folder, so the forks are reachable.
        kind: children.length > 0 ? 'group' : 'leaf',
        children,
      };
    };
    return roots.map(toNode);
  }

  /**
   * The open projects, in the shape the shared tree wants. The component keeps a
   * map of folded projects for the old accordion; this turns it inside out,
   * because the tree wants what is *open* rather than what is shut.
   */
  protected readonly expandedProjects = computed<ReadonlySet<string>>(() => {
    const folded = this.collapsed();
    const open = new Set<string>();
    for (const group of this.visibleGroups()) {
      // A filtered project is never folded, and a workspace has a single group.
      if (
        this.scope() === 'workspace' ||
        this.projectFilter() === group.path ||
        folded[group.path] !== true
      ) {
        open.add(projectNodeId(group.path));
      }
    }
    // A session that is a fork parent (a group in the tree) is open unless the
    // reader folded it by its own id, so its forks show without a first click.
    for (const node of this.treeNodes()) {
      this.collectOpenForks(node, folded, open);
    }
    return open;
  });

  /** Walks the tree for session groups — forks — and opens the ones not folded. */
  private collectOpenForks(
    node: TreeNode<SessionSummary>,
    folded: Readonly<Record<string, boolean>>,
    open: Set<string>,
  ): void {
    if (node.kind !== 'group') {
      return;
    }
    // Only a session group (a fork parent) lives here; a project's id is prefixed.
    if (!node.id.startsWith('project:') && folded[node.id] !== true) {
      open.add(node.id);
    }
    for (const child of node.children) {
      this.collectOpenForks(child, folded, open);
    }
  }

  /**
   * The shared tree reports a clicked row. A project is a heading, so clicking it
   * folds; a session — fork parent or leaf — opens, whoever its children are. Opening
   * the parent is the point: a parent is a session first, a group only because the
   * forks hang under it.
   */
  protected onTreeRow(node: TreeNode<SessionSummary>): void {
    if (isProjectNode(node)) {
      this.toggleGroup(node.id.slice('project:'.length));
      return;
    }
    this.activate(node.data);
  }

  /** The caret only folds, so a parent session can be opened by its own name. */
  protected onTreeToggle(node: TreeNode<SessionSummary>): void {
    this.toggleGroup(isProjectNode(node) ? node.id.slice('project:'.length) : node.id);
  }

  /** A right-click on a session row opens the row's menu at the pointer. */
  protected onTreeContext(open: { node: TreeNode<SessionSummary>; event: MouseEvent }): void {
    if (isProjectNode(open.node)) {
      return;
    }
    this.openMenu(open.event, open.node.data);
  }

  /**
   * The tree's message when it has no rows to draw. A query narrows; without one the
   * project is simply empty, and a project filter means nothing in *that* project.
   */
  protected readonly emptyMessage = computed<string>(() => {
    if (this.query().trim().length > 0) {
      return `No session matches “${this.query()}”.`;
    }
    if (this.projectFilter().length > 0) {
      return 'No sessions in this project yet.';
    }
    return 'Nothing found.';
  });
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
  /** Whether this host can install its own update (npm-global + opted in). */
  protected readonly canSelfUpdate = this.update.canApply;
  /** True while an install runs, so the button reports progress and cannot repeat. */
  protected readonly updating = this.update.applying;
  /** What the last attempt said — a refusal reason, or "restarting". */
  protected readonly updateStatus = this.update.status;
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
        },
      ];
    }
    return this.morse.projects().map((project) => ({
      path: project.path,
      name: project.name,
      sessions: sessions.filter((session) => session.cwd === project.path),
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
        return { ...group, sessions };
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

  /** Folds the whole session list down to its title bar, or brings it back. */
  protected toggleSessions(): void {
    this.sessionsFolded.update((value) => !value);
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

  /**
   * The footer's update button: hand the install to the host, which answers
   * before it exits. `UpdateCheck.apply` waits out the restart and reloads.
   */
  protected applyUpdate(): void {
    void this.update.apply();
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
 * The node id a project's row carries. Prefixed so it cannot collide with a session
 * id — and stripped again when a click comes back, since folding is keyed by path.
 */
function projectNodeId(path: string): string {
  return `project:${path}`;
}

/** A project heading (folds), as opposed to a session fork (a group that still opens). */
function isProjectNode(node: TreeNode<SessionSummary>): boolean {
  return node.id.startsWith('project:');
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
