# Commit sidebar and the bottom Log view

Date: 2026-11-13
Status: proposed

## Intent and why

The git panel today carries the working tree and the whole commit history in the right
column, split by a divider. The owner wants the shell to read like an IDE with a bottom
tool window: the **right column is only for the branch and the commit**, and **history
moves into the bottom panel** as a tab beside the terminal. The log itself becomes its own
surface — branch tree, commit table, filters, and a details pane — instead of a section
inside the sidebar.

The bottom panel already exists: chips, a registry, drag-to-resize, full screen, and
per-session tool state. This change adds a second tool to it and removes history from the
column.

## Goals

- The right git column shows only the working tree: branch row, sync, commit form, staged
  and unstaged files, repo accordion. No history, no Changes/History divider. The open
  repository's detail keeps a dragged height (280–900px) with a handle at its bottom edge.
- The bottom panel gains a **Git Log** tab next to Terminal on hosts that advertise
  `gitPanel`, using the same chip/resize/full-screen machinery.
- The bottom tool window is a band of the shell, spanning every column, so the terminal
  and the log are never squeezed by the sidebars.
- The Log view shows one repository at a time:
  - a branch tree (HEAD, Local, Remote, tags) that selects which ref's history is listed;
  - a commit table with graph gutter, subject, refs, author, date and short hash;
  - filters for message/hash and author over the loaded commits;
  - paging as the list scrolls;
  - a selected commit's files and diff in a details pane;
  - drag handles between the branch tree and the list, and between the list and the
    details, remembered like a column's width.
- No avatars or email. The author is the name string the host already sends.
- `gitLog` accepts a **ref** so the tree selects an exact history, and `gitCommit` accepts
  **amend** so the commit form can rewrite HEAD.
- The commit form grows: multi-line message, Amend, Commit, Commit and Push.

## Non-goals

- Stash, worktrees, a git console, issue association, and AI compose/review/compare.
- Uncommitted changes per branch or per worktree. The host reports one working tree.
- Hunk-level staging. File-level stage/unstage stays.
- A paths filter: it would need every commit's file list before the list is drawn.
- Any motion work. Removing the anime.js dependency is a separate change.

## Anti-goals

- Dead controls: a Stash tab, a Worktrees list, or a filter with nothing behind it.
- Two sources of truth for history. The sidebar and the Log must read the same
  `GitPanelState`.
- Switching branches from the log tree. The tree **scopes the history**; checkout stays in
  the change sidebar's branch picker.
- Amending a pushed commit and pushing it back in one gesture. Commit and Push stands down
  while Amend is checked.
- Naming the interface this was modelled on anywhere in the document, plan or commits.

## Constraints

- **Shared state.** `GitPanelState` and `GitRepoState` are root-provided and already own
  repositories, history, branches, paging, status and mutations. Both surfaces read them;
  no second history loader.
- **Host scope.** The bottom panel only mounts where `capabilities.terminal` is true (the
  browser/server host). VS Code keeps its own Source Control and never sees the tab.
- **Panel state is per session.** `PanelState` already remembers the open tool per
  conversation; the Log tab uses it and needs no new storage.
