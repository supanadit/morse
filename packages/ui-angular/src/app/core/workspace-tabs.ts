import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { languageForPath } from './highlight';
import { ComposerDrafts } from './composer-drafts';
import { MorseService } from './morse.service';
import { QueuedPrompts } from './queued-prompts';
import { TerminalStore } from './terminal-store';

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
  /** Opened from a commit's file list: the diff is `git show <hash>`, not HEAD. */
  commitHash?: string;
  /** The commit's subject, so the preview can name the commit it is showing. */
  commitSubject?: string;
}

export type WorkspaceTab = SessionTab | FileTab;

const FILE_PREFIX = 'file:';
/** Files opened from the `@` picker live in a second row, so the prefix differs. */
const MENTION_PREFIX = 'mention:';

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
 * host is told only what it must act on (`session/activate`, `readFile`). The
 * strip renders only where `capabilities.filePreview` is set (the browser host);
 * VS Code keeps its native editor tabs and hides this one, but the store still
 * follows the active session so the per-session composer draft has a key.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceTabs {
  private readonly morse = inject(MorseService);
  private readonly drafts = inject(ComposerDrafts);
  private readonly terminals = inject(TerminalStore);
  private readonly queued = inject(QueuedPrompts);
  private readonly items = signal<WorkspaceTab[]>([]);
  private readonly active = signal<string | undefined>(undefined);
  /** Names the draft tabs, so each "New session" is its own tab and its own draft. */
  private draftCounter = 0;
  /**
   * The draft the host is holding right now. It becomes the next session the
   * host opens; `undefined` once the reader moves to a real session. Without it,
   * a draft left in the strip could be mistaken for the session that just opened.
   */
  private pendingDraft: string | undefined;

  constructor() {
    // The composer edits the draft of the tab in front. Pointing the store here,
    // where the active tab is known, keeps a half-typed message with its session
    // even while the composer is unmounted by a file preview.
    effect(() => this.drafts.use(this.composerKey()));
  }

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
   * The draft key the composer should be editing. A plain file tab has no session
   * of its own, so the host's active session keeps its draft behind the preview:
   * a drop while a file is in front still lands in the conversation it belongs to.
   */
  readonly composerKey = computed<string | undefined>(
    () => this.contextSessionId() ?? this.morse.state().sessionId,
  );
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

  /** Opens a fresh draft tab for a new session; every call is its own tab. */
  openDraft(cwd?: string): void {
    this.draftCounter += 1;
    const id = `draft-${this.draftCounter}`;
    this.items.update((tabs) => [
      ...tabs,
      { kind: 'session', id, title: 'New session', cwd, draft: true },
    ]);
    this.active.set(id);
    this.pendingDraft = id;
  }

  /** The user picked a session (from the sidebar or its tab): show it and activate it. */
  focusSession(session: { id: string; title: string; cwd?: string }): void {
    // The draft stops being the host's pending session; a filled-in one stays in
    // the strip as the reader's work, an untouched one is noise.
    this.pendingDraft = undefined;
    this.discardEmptyDrafts();
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
   * Opens a file's diff *inside a commit*, from the git panel's expanded row. It
   * gets its own tab, separate from the working-tree preview of the same path:
   * the diff is against the commit, not HEAD.
   */
  openCommitFile(hash: string, path: string, subject: string): void {
    const id = commitTabId(hash, path);
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
          loading: false,
          commitHash: hash,
          commitSubject: subject,
        },
      ]);
    }
    this.active.set(id);
    // The preview loads the diff on its own, but a non-rendered host (or a tab
    // revealed programmatically) still gets the content this way.
    this.loadDiff(id);
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
      // the host to resume a session literally named "draft". Only a host that
      // is showing a real session has to be told to step back to an empty draft;
      // an empty host draft is the same empty panel for any draft tab.
      if (tab.draft === true) {
        this.pendingDraft = tab.id;
        if (this.morse.state().sessionId !== undefined) {
          this.morse.newSession(tab.cwd);
        }
      } else {
        // Picking a real session leaves an untouched "New session" tab behind.
        this.pendingDraft = undefined;
        this.discardEmptyDrafts();
        this.morse.activateSession(tab.id, tab.cwd);
      }
      return;
    }
    if (this.needsLoad(tab)) {
      void this.load(id);
    }
  }

  /**
   * True when `id` can be dropped on `targetId`: a different tab, in the same
   * row. The two rows are separate lists (`items` holds both), so a session tab
   * cannot be dropped among the quoted files and vice versa.
   */
  canMove(id: string, targetId: string): boolean {
    if (id === targetId) {
      return false;
    }
    const items = this.items();
    const from = items.find((tab) => tab.id === id);
    const to = items.find((tab) => tab.id === targetId);
    return from !== undefined && to !== undefined && tabRow(from) === tabRow(to);
  }

  /**
   * Reorders a tab, putting it where it was dropped: dragged rightward it lands
   * after the tab it was dropped on, leftward before it — the way an editor's
   * dragged tab takes the slot it was released over. The active tab is unchanged;
   * reordering is not selecting.
   */
  move(id: string, targetId: string): void {
    if (!this.canMove(id, targetId)) {
      return;
    }
    const items = this.items();
    const from = items.findIndex((tab) => tab.id === id);
    const to = items.findIndex((tab) => tab.id === targetId);
    const moved = items[from];
    const next = items.filter((tab) => tab.id !== id);
    const target = next.findIndex((tab) => tab.id === targetId);
    next.splice(from < to ? target + 1 : target, 0, moved);
    this.items.set(next);
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
    this.forgetDrafts(closing.map((tab) => tab.id));
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
    this.forgetDrafts(ids);
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
    const openIds = this.items().map((tab) => tab.id);
    this.items.set([]);
    this.forgetDrafts(openIds);
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
    this.forgetDrafts(doomed);
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

  /** A closed tab's draft and terminals have nowhere to return to. */
  private forgetDrafts(ids: Iterable<string>): void {
    for (const id of ids) {
      if (id === this.pendingDraft) {
        this.pendingDraft = undefined;
      }
      this.drafts.forget(id);
      // A terminal belongs to its session tab: closing the tab kills its shells.
      this.terminals.forgetOwner(id);
      // A queued follow-up belongs to the tab too: closing it drops its queue.
      this.queued.forgetOwner(id);
    }
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
   * the tab beside its content, so revealing the same tab again is free. A
   * commit tab asks for the commit's diff instead of the working tree's.
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
    const request =
      tab.commitHash !== undefined
        ? this.morse.requestHostCommand('gitCommitDiff', {
            hash: tab.commitHash,
            path: tab.path,
          })
        : this.morse.requestHostCommand('gitDiff', { path: tab.path });
    void request.then((data) => {
      const diff = asDiff(data);
      if (diff === undefined) {
        this.patch(id, {
          diffLoading: false,
          diffError: tab.commitHash === undefined
            ? 'Could not read this file’s changes.'
            : 'Could not read this file in that commit.',
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

  /**
   * Turns the pending draft tab into the session that just got an id, in place.
   * The composer was editing that tab, so its draft follows the new id.
   */
  private promoteDraft(session: { id: string; title: string; cwd?: string }): void {
    const pendingId = this.pendingDraft;
    this.pendingDraft = undefined;
    if (pendingId === undefined) {
      return;
    }
    const activeDraft = this.items().find(
      (tab): tab is SessionTab =>
        tab.kind === 'session' && tab.id === pendingId && tab.draft === true,
    );
    if (activeDraft === undefined) {
      return;
    }
    // A session that already owns a tab is not what this draft became: the user
    // put an open session in front (clicked its tab) and the host followed, so
    // the draft is abandoned. Promoting here would leave two tabs for the same
    // session id instead of one.
    if (this.findSession(session.id) !== undefined) {
      this.discardEmptyDrafts();
      return;
    }
    this.drafts.rekey(activeDraft.id, session.id);
    // The draft's terminals belong to the session it just became.
    this.terminals.rekey(activeDraft.id, session.id);
    // The draft's queued follow-ups belong to the session it just became too.
    this.queued.rekey(activeDraft.id, session.id);
    this.items.update((tabs) =>
      tabs.map((tab) => {
        if (tab.kind === 'session' && tab.id === activeDraft.id) {
          return { kind: 'session', ...session };
        }
        // The draft's quoted files belong to the session it just became.
        if (tab.kind === 'file' && tab.mention === true && tab.sessionId === activeDraft.id) {
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

  /**
   * Drops draft tabs nobody typed into. A draft the reader filled in is kept:
   * its words live in the composer store and are theirs to return to.
   */
  private discardEmptyDrafts(): void {
    const doomed = this.items().filter(
      (tab): tab is SessionTab =>
        tab.kind === 'session' && tab.draft === true && this.drafts.isEmpty(tab.id),
    );
    if (doomed.length === 0) {
      return;
    }
    const ids = new Set(doomed.map((tab) => tab.id));
    this.items.update((tabs) => tabs.filter((tab) => !ids.has(tab.id)));
    if (this.pendingDraft !== undefined && ids.has(this.pendingDraft)) {
      this.pendingDraft = undefined;
    }
    for (const id of ids) {
      this.drafts.forget(id);
      this.terminals.forgetOwner(id);
      this.queued.forgetOwner(id);
    }
    this.pruneOrphanMentions();
  }

  private needsLoad(tab: WorkspaceTab): boolean {
    return (
      tab.kind === 'file' &&
      // A commit tab has no working-tree content to read: its diff is the view.
      tab.commitHash === undefined &&
      !tab.loading &&
      tab.content === undefined &&
      tab.error === undefined
    );
  }

  private async load(id: string): Promise<void> {
    const tab = this.items().find((candidate) => candidate.id === id);
    if (tab === undefined || tab.kind !== 'file') {
      return;
    }
    if (tab.commitHash !== undefined) {
      this.loadDiff(id);
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

/** A commit file's tab id: the same path in two commits is two diffs. */
function commitTabId(hash: string, path: string): string {
  return `commit:${hash}:${path}`;
}

/** The row a tab renders in: quoted files get their own, below the sessions. */
function tabRow(tab: WorkspaceTab): 'main' | 'mention' {
  return tab.kind === 'file' && tab.mention === true ? 'mention' : 'main';
}
