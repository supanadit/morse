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
  /**
   * The project the file was opened under. The host resolves a preview against
   * the viewing session's directory, which is not necessarily this file's when a
   * restored tab is loaded before its own session is in front, so the tab
   * carries the directory it was read from.
   */
  projectCwd?: string;
  /** Opened from a commit's file list: the diff is `git show <hash>`, not HEAD. */
  commitHash?: string;
  /** The commit's subject, so the preview can name the commit it is showing. */
  commitSubject?: string;
}

export type WorkspaceTab = SessionTab | FileTab | McpTab | PromptTab;

/**
 * The MCP editor, opened in the strip. There is exactly one (`MCP_TAB_ID`), so
 * "Add server" re-focuses the open editor instead of stacking a second one.
 */
export interface McpTab {
  kind: 'mcp';
  id: string;
  title: string;
}

/**
 * The prompt-template editor, opened in the strip. There is exactly one
 * (`PROMPT_TAB_ID`), like the MCP editor: `/prompts` re-focuses it.
 */
export interface PromptTab {
  kind: 'prompt';
  id: string;
  title: string;
}

/**
 * One tab as it is written to `<MORSE_HOME>/workbench.json`. Only the durable
 * half is kept: a session's id/title/cwd (a draft keeps its `draft` flag), a
 * file's path and how it was opened. A preview's content (and a commit's diff)
 * is read again on restore, so the file stays small and the view is never a
 * stale copy of the disk.
 */
export type PersistedTab =
  | { kind: 'session'; id: string; title: string; cwd?: string; draft?: boolean }
  | { kind: 'mcp'; id: string; title: string }
  | { kind: 'prompt'; id: string; title: string }
  | {
      kind: 'file';
      id: string;
      path: string;
      title: string;
      mention?: boolean;
      sessionId?: string;
      language?: string;
      commitHash?: string;
      commitSubject?: string;
      projectCwd?: string;
    };

/** What the strip remembers across a reload: its tabs, and which one was in front. */
export interface TabsSnapshot {
  tabs: PersistedTab[];
  activeId?: string;
}

