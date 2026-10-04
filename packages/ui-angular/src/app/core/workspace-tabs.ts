import { Injectable, computed, inject, signal } from '@angular/core';
import { languageForPath } from './highlight';
import { MorseService } from './morse.service';

export interface SessionTab {
  kind: 'session';
  /** The session id, which is also the tab id; `draft` before a session exists. */
  id: string;
  title: string;
  cwd?: string;
  /** A brand-new session the host has not opened yet (`session/new` draft). */
  draft?: boolean;
}

export interface FileTab {
  kind: 'file';
  /** `file:<path>`, so a tab id never collides with a session id. */
  id: string;
  path: string;
  title: string;
  language?: string;
  content?: string;
  size?: number;
  truncated?: boolean;
  binary?: boolean;
  loading: boolean;
  error?: string;
}

export type WorkspaceTab = SessionTab | FileTab;

const FILE_PREFIX = 'file:';
/** The draft tab's id: a tab for a session the host has not opened yet. */
export const DRAFT_TAB_ID = 'draft';

/** The shape the host's `readFile` command resolves with. */
interface FilePreviewPayload {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

/**
 * The browser host's tab strip: sessions and files open side by side, one active
 * at a time. A session tab is navigation — selecting it activates that session on
 * the host, which replays its transcript — while a file tab holds the preview the
 * host read for it.
 *
 * Frontend shell state, not wire state: which tabs are open is the user's, and the
 * host is told only what it must act on (`session/activate`, `readFile`). VS Code
 * leaves this empty and keeps its native editor tabs (`capabilities.filePreview`).
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceTabs {
  private readonly morse = inject(MorseService);
  private readonly items = signal<WorkspaceTab[]>([]);
  private readonly active = signal<string | undefined>(undefined);

  readonly tabs = this.items.asReadonly();
  readonly activeId = this.active.asReadonly();
  readonly activeTab = computed<WorkspaceTab | undefined>(() =>
    this.items().find((tab) => tab.id === this.active()),
  );
  /** The sessions that have a tab open, so the sidebar can mark them. */
  readonly openSessionIds = computed(
    () =>
      new Set(
        this.items()
          .filter((tab): tab is SessionTab => tab.kind === 'session')
          .map((tab) => tab.id),
      ),
  );

  /**
   * The host's active session always has a tab. Called from an effect when the
   * session changes; a session that opens in the background joins the strip
   * without stealing focus from the file or session the user is looking at.
   */
  ensureSession(session: { id: string; title: string; cwd?: string }): void {
    const existing = this.findSession(session.id);
    if (existing === undefined) {
      this.items.update((tabs) => [...tabs, { kind: 'session', ...session }]);
      if (this.active() === undefined) {
        this.active.set(session.id);
      }
      return;
    }
    this.refreshSession(session);
  }

  /**
   * Keeps an already-open session tab's label current, and does nothing when the
   * tab is gone. The distinction from `ensureSession` is what lets a user close
   * the active session's tab for good: the host's state keeps re-emitting, but a
   * closed tab must not be resurrected by it.
   */
  refreshSession(session: { id: string; title: string; cwd?: string }): void {
    const existing = this.findSession(session.id);
    if (
      existing === undefined ||
      (existing.title === session.title && existing.cwd === session.cwd)
    ) {
      return;
    }
    this.items.update((tabs) =>
      tabs.map((tab) =>
        tab.kind === 'session' && tab.id === session.id ? { ...tab, ...session } : tab,
      ),
    );
  }

  /**
   * Starts a brand-new session: the host's `session/new` only makes an empty
   * draft, so the tab is opened here and promoted to the real session once the
   * first prompt gives it an id (`showSession`).
   */
  startDraft(cwd?: string): void {
    this.openDraft(cwd);
    this.morse.newSession(cwd);
  }

  /** Opens (or reveals) the draft tab the first prompt will fill in. */
  openDraft(cwd?: string): void {
    const existing = this.items().find((tab) => tab.kind === 'session' && tab.id === DRAFT_TAB_ID);
    if (existing === undefined) {
      this.items.update((tabs) => [
        ...tabs,
        { kind: 'session', id: DRAFT_TAB_ID, title: 'New session', cwd, draft: true },
      ]);
    }
    this.active.set(DRAFT_TAB_ID);
  }