- **Ref safety.** A client-supplied ref runs as one argv element, never through a shell.
  The existing conservative ref check (no leading `-`, whitespace, `..`, `@{`, `~^:?*[\`)
  is reused; an unusable ref is refused with a readable message.
- **Amend semantics.** Amend rewrites HEAD only. An empty message with Amend runs
  `git commit --amend --no-edit`, keeping the previous message; a typed message replaces it.
  A normal commit still refuses an empty message.
- **Filtering keeps the graph.** A filtered commit links to its nearest visible ancestor;
  a link that skipped hidden commits is dashed, so the graph stays connected instead of
  re-laying-out only the matches.
- **Paging.** A new ref resets the page cursor; `skip` and `max` behave as today. The
  "has more" heuristic stays `commits.length === GIT_PAGE_SIZE`.
- **Graph.** `layoutGraph` and the lane geometry stay; the Log renders the same edges and
  colours as today's rows.
- **Mock parity.** The in-memory host answers `gitLog` and `gitCommit`; it learns the same
  `ref` and `amend` arguments so `?mock=1` can review the Log's tree and the amend path
  without the server.

## Approaches considered

**A. Share the data, split the views (chosen).** `GitPanelState` stays the single source.
A new `GitLogView` joins the bottom-panel registry and injects it; the right panel's
template drops its History half. `GitRepoState` gains a `logRef` signal and its `commit()`
gains `amend`. One refresh path, one set of signals, two surfaces.

**B. A separate log service.** A `GitLogState` fetching its own repositories and pages.
Cleaner isolation, but duplicate discovery and two refresh pipelines that can disagree
about the same working tree, and every future git action would need wiring twice.

**C. One `GitPanel` component with two modes.** Cheapest start, but the 874-line component
would carry the accordion, both layouts and two sets of splitters; the modes would drift.

## Design

### Right column: Changes only

`features/git-panel` loses the History pane, the Changes/History divider and the detail
divider. What remains per repository is:

```
repo header (name, change count, branch picker)
  sync row (ahead/behind, upstream, Pull, Push)
  commit form (message, Amend, Commit, Commit and Push)
  file filter + staged count
  staged / unstaged rows with a stage checkbox
  repo detail ends
```

- The repo accordion, its open-section memory and the left-edge panel resize stay.
- With no second pane, the `changes` and `detail` pane heights retire from `LayoutState`,
  along with their splitters, stored keys and CSS. `PaneId` disappears; `LayoutState` is
  regions only.
- The Changes pane keeps its fold (`gitChangesCollapsed`); folding now reveals the repo
  headers, not a second section.
- **Checkboxes on file rows.** Each row carries a checkbox reflecting whether the path is
  staged; toggling stages or unstages that path. The Staged/Unstaged groups stay (they
  keep partial staging legible); an untracked path still appears under Unstaged.
- **The change rows are drawn by the panel, not `morse-tree`.** The shared tree has no
  checkbox and its row is one button; adding one there would put a checkbox in every list
  that uses it. A small `ChangeList` (group header + rows of checkbox, file icon, name,
  badge) renders the two groups, with the same fold memory as today. The tree stays for
  the Log's commit-files list, which needs no checkbox.
- File filter narrows the rows by path; the title shows `x of y staged`.
- Message is a textarea. `Ctrl/Cmd+Enter` commits; the buttons do the same as today.
- **Amend** sits beside the message. While it is checked, Commit and Push is disabled with
  a title explaining that amending rewrites the last commit.

### Bottom panel: the Git Log tab

The panel itself moves out of the conversation column and becomes the shell's third row,
spanning `1 / -1`; full screen gives it the middle row and hides the columns. Its own
dragged height still sizes the row.

`bottom-panel.ts` turns its static `VIEWS` into a computed list: Terminal always, Git Log
when `capabilities.gitPanel === true`. The id is `git-log`, the label `Git Log`, the
component `GitLogView`. The chip participates in the existing toggle/fold/full-screen
behaviour; no new state.

`features/git-log` is a new OnPush component reading `GitPanelState`:

- **Repository picker** — shown only when the project has more than one repository,
  defaulting to `GitPanelState.current`. Changing it switches the mounted repo state.
- **Branch tree** (left, ~220px): `HEAD (current branch)`, `Local`, `Remote`, `Tags`,
  from `GitBranches`. Selecting a ref calls the repo's `setLogRef(ref)`; selecting HEAD
  clears it. Checkout is not offered here.
- **Toolbar** — refresh, a message/hash filter, an author filter populated from the loaded
  commits, and the count of commits shown. Filters are client-side over loaded pages.
- **Commit table** — graph gutter, subject, refs, author, relative date, short hash.
  Refs are chips; the lane graph uses the existing geometry. Rows are airy and the subject
  is primary. Paging on scroll calls `loadMore()`.
- **Details pane** — selecting a row loads `gitCommitFiles`/`gitCommitDiff` for that hash
  and shows the touched files (click opens the commit diff in a preview tab, as today).
  On wide containers it is a third column; on narrow ones it opens below the list. An
  empty selection says so rather than showing a blank pane.
- **States** — loading, error, not-a-repository, empty history and "select a commit" each
  have their own line. The first open of the tab calls `GitPanelState.refresh()` and
  `loadBranches()`; the sidebar shares the result.

### Data and host

`GitRepoState`:

- `logRef: signal<string | undefined>` — `undefined` means HEAD. `setLogRef(ref)` resets the
  page cursor, clears the current items and reloads from `skip = 0`.
- `page(skip)` adds `...(logRef ? { ref: logRef } : {})` to `gitLog`.
- `commit(message, amend)` passes `amend` and allows the empty message only when amending.
- `loadBranches()` already exists; the Log calls it when opened.

`gitLog` (protocol → host):

- Optional `ref` argument. The host validates it with the existing ref guard; a bad ref is
  refused with a message. The command runs `git log --end-of-options <ref>`; no ref means
  `HEAD`, so the log follows the current branch and the lane column stays compact. `max`
  and `skip` still apply.
- The reply shape is untouched.

`gitCommit`:

- Optional `amend` boolean. Amend with a message runs `git commit --amend -m <message>`;
  amend without one runs `git commit --amend --no-edit`. Non-amend with an empty message
  keeps today's refusal.

## Tests

- **Host (`git-log.spec.ts`)**: a temp repo with two branches and distinct commits —
  `readGitLog(ref)` returns only that ref's history, `skip`/`max` still page; an unsafe ref
  is refused; amend changes the last commit and leaves the count unchanged, with and
  without a message.
- **State (`git-panel-state` specs)**: `setLogRef` resets paging and sends `ref`; `commit`
  forwards `amend` and allows an empty message only when amending.
- **`GitLogView`**: tree selection loads the ref, the table renders subject/refs/author/
  date/hash, filters narrow the rows, paging appends, a selected commit shows its files,
  and the empty/error states say their piece.
- **Bottom panel**: the Git Log chip appears only when `gitPanel` is advertised; opening it
  mounts the view; the existing terminal chip and fold/full behaviour are untouched.
- **Sidebar**: no history rows, no Changes/History divider, no detail splitter; commit and
  stage still work; Amend disables Commit and Push.
- **App**: the log tab appears in the server host's panel and not in a host without
  `gitPanel`.

## Decisions made on the owner's behalf

- Two surfaces, one state (approach A); the old Changes/History splitters and their layout
  sizes retire rather than stay as dead state.
- The branch tree scopes history; it never checks out a branch.
- Staged/Unstaged groups stay; checkboxes are added to rows. An "Unversioned Files" split
  can come later if the owner wants it.
- The change rows become a small panel-owned list rather than the shared tree, because the
  checkbox is not a tree concept.
- Filters: message/hash and author only.
- Details pane: third column when there is width, otherwise below the list.
- Commit and Push is disabled while Amend is checked.
- The bottom Log shows one repository at a time, with a picker only for multi-repo projects.

## What's left to the builder

- Exact details-pane breakpoint (container query) and whether the branch tree collapses on
  narrow panels.
- Whether the Log tab's refresh also refreshes the sidebar's status; it calls the shared
  `refresh()`, so both update.
- Whether a commit row also offers copy-hash in the Log (today's sidebar did).
- Iconography for the branch tree rows and the tab; reuse the existing git marks.
- A future "Unversioned Files" group and stash/worktree tabs, once the host grows them.
