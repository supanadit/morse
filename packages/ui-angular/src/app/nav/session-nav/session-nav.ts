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
import type { SessionSummary } from '@morse/protocol';
import { MorseService } from '../../core/morse.service';
import { ShellState } from '../../core/shell-state';
import { ShortcutService } from '../../core/shortcuts';
import { UpdateCheck } from '../../core/update';
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
  imports: [ProjectFilter],
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
        padding: 5px 10px;
      }
      .filters {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 10px 4px;
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
        padding: 4px 6px 10px;
      }
      .group + .group {
        margin-top: 6px;
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
      .group-title:hover {
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
      .group-new:hover,
      .group-new:focus-visible {
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
        gap: 6px;
        width: 100%;
        padding: 5px 8px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        text-align: left;
        cursor: pointer;
      }
      .session:hover {
        background: var(--morse-hover);
      }
      .session.active {
        background: var(--morse-active);
        font-weight: 500;
        box-shadow: inset 2px 0 0 var(--morse-accent);
      }
      /*
       * A session whose agent is running right now. A CSS pulse (not an anime.js
       * loop) so it keeps beating in a hidden webview, where frames are paused.
       */
      .session .pulse {
        flex: none;
        position: relative;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--morse-accent);
      }
      .session .pulse::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: var(--morse-accent);
        animation: morse-pulse 1.5s ease-out infinite;
      }
      @keyframes morse-pulse {
        0% {
          transform: scale(1);
          opacity: 0.6;
        }
        100% {
          transform: scale(2.6);
          opacity: 0;
        }
      }
      .session .title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .session .meta {
        font-size: 11px;
        white-space: nowrap;
        opacity: 0.8;
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
      .context-menu-item:hover,
      .context-menu-item:focus-visible {
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
  private readonly destroyRef = inject(DestroyRef);
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  protected readonly query = signal('');
  protected readonly collapsed = signal<Record<string, boolean>>({});
  protected readonly menu = signal<SessionMenu | undefined>(undefined);
  /** Which project the list is narrowed to; `''` shows every one of them. */
  protected readonly projectFilter = signal('');
  /**
   * The filter panel's open flag lives in `ShellState`: the shortcut opens it from
   * outside this component, and the shell watches it to know a dialog is up.
   */
  protected readonly filterOpen = this.shell.projectFilterOpen;
  private readonly nativeDialogs = computed(
    () => this.morse.capabilities()?.nativeDialogs === true,
  );
  protected readonly activeSessionId = computed(() => this.morse.state().sessionId);
  /** The build this host is serving, printed beside the notice it explains. */
  protected readonly version = this.morse.version;
  /** A newer release, when the host allowed the check and the registry confirmed one. */
  protected readonly updateNotice = this.update.available;
  protected readonly sessionActivity = this.morse.sessionActivity;
  protected readonly scope = computed(() => this.morse.capabilities()?.scope ?? 'global');
  /** The browser host opens a folder modal for "New session" (see ProjectPicker). */
  private readonly directoryPicker = computed(
    () => this.morse.capabilities()?.directoryPicker === true,
  );

  /**
   * True only while the agent is producing something in that session. A session
   * that is merely open/hot is *not* animated: the rotating border means "an
   * agent is running here right now", and it dies when the run settles.
   */
  protected isRunning(session: SessionSummary): boolean {
    const activity = this.sessionActivity().get(session.id);
    if (activity !== undefined) {
      return activity.streaming || activity.busy;
    }
    // A session opened before its id is known cannot match the activity key yet.
    return session.id === this.activeSessionId() && this.morse.running();
  }

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
    // The session box asks about session titles only. Project names used to match
    // here too, which showed the project with an empty list under it — `buku` was
    // there, so it looked empty. Finding a project is the chip's job.
    const scoped = filter.length === 0
      ? this.groups()
      : this.groups().filter((group) => group.path === filter);
    return scoped
      .map((group) => ({
        ...group,
        sessions:
          query.length === 0
            ? group.sessions
            : group.sessions.filter((session) => session.title.toLowerCase().includes(query)),
      }))
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
      this.shortcuts.bind('project.filter', () => this.shell.openProjectFilter(), () => this.filterable()),
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
    this.morse.activateSession(session.id, session.cwd);
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
    this.morse.closeSession(session.id);
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
    this.projectFilter.set(path);
    this.closeFilter();
  }

  /** The empty state's way out: jump to the project whose name the reader typed. */
  protected filterToProject(project: ProjectOption): void {
    this.projectFilter.set(project.path);
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
    this.morse.newSession(path ?? this.morse.workspace().cwd);
    this.shell.closeNavigation();
  }

  /**
   * `/` from outside a text field. The field can be off screen in two ways — the
   * wide-layout column folded away, or the narrow drawer closed — and a field
   * nobody can see cannot take focus. CSS owns that breakpoint, so this asks the
   * fold flag and the DOM instead of repeating 760px here.
   */
  private focusSearch(): void {
    const field = this.searchInput()?.nativeElement;
    if (field === undefined) {
      return;
    }
    this.shell.unfoldNavigation();
    if (field.offsetParent === null) {
      this.shell.openNavigation();
    }
    // Both of those are class changes, so the field only takes focus once the
    // layout has settled — and `select()` makes the next word replace the old
    // query instead of extending it.
    setTimeout(() => {
      const open = this.searchInput()?.nativeElement;
      open?.focus();
      open?.select();
    }, 0);
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