const FILE_PREFIX = 'file:';
/** Files opened from the `@` picker live in a second row, so the prefix differs. */
const MENTION_PREFIX = 'mention:';
/** There is one MCP editor tab, whatever the directory. */
export const MCP_TAB_ID = 'mcp:servers';
/** There is one prompt-template editor tab, whatever the directory. */
export const PROMPT_TAB_ID = 'prompt:templates';

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
  /**
   * True while a restored layout owns the front tab. The host's reattached
   * session must join the strip without stealing focus, so the first
   * `showSession` after a restore keeps the restored active tab and only asks
   * the host to switch when that tab is another session. Cleared by that first
   * `showSession` (or `endRestore`, when the host never sends one).
   */
  private restorePending = false;

  constructor() {
    // The composer edits the draft of the tab in front. Pointing the store here,
    // where the active tab is known, keeps a half-typed message with its session
    // even while the composer is unmounted by a file preview.
    effect(() => this.drafts.use(this.composerKey()));
  }

  readonly tabs = this.items.asReadonly();
  readonly activeId = this.active.asReadonly();
  /** The first row: sessions, and files opened with no session in front. */
  readonly mainTabs = computed(() =>
    this.items().filter(
      (tab) => tab.kind !== 'file' || tab.mention !== true,
    ),
  );
  readonly activeTab = computed<WorkspaceTab | undefined>(() =>
    this.items().find((tab) => tab.id === this.active()),
  );
  /**
   * No session is in front on a host that shows the strip: the panel is the empty
   * placeholder, not a conversation. Only a tabbed host has this state — VS Code
   * has no strip, and its session-less panel is a normal "start a session".
   */
  readonly noSessionInFront = computed(
    () => this.morse.capabilities()?.filePreview === true && this.active() === undefined,
  );
  /**
   * The session the strip is showing context for: the active session tab, or the
   * owner of the file in front. `undefined` when neither is a session (a plain
   * file standing alone), so no session's context leaks into another's view.
   *
   * Public because the strip uses it to mark the session a chip belongs to.
   */
  readonly contextSessionId = computed<string | undefined>(() => {
    const tab = this.activeTab();
    if (tab?.kind === 'session') {
      return tab.id;
    }
    if (tab?.kind !== 'file' || tab.sessionId === undefined) {
      return undefined;
    }
    // A file opened from the Explorer or git carries the session it was opened
    // under, so a pin from its preview lands in that conversation. The id only
    // counts while that session is still open: a stale one falls through to the
    // host's active session instead of reviving a closed tab.
    return this.findSession(tab.sessionId) !== undefined ? tab.sessionId : undefined;
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
   * The second row: the files attached to the session in front, as chips — from
   * the Explorer, the git panel, or the `@` picker. A file attached to another
   * session is not this session's context, so it does not appear here.
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
    // A pick is the reader's own navigation: it always wins over a restored
    // layout's hold on the front tab.
    this.restorePending = false;
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
    if (this.restorePending) {
      // A restored layout owns the front tab. The host's reattached session is
      // added without being brought forward; when the restored tab is a *different*
      // session, the host is asked to switch to it, which is what makes the tab
      // the reader left on the one they see. A restored file tab — or a restored
      // "New session" draft — leaves the host on the session it reattached; a
      // restored draft is not promoted here, so the first prompt still fills it in.
      this.restorePending = false;
      this.ensureSession(session);
      const active = this.activeTab();
      if (active?.kind === 'session' && active.draft !== true && active.id !== session.id) {
        this.morse.activateSession(active.id, active.cwd);
        return;
      }
      if (active === undefined) {
        this.active.set(session.id);
      }
      return;
    }
    this.promoteDraft(session);
    this.ensureSession(session);
    this.active.set(session.id);
  }

  /**
   * What the strip remembers: every tab, in order, and the one in front. A draft
   * is kept too — its tab carries the reader's half-written "New session", and the
   * prompt itself lives in the saved drafts.
   */
  snapshot(): TabsSnapshot {
    // A quoted file is that session's context, so it only survives with the
    // session it was quoted in; files quoted in a draft are left out together.
    const sessionIds = new Set(
      this.items()
        .filter((tab): tab is SessionTab => tab.kind === 'session' && tab.draft !== true)
        .map((tab) => tab.id),
    );
    const tabs = this.items().flatMap<PersistedTab>((tab) => {
      if (tab.kind === 'session') {
        return [
          {
            kind: 'session',
            id: tab.id,
            title: tab.title,
            cwd: tab.cwd,
            ...(tab.draft === true ? { draft: true } : {}),
          },
        ];
      }
      if (tab.kind === 'mcp') {
        return [{ kind: 'mcp', id: tab.id, title: tab.title }];
      }
      if (tab.kind === 'prompt') {
        return [{ kind: 'prompt', id: tab.id, title: tab.title }];
      }
      if (tab.mention === true && (tab.sessionId === undefined || !sessionIds.has(tab.sessionId))) {
        return [];
      }
      return [
        {
          kind: 'file',
          id: tab.id,
          path: tab.path,
          title: tab.title,
          ...(tab.mention === true ? { mention: true } : {}),
          // Only an owner that is still an open session is worth restoring; a
          // stale one would resurrect a closed conversation on the next boot.
          ...(tab.sessionId !== undefined && sessionIds.has(tab.sessionId)
            ? { sessionId: tab.sessionId }
            : {}),
          ...(tab.language !== undefined ? { language: tab.language } : {}),
          ...(tab.commitHash !== undefined ? { commitHash: tab.commitHash } : {}),
          ...(tab.commitSubject !== undefined ? { commitSubject: tab.commitSubject } : {}),
          ...(tab.projectCwd !== undefined ? { projectCwd: tab.projectCwd } : {}),
        },
      ];
    });
    const active = this.active();
    return {
      tabs,
      ...(active !== undefined && tabs.some((tab) => tab.id === active) ? { activeId: active } : {}),
    };
  }

  /**
   * Applies a layout from `~/.morse/workbench.json`. Tabs are built without
   * their content: a file is re-read from disk the moment it is selected (or is
   * already in front), so the preview is never a stale copy. An unknown shape is
   * ignored — a layout written by another version is not worth guessing at.
   */
  restore(snapshot: unknown): void {
    const parsed = asTabsSnapshot(snapshot);
    if (parsed === undefined) {
      return;
    }
    const items = parsed.tabs.flatMap<WorkspaceTab>((tab) => {
      if (tab.kind === 'session') {
        return [
          {
            kind: 'session',
            id: tab.id,
            title: tab.title,
            cwd: tab.cwd,
            ...(tab.draft === true ? { draft: true } : {}),
          },
        ];
      }
      if (tab.kind === 'mcp') {
        return [{ kind: 'mcp', id: tab.id, title: tab.title }];
      }
      if (tab.kind === 'prompt') {
        return [{ kind: 'prompt', id: tab.id, title: tab.title }];
      }
      return [
        {
          kind: 'file',
          id: tab.id,
          path: tab.path,
          title: tab.title,
          language: tab.language ?? languageForPath(tab.path),
          loading: false,
          ...(tab.mention === true ? { mention: true } : {}),
          ...(tab.sessionId !== undefined ? { sessionId: tab.sessionId } : {}),
          ...(tab.commitHash !== undefined ? { commitHash: tab.commitHash } : {}),
          ...(tab.commitSubject !== undefined ? { commitSubject: tab.commitSubject } : {}),
          ...(tab.projectCwd !== undefined ? { projectCwd: tab.projectCwd } : {}),
        },
      ];
    });
    this.items.set(items);
    const active =
      parsed.activeId !== undefined && items.some((tab) => tab.id === parsed.activeId)
        ? parsed.activeId
        : undefined;
    this.active.set(active);
    this.restorePending = active !== undefined;
    // A restored "New session" is still pending the first prompt that fills it in.
    const activeTab = items.find((tab) => tab.id === active);
    this.pendingDraft =
      activeTab?.kind === 'session' && activeTab.draft === true ? active : undefined;
    // A new draft must not reuse a restored `draft-N` id.
    this.draftCounter = items.reduce(
      (highest, tab) =>
        tab.kind === 'session' && tab.draft === true
          ? Math.max(highest, draftNumber(tab.id))
          : highest,
      this.draftCounter,
    );
    const inFront = this.activeTab();
    if (inFront?.kind === 'file' && this.needsLoad(inFront)) {
      void this.load(inFront.id);
    }
  }

  /**
   * Releases a restored layout's hold on the front tab. The browser host calls
   * this when its reattached session never arrived (a host with no open session),
   * so a later session does not silently fail to come forward.
   */
  endRestore(): void {
    this.restorePending = false;
  }

  /**
   * Opens the one MCP editor tab, or brings it forward when it is already open.
   * A single tab is the point: "Add server" while the editor is up is a focus,
   * never a second editor holding a half-filled form.
   */
  openMcp(): void {
    const existing = this.items().find((tab) => tab.id === MCP_TAB_ID);
    if (existing !== undefined) {
      this.active.set(MCP_TAB_ID);
      return;
    }
    this.items.update((tabs) => [
      ...tabs,
      { kind: 'mcp', id: MCP_TAB_ID, title: 'MCP servers' },
    ]);
    this.active.set(MCP_TAB_ID);
  }

  /**
   * Opens the one prompt-template editor tab, or brings it forward when it is
   * already open — `/prompts` is a focus, never a second editor.
   */
  openPrompt(): void {
    const existing = this.items().find((tab) => tab.id === PROMPT_TAB_ID);
    if (existing !== undefined) {
      this.active.set(PROMPT_TAB_ID);
      return;
    }
    this.items.update((tabs) => [
      ...tabs,
      { kind: 'prompt', id: PROMPT_TAB_ID, title: 'Prompt templates' },
    ]);
    this.active.set(PROMPT_TAB_ID);
  }

  /**
   * Opens or reveals a file tab from the Explorer. With a session in front the
   * file is that session's **chip** (the row that never pushes a session tab
   * aside); with no session it stands on its own, like a session.
   */
  openFile(path: string): void {
    const owner = this.focusedOwner();
    this.placeFileTab(`${FILE_PREFIX}${path}`, path, path, owner.id !== undefined, owner.id, owner.cwd);
  }

  /**
   * Opens a file's diff *inside a commit*, from the git panel's expanded row. It
   * is its own tab, separate from the working-tree preview of the same path — the
   * diff is against the commit, not HEAD — and follows the same rule as the
   * Explorer: a chip for the session in front, a plain tab when there is none.
   */
  openCommitFile(hash: string, path: string, subject: string): void {
    const owner = this.focusedOwner();
    const commitId = commitTabId(hash, path);
    this.placeFileTab(commitId, commitId, path, owner.id !== undefined, owner.id, owner.cwd, {
      commitHash: hash,
      commitSubject: subject,
    });
  }

  /**
   * Opens or reveals a file tab from the `@` picker. It always belongs to the
   * session in front — a chip in that session's row, keyed by it, so the same
   * path quoted elsewhere is a second chip.
   */
  openMentionFile(path: string): void {
    const owner = this.focusedOwner();
    this.placeFileTab(`${FILE_PREFIX}${path}`, path, path, true, owner.id, owner.cwd);
  }

  /**
   * The session a file opened right now belongs to: the tab in front (a session,
   * or a file that already carries one), else the host's active session — but only
   * while that session has a tab to attach to. With no session to belong to, a
   * file from the Explorer or git stands alone instead of becoming a chip nobody
   * can see.
   */
  private focusedOwner(): { id?: string; cwd?: string } {
    const tab = this.activeTab();
    if (tab?.kind === 'session') {
      return { id: tab.id, cwd: tab.cwd ?? this.morse.state().workspace?.cwd };
    }
    if (tab?.kind === 'file' && tab.sessionId !== undefined && this.findSession(tab.sessionId) !== undefined) {
      return { id: tab.sessionId, cwd: tab.projectCwd ?? this.morse.state().workspace?.cwd };
    }
    const host = this.morse.state().sessionId;
    if (host !== undefined && this.findSession(host) !== undefined) {
      return { id: host, cwd: this.morse.state().workspace?.cwd };
    }
    return { cwd: this.morse.state().workspace?.cwd };
  }

  /**
   * Opens or reveals one file tab in the form the caller asked for: attached to a
   * session (`mention`, a chip in its row, id keyed by the session) or standing
   * alone (a main-row tab). Attaching a path that is already open on its own moves
   * that tab rather than leaving the same file open twice.
   */
  private placeFileTab(
    standaloneId: string,
    mentionKey: string,
    path: string,
    mention: boolean,
    sessionId: string | undefined,
    projectCwd: string | undefined,
    extra: Partial<FileTab> = {},
  ): void {
    const id = mention ? mentionTabId(sessionId, mentionKey) : standaloneId;
    const existing = this.items().find((tab) => tab.id === id);
    if (existing !== undefined) {
      if (existing.kind === 'file') {
        this.revealFileTab(id, existing, sessionId, projectCwd);
      }
      return;
    }
    // The path may be open in the other form; move it rather than duplicate it.
    const standalone = mention
      ? this.items().find((tab): tab is FileTab => tab.kind === 'file' && tab.id === standaloneId)
      : undefined;
    if (standalone !== undefined) {
      const reread = standalone.projectCwd !== projectCwd;
      this.items.update((tabs) =>
        tabs.map((tab) =>
          tab.id === standalone.id && tab.kind === 'file'
            ? { ...tab, id, mention: true, sessionId, projectCwd, ...(reread ? clearedPreview() : {}) }
            : tab,
        ),
      );
      this.active.set(id);
      if (reread || this.needsLoad(standalone)) {
        void this.load(id);
      }
      return;
    }
    this.items.update((tabs) => [
      ...tabs,
      {
        kind: 'file',
        id,
        path,
        title: basename(path),
        language: languageForPath(path),
        loading: false,
        mention,
        sessionId,
        projectCwd,
        ...extra,
      },
    ]);
    this.active.set(id);
    void this.load(id);
  }

  /** Focuses an already-open file tab, re-reading it when its project moved. */
  private revealFileTab(
    id: string,
    tab: FileTab,
    sessionId: string | undefined,
    projectCwd: string | undefined,
  ): void {
    const reread = tab.projectCwd !== projectCwd;
    if (tab.sessionId !== sessionId || reread) {
      this.patch(id, { sessionId, projectCwd, ...(reread ? clearedPreview() : {}) });
    }
    this.active.set(id);
    if (reread || this.needsLoad(tab)) {
      void this.load(id);
    }
  }

  select(id: string): void {
    const tab = this.items().find((candidate) => candidate.id === id);
    if (tab === undefined) {
      return;
    }
    // Clicking the chip already in front goes back to its session: the chip is
    // that conversation's context, so a second click means "show me the chat
    // again", not a no-op. A file with no session has nowhere to go.
    if (
      id === this.active() &&
      tab.kind === 'file' &&
      tab.mention === true &&
      tab.sessionId !== undefined
    ) {
      const owner = this.findSession(tab.sessionId);
      if (owner !== undefined) {
        this.select(owner.id);
        return;
      }
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
    this.remove(this.doomedWith(id), index, chipOwner(tab));
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
    this.remove(this.doomedWith(id), index, chipOwner(this.items()[index]));
  }

  /**
   * The host shows no session (an empty draft): a real session tab cannot be the
   * one on screen. Clears the active flag so a stale tab does not look active
   * over an empty panel; a draft tab stays, since it *is* that empty session.
   */
  clearActiveSession(): void {
    // A restored layout still owns the front tab; the host's empty draft must not
    // clear it before the session the layout asked for has had a chance to open.
    if (this.restorePending) {
      return;
    }
    const active = this.items().find((tab) => tab.id === this.active());
    if (active !== undefined && active.kind === 'session' && active.draft !== true) {
      this.active.set(undefined);
    }
  }

  /**
   * The tabs a context-menu action applies to. A session's menu is the whole
   * strip (its quoted files go with it), but a file chip is context, not
   * navigation: its menu is limited to its own row, so closing it can never take
   * a session tab with it. No `id` means the whole strip.
   */
  private menuScope(id: string | undefined): WorkspaceTab[] {
    const target = id === undefined ? undefined : this.items().find((tab) => tab.id === id);
    if (target === undefined || target.kind === 'session') {
      return this.items();
    }
    if (target.kind === 'file' && target.mention === true) {
      return this.items().filter(
        (tab): tab is FileTab =>
          tab.kind === 'file' && tab.mention === true && tab.sessionId === target.sessionId,
      );
    }
    return this.items().filter(
      (tab) =>
        tab.kind === 'mcp' ||
        tab.kind === 'prompt' ||
        (tab.kind === 'file' && tab.mention !== true),
    );
  }

  /** Whether a tab has anything to its right inside its own menu scope. */
  canCloseToTheRight(id: string): boolean {
    const scope = this.menuScope(id);
    const index = scope.findIndex((tab) => tab.id === id);
    return index !== -1 && index < scope.length - 1;
  }

  /** Whether “Close Others” would remove anything within this tab's scope. */
  canCloseOthers(id: string): boolean {
    return this.menuScope(id).length > 1;
  }

  /**
   * Keeps only `id` — plus, when it is a session, its quoted files, which cannot
   * outlive it — inside the tab's own scope. (VS Code's "Close Others".)
   */
  closeOthers(id: string): void {
    const keep = this.items().find((tab) => tab.id === id);
    if (keep === undefined) {
      return;
    }
    const scope = this.menuScope(id);
    const keepIds = new Set<string>([id]);
    if (keep.kind === 'session') {
      for (const mention of this.mentionFilesOf(id)) {
        keepIds.add(mention.id);
      }
    }
    const closing = scope.filter((tab) => !keepIds.has(tab.id));
    if (closing.length === 0) {
      return;
    }
    const closingIds = new Set(closing.map((tab) => tab.id));
    const closedSession = closing.some((tab) => tab.kind === 'session' && tab.draft !== true);
    const cwd = closing.find((tab): tab is SessionTab => tab.kind === 'session')?.cwd;
    this.items.update((tabs) => tabs.filter((tab) => !closingIds.has(tab.id)));
    this.forgetDrafts(closingIds);
    this.active.set(id);
    if (keep.kind === 'session' && keep.draft !== true) {
      this.morse.activateSession(keep.id, keep.cwd);
    }
    // A closed session may orphan its quoted files; a file-scoped close cannot.
    this.pruneOrphanMentions();
    if (closedSession) {
      this.fallBackToEmptySession(cwd);
    }
  }

  /** Closes every tab to the right of `id` in its scope (VS Code's "Close to the Right"). */
  closeToTheRight(id: string): void {
    const scope = this.menuScope(id);
    const index = scope.findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }
    const closing = scope.slice(index + 1);
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

  /**
   * Closes a tab's scope (VS Code's "Close All"): the whole strip for a session,
   * or only its row for a file chip. Without an `id`, everything goes.
   */
  closeAll(id?: string): void {
    const scope = this.menuScope(id);
    if (scope.length === 0) {
      return;
    }
    const ids = new Set(scope.map((tab) => tab.id));
    const closedSession = scope.some((tab) => tab.kind === 'session' && tab.draft !== true);
    const cwd = scope.find((tab): tab is SessionTab => tab.kind === 'session')?.cwd;
    // A chip scope is one session's context: when the chip in front goes with it,
    // the reader lands on that session, not on whichever tab happens to sit last
    // in the strip. The positional neighbour is only right for a whole-strip close.
    const ownerSessionId = chipOwner(scope[0]);
    const active = this.active();
    this.items.update((tabs) => tabs.filter((tab) => !ids.has(tab.id)));
    this.forgetDrafts(ids);
    this.pruneOrphanMentions();
    if (active !== undefined && ids.has(active)) {
      if (ownerSessionId !== undefined && this.findSession(ownerSessionId) !== undefined) {
        this.select(ownerSessionId);
      } else {
        const remaining = this.items();
        const neighbour = remaining.at(-1) ?? remaining[0];
        if (neighbour !== undefined) {
          this.select(neighbour.id);
        } else {
          this.active.set(undefined);
        }
      }
    }
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
  private remove(doomed: Set<string>, index: number, ownerSessionId?: string): void {
    const active = this.active();
    this.items.update((tabs) => tabs.filter((tab) => !doomed.has(tab.id)));
    this.forgetDrafts(doomed);
    if (active === undefined || !doomed.has(active)) {
      return;
    }
    // A chip is context for its session, so closing the one in front goes back to
    // that conversation — not to whichever file happens to sit beside it in the
    // list (a chip of another session, usually). The positional neighbour is only
    // the fallback when the owner is gone or this was not a chip.
    if (ownerSessionId !== undefined && this.findSession(ownerSessionId) !== undefined) {
      this.select(ownerSessionId);
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
            cwd: tab.projectCwd,
          })
        : this.morse.requestHostCommand('gitDiff', { path: tab.path, cwd: tab.projectCwd });
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
    if (tab.kind !== 'file') {
      return false;
    }
    // A commit tab has no working-tree content to read: its diff is the view.
    if (tab.commitHash !== undefined) {
      return tab.diff === undefined && tab.diffLoading !== true && tab.diffError === undefined;
    }
    return !tab.loading && tab.content === undefined && tab.error === undefined;
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
    const data = await this.morse.requestHostCommand('readFile', {
      path: tab.path,
      cwd: tab.projectCwd,
    });
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

/**
 * The persisted `{ tabs, activeId }` shape, with every entry that is not a
 * usable tab dropped. A layout from an unknown version (or a hand-edited file)
 * degrades to the entries that still make sense instead of throwing at boot.
 */
function asTabsSnapshot(value: unknown): TabsSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const rawTabs = candidate['tabs'];
  if (!Array.isArray(rawTabs)) {
    return undefined;
  }
  const tabs = rawTabs.flatMap<PersistedTab>((entry) => {
    const tab = asPersistedTab(entry);
    return tab === undefined ? [] : [tab];
  });
  const activeId = candidate['activeId'];
  return {
    tabs,
    ...(typeof activeId === 'string' ? { activeId } : {}),
  };
}

function asPersistedTab(value: unknown): PersistedTab | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate['id'];
  if (typeof id !== 'string' || id.length === 0) {
    return undefined;
  }
  if (candidate['kind'] === 'session') {
    const title = candidate['title'];
    if (typeof title !== 'string') {
      return undefined;
    }
    const cwd = candidate['cwd'];
    return {
      kind: 'session',
      id,
      title,
      ...(typeof cwd === 'string' ? { cwd } : {}),
      ...(candidate['draft'] === true ? { draft: true } : {}),
    };
  }
  if (candidate['kind'] === 'mcp') {
    const title = candidate['title'];
    if (typeof title !== 'string') {
      return undefined;
    }
    return { kind: 'mcp', id, title };
  }
  if (candidate['kind'] === 'prompt') {
    const title = candidate['title'];
    if (typeof title !== 'string') {
      return undefined;
    }
    return { kind: 'prompt', id, title };
  }
  if (candidate['kind'] !== 'file') {
    return undefined;
  }
  const path = candidate['path'];
  const title = candidate['title'];
  if (typeof path !== 'string' || typeof title !== 'string') {
    return undefined;
  }
  const sessionId = candidate['sessionId'];
  const language = candidate['language'];
  const commitHash = candidate['commitHash'];
  const commitSubject = candidate['commitSubject'];
  const projectCwd = candidate['projectCwd'];
  return {
    kind: 'file',
    id,
    path,
    title,
    ...(candidate['mention'] === true ? { mention: true } : {}),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof language === 'string' ? { language } : {}),
    ...(typeof commitHash === 'string' ? { commitHash } : {}),
    ...(typeof commitSubject === 'string' ? { commitSubject } : {}),
    ...(typeof projectCwd === 'string' ? { projectCwd } : {}),
  };
}

function asDiff(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const diff = (value as { diff?: unknown }).diff;
  return typeof diff === 'string' ? diff : undefined;
}

/** The `N` in `draft-N`; 0 when the id is not a draft id this store minted. */
function draftNumber(id: string): number {
  const match = /^draft-(\d+)$/.exec(id);
  return match === null ? 0 : Number.parseInt(match[1]!, 10);
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

/**
 * Drops a file tab's content and diff, so a reveal that changed the project reads
 * the new directory instead of showing the old one's bytes.
 */
function clearedPreview(): Partial<FileTab> {
  return { content: undefined, error: undefined, diff: undefined, diffError: undefined };
}

/** The row a tab renders in: files attached to a session get their own, below the sessions. */
function tabRow(tab: WorkspaceTab): 'main' | 'mention' {
  return tab.kind === 'file' && tab.mention === true ? 'mention' : 'main';
}

/** The session a chip belongs to, so closing the chip in front can return there. */
function chipOwner(tab: WorkspaceTab | undefined): string | undefined {
  return tab?.kind === 'file' && tab.mention === true ? tab.sessionId : undefined;
}