  /** The user picked a session (from the sidebar or its tab): show it and activate it. */
  focusSession(session: { id: string; title: string; cwd?: string }): void {
    // Switching to a real session abandons an unfinished draft.
    this.discardDraft();
    this.showSession(session);
    this.morse.activateSession(session.id, session.cwd);
  }

  /**
   * The host's active session changed on its own (a fresh session, a resume):
   * put its tab in front without asking the host to switch to what it already
   * shows. A draft tab becomes this session, so "New session" is the tab the
   * first prompt fills in rather than a second tab beside it.
   */
  showSession(session: { id: string; title: string; cwd?: string }): void {
    this.promoteDraft(session);
    this.ensureSession(session);
    this.active.set(session.id);
  }

  /** Opens or reveals a file tab; reads it the first time it is shown. */
  openFile(path: string): void {
    const id = FILE_PREFIX + path;
    const existing = this.items().find((tab) => tab.id === id);
    if (existing === undefined) {
      this.items.update((tabs) => [
        ...tabs,
        {
          kind: 'file',
          id,
          path,
          title: basename(path),
          language: languageForPath(path),
          loading: true,
        },
      ]);
    }
    this.active.set(id);
    if (existing === undefined || this.needsLoad(existing)) {
      void this.load(id);
    }
  }

  select(id: string): void {
    const tab = this.items().find((candidate) => candidate.id === id);
    if (tab === undefined) {
      return;
    }
    this.active.set(id);
    if (tab.kind === 'session') {
      this.morse.activateSession(tab.id, tab.cwd);
      return;
    }
    if (this.needsLoad(tab)) {
      void this.load(id);
    }
  }

