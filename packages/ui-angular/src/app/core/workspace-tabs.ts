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
  /** `file:<path>` (Explorer) or `mention:<sessionId>:<path>` (the `@` picker). */
  id: string;
  path: string;
  title: string;
  /** Opened from the `@` picker: shown in its own row below the sessions. */
  mention?: boolean;
  /**
   * A quoted file's session: it is that session's context — shown only while the
   * session is in front, and closed with it. Quoting the same path in another
   * session is a second tab, keyed by this id.
   */
  sessionId?: string;
  language?: string;
  content?: string;
  size?: number;
  truncated?: boolean;
  binary?: boolean;
  loading: boolean;
  error?: string;
  /** Unified diff text for a changed file, read on demand by the preview. */
  diff?: string;
  diffLoading?: boolean;
  diffError?: string;
}

export type WorkspaceTab = SessionTab | FileTab;

const FILE_PREFIX = 'file:';
/** Files opened from the `@` picker live in a second row, so the prefix differs. */
const MENTION_PREFIX = 'mention:';
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
  /** The first row: sessions, and files opened from the Explorer. */
  readonly mainTabs = computed(() =>
    this.items().filter((tab) => tab.kind === 'session' || tab.mention !== true),
  );
  readonly activeTab = computed<WorkspaceTab | undefined>(() =>
    this.items().find((tab) => tab.id === this.active()),
  );
  /**
   * The session the strip is showing context for: the active session tab, or the
   * owner of the quoted file in front. `undefined` when neither is a session (a
   * plain Explorer file in front), so no session's context leaks into another's
   * view.
   */
  private readonly contextSessionId = computed<string | undefined>(() => {
    const tab = this.activeTab();
    if (tab?.kind === 'session') {
      return tab.id;
    }
    return tab?.kind === 'file' && tab.mention === true ? tab.sessionId : undefined;
  });
  /**
   * The second row: only the quoted files of the session in front. A file the
   * user never quoted in that session is not this session's context, so it does
   * not appear here.
   */
  readonly mentionTabs = computed<FileTab[]>(() => {
    const owner = this.contextSessionId();
    return this.items().filter(
      (tab): tab is FileTab =>
        tab.kind === 'file' &&
        tab.mention === true &&
        (owner === undefined ? tab.sessionId === undefined : tab.sessionId === owner),
    );
  });
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

  /** Opens or reveals a file tab from the Explorer; reads it the first time. */
  openFile(path: string): void {
    this.openFileTab(path, false, undefined);
  }

  /**
   * Opens or reveals a file tab from the `@` picker. It belongs to the session in
   * front, stays in its own row so it does not push the session tabs aside, and
   * is keyed by that session so the same path quoted elsewhere is a second tab.
   */
  openMentionFile(path: string): void {
    this.openFileTab(path, true, this.contextSessionId());
  }

  private openFileTab(path: string, mention: boolean, sessionId?: string): void {
    const id = mention ? mentionTabId(sessionId, path) : `${FILE_PREFIX}${path}`;
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
          mention,
          sessionId: mention ? sessionId : undefined,
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
      // The draft is a placeholder, not a pi session: activating it would ask
      // the host to resume a session literally named "draft". The host is
      // already showing it, so bringing it forward needs no wire message.
      if (tab.draft !== true) {
        this.morse.activateSession(tab.id, tab.cwd);
      }
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
    const closedSession = tab.kind === 'session' && tab.draft !== true;
    const cwd = tab.kind === 'session' ? tab.cwd : undefined;
    this.remove(this.doomedWith(id), index);
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
    this.remove(this.doomedWith(id), index);
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

  /**
   * Keeps only `id` — plus, when it is a session, its quoted files, which cannot
   * outlive it. (VS Code's "Close Others".)
   */
  closeOthers(id: string): void {
    const keep = this.items().find((tab) => tab.id === id);
    if (keep === undefined) {
      return;
    }
    const keepIds = new Set<string>([id]);
    if (keep.kind === 'session') {
      for (const mention of this.mentionFilesOf(id)) {
        keepIds.add(mention.id);
      }
    } else if (keep.mention === true && keep.sessionId !== undefined) {
      // A quoted file cannot stay without the session it belongs to.
      keepIds.add(keep.sessionId);
    }
    const closing = this.items().filter((tab) => !keepIds.has(tab.id));
    const closedSession = closing.some((tab) => tab.kind === 'session' && tab.draft !== true);
    const cwd = closing.find((tab): tab is SessionTab => tab.kind === 'session')?.cwd;
    this.items.update((tabs) => tabs.filter((tab) => keepIds.has(tab.id)));
    this.active.set(id);
    if (keep.kind === 'session' && keep.draft !== true) {
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
    this.pruneOrphanMentions();
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

  /**
   * The tabs that leave with `id`: a session takes its quoted files with it, and
   * a quoted file whose session is no longer open is orphaned and goes too.
   */
  private doomedWith(id: string): Set<string> {
    const doomed = new Set<string>([id]);
    const openSessions = new Set(
      this.items()
        .filter((tab): tab is SessionTab => tab.kind === 'session' && tab.id !== id)
        .map((tab) => tab.id),
    );
    for (const tab of this.items()) {
      if (tab.kind !== 'file' || tab.mention !== true) {
        continue;
      }
      if (
        tab.sessionId === undefined ||
        tab.sessionId === id ||
        !openSessions.has(tab.sessionId)
      ) {
        doomed.add(tab.id);
      }
    }
    return doomed;
  }

  /** The quoted files opened as context for `sessionId`. */
  private mentionFilesOf(sessionId: string): FileTab[] {
    return this.items().filter(
      (tab): tab is FileTab =>
        tab.kind === 'file' && tab.mention === true && tab.sessionId === sessionId,
    );
  }

  /**
   * Removes `doomed` and, if the active tab was among them, brings the nearest
   * survivor forward — the index is the closed tab's, so the fallback lands where
   * the user was looking rather than at the end of the strip.
   */
  private remove(doomed: Set<string>, index: number): void {
    const active = this.active();
    this.items.update((tabs) => tabs.filter((tab) => !doomed.has(tab.id)));
    if (active === undefined || !doomed.has(active)) {
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
   * Drops quoted files whose session is no longer open, re-pointing the active
   * tab if it was one of them.
   */
  private pruneOrphanMentions(): void {
    const openSessions = new Set(
      this.items()
        .filter((tab): tab is SessionTab => tab.kind === 'session')
        .map((tab) => tab.id),
    );
    const items = this.items();
    const doomed = new Set(
      items
        .filter(
          (tab) =>
            tab.kind === 'file' &&
            tab.mention === true &&
            (tab.sessionId === undefined || !openSessions.has(tab.sessionId)),
        )
        .map((tab) => tab.id),
    );
    if (doomed.size === 0) {
      return;
    }
    this.remove(
      doomed,
      items.findIndex((tab) => tab.id === this.active()),
    );
  }

  /** Re-reads a file tab from disk (the preview's refresh affordance). */
  reload(id: string): void {
    // A refresh re-reads both the content and the diff: the file changed on disk.
    this.patch(id, { diff: undefined, diffError: undefined });
    void this.load(id);
  }

  /**
   * Reads the file's unified diff the first time a diff view needs it. Kept on
   * the tab beside its content, so revealing the same tab again is free.
   */
  loadDiff(id: string): void {
    const tab = this.items().find((candidate) => candidate.id === id);
    if (
      tab === undefined ||
      tab.kind !== 'file' ||
      tab.diff !== undefined ||
      tab.diffLoading === true
    ) {
      return;
    }
    this.patch(id, { diffLoading: true, diffError: undefined });
    void this.morse.requestHostCommand('gitDiff', { path: tab.path }).then((data) => {
      const diff = asDiff(data);
      if (diff === undefined) {
        this.patch(id, {
          diffLoading: false,
          diffError: 'Could not read this file’s changes.',
        });
        return;
      }
      this.patch(id, { diffLoading: false, diff });
    });
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
      tabs.map((tab) => {
        if (tab.kind === 'session' && tab.id === DRAFT_TAB_ID) {
          return { kind: 'session', ...session };
        }
        // The draft's quoted files belong to the session it just became.
        if (tab.kind === 'file' && tab.mention === true && tab.sessionId === DRAFT_TAB_ID) {
          return {
            ...tab,
            sessionId: session.id,
            id: mentionTabId(session.id, tab.path),
          };
        }
        return tab;
      }),
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
    this.pruneOrphanMentions();
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

function asDiff(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const diff = (value as { diff?: unknown }).diff;
  return typeof diff === 'string' ? diff : undefined;
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** A quoted file's tab id: keyed by session, so the same path can be quoted twice. */
function mentionTabId(sessionId: string | undefined, path: string): string {
  return `${MENTION_PREFIX}${sessionId ?? ''}:${path}`;
}