  /**
   * Closes a tab, falling back to its neighbour when it was the active one. When
   * no session is left in front — the strip is empty, or a file tab takes over —
   * the host is sent back to an empty draft, so the panel never keeps showing the
   * session the user just closed.
   */
  close(id: string): void {
    const index = this.items().findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }
    const tab = this.items()[index];
    const wasActive = this.active() === id;
    const closedSession = tab.kind === 'session' && tab.draft !== true;
    const cwd = tab.kind === 'session' ? tab.cwd : undefined;
    this.items.update((tabs) => tabs.filter((candidate) => candidate.id !== id));
    if (wasActive) {
      const remaining = this.items();
      const neighbour = remaining[Math.min(index, remaining.length - 1)];
      if (neighbour === undefined) {
        this.active.set(undefined);
      } else {
        this.select(neighbour.id);
      }
    }
    if (closedSession) {
      this.fallBackToEmptySession(cwd);
    }
  }

  /**
   * Removes a tab because the host was told to close or delete that session; no
   * action is sent (the caller does that). Falls back to the neighbour like
   * `close`, so the panel does not sit on a tab that just disappeared.
   */
  forget(id: string): void {
    const index = this.items().findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }
    const wasActive = this.active() === id;
    this.items.update((tabs) => tabs.filter((tab) => tab.id !== id));
    if (!wasActive) {
      return;
    }
    const remaining = this.items();
    const neighbour = remaining[Math.min(index, remaining.length - 1)];
    if (neighbour === undefined) {
      this.active.set(undefined);
      return;
    }
    this.select(neighbour.id);
  }

  /**
   * The host shows no session (an empty draft): a real session tab cannot be the
   * one on screen. Clears the active flag so a stale tab does not look active
   * over an empty panel; a draft tab stays, since it *is* that empty session.
   */
  clearActiveSession(): void {
    const active = this.items().find((tab) => tab.id === this.active());
    if (active !== undefined && active.kind === 'session' && active.draft !== true) {
      this.active.set(undefined);
    }
  }

  /** Keeps only `id`, the way VS Code's "Close Others" does. */
  closeOthers(id: string): void {
    const keep = this.items().find((tab) => tab.id === id);
    if (keep === undefined) {
      return;
    }
    const closing = this.items().filter((tab) => tab.id !== id);
    const closedSession = closing.some((tab) => tab.kind === 'session' && tab.draft !== true);
    const cwd = closing.find((tab): tab is SessionTab => tab.kind === 'session')?.cwd;
    this.items.update((tabs) => tabs.filter((tab) => tab.id === id));
    this.active.set(id);
    if (keep.kind === 'session') {
      this.morse.activateSession(keep.id, keep.cwd);
    }
    if (closedSession) {
      this.fallBackToEmptySession(cwd);
    }
  }

  /** Closes every tab to the right of `id` (VS Code's "Close to the Right"). */
  closeToTheRight(id: string): void {
    const index = this.items().findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }
    const closing = this.items().slice(index + 1);
    if (closing.length === 0) {
      return;
    }
    const ids = new Set(closing.map((tab) => tab.id));
    const closedSession = closing.some((tab) => tab.kind === 'session' && tab.draft !== true);
    const cwd = closing.find((tab): tab is SessionTab => tab.kind === 'session')?.cwd;
    const active = this.active();
    this.items.update((tabs) => tabs.filter((tab) => !ids.has(tab.id)));
    if (active !== undefined && ids.has(active)) {
      this.select(id);
    }
    if (closedSession) {
      this.fallBackToEmptySession(cwd);
    }
  }

  /** Empties the strip (VS Code's "Close All"). */
  closeAll(): void {
    const closedSession = this.items().some(
      (tab) => tab.kind === 'session' && tab.draft !== true,
    );
    const cwd = this.items().find((tab): tab is SessionTab => tab.kind === 'session')?.cwd;
    this.items.set([]);
    this.active.set(undefined);
    if (closedSession) {
      this.fallBackToEmptySession(cwd);
    }
  }

  /**
   * A close that leaves no session tab in front must not leave the host showing
   * the session it just closed: fall back to an empty draft in the same project.
   * A close that still has a session tab (or a host already on a draft) leaves
   * the host alone.
   */
  private fallBackToEmptySession(cwd: string | undefined): void {
    if (this.items().some((tab) => tab.kind === 'session')) {
      return;
    }
    if (this.morse.state().sessionId === undefined) {
      return;
    }
    this.morse.newSession(cwd ?? this.morse.state().workspace.cwd);
  }

  /** Re-reads a file tab from disk (the preview's refresh affordance). */
  reload(id: string): void {
    void this.load(id);
  }

  private findSession(id: string): SessionTab | undefined {
    return this.items().find(
      (tab): tab is SessionTab => tab.kind === 'session' && tab.id === id,
    );
  }

  /** Turns the draft tab into the session that just got an id, in place. */
  private promoteDraft(session: { id: string; title: string; cwd?: string }): void {
    const hasDraft = this.items().some(
      (tab) => tab.kind === 'session' && tab.id === DRAFT_TAB_ID,
    );
    if (!hasDraft) {
      return;
    }
    this.items.update((tabs) =>
      tabs.map((tab) =>
        tab.kind === 'session' && tab.id === DRAFT_TAB_ID
          ? { kind: 'session', ...session }
          : tab,
      ),
    );
  }

  private discardDraft(): void {
    const hasDraft = this.items().some(
      (tab) => tab.kind === 'session' && tab.id === DRAFT_TAB_ID,
    );
    if (!hasDraft) {
      return;
    }
    this.items.update((tabs) =>
      tabs.filter((tab) => !(tab.kind === 'session' && tab.id === DRAFT_TAB_ID)),
    );
  }

  private needsLoad(tab: WorkspaceTab): boolean {
    return tab.kind === 'file' && !tab.loading && tab.content === undefined && tab.error === undefined;
  }

  private async load(id: string): Promise<void> {
    const tab = this.items().find((candidate) => candidate.id === id);
    if (tab === undefined || tab.kind !== 'file') {
      return;
    }
    this.patch(id, { loading: true, error: undefined });
    const data = await this.morse.requestHostCommand('readFile', { path: tab.path });
    const preview = asPreview(data);
    if (preview === undefined) {
      this.patch(id, { loading: false, error: 'Could not read this file.' });
      return;
    }
    this.patch(id, {
      loading: false,
      content: preview.content,
      size: preview.size,
      truncated: preview.truncated,
      binary: preview.binary,
      language: languageForPath(preview.path),
    });
  }

  private patch(id: string, change: Partial<FileTab>): void {
    this.items.update((tabs) =>
      tabs.map((tab) => (tab.id === id && tab.kind === 'file' ? { ...tab, ...change } : tab)),
    );
  }
}

function asPreview(value: unknown): FilePreviewPayload | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const content = candidate['content'];
  const path = candidate['path'];
  if (typeof content !== 'string' || typeof path !== 'string') {
    return undefined;
  }
  const size = candidate['size'];
  return {
    path,
    content,
    size: typeof size === 'number' ? size : content.length,
    truncated: candidate['truncated'] === true,
    binary: candidate['binary'] === true,
  };
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}
