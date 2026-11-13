# The left rail and the Explorer panel

Date: 2026-11-13
Status: approved

## Intent and why

The web-shell redesign removed the file Explorer from the sidebar (`2026-11-13-web-shell-redesign-design.md`,
"What's left to the builder": *whether the unmounted Explorer becomes a `Files` mode in the bar or is deleted*).
The owner wants it back, but not stacked in the session sidebar again. The reference is VS Code: a narrow
activity rail on the far-left edge, with **Sessions** first and **Explorer** below it, and one panel beside
the rail that shows whichever view is in front.

The Explorer is not a second sidebar. It is the same left column, wearing one of two faces.

## Goals

- A fixed-width icon rail on the far-left edge of the web shell, always visible while the shell is.
- Two entries, top to bottom: **Sessions** (the menu, the search, the project/session tree) and
  **Explorer** (the project's files).
- One panel beside the rail showing exactly one of those views — the existing left column, at its stored
  width (288px in the web palette unless dragged); picking the other swaps the face without doubling the
  column.
- Clicking the active entry folds the panel (rail stays); clicking an inactive entry switches to it and
  opens the panel if it was folded.
- The folded state, the chosen view and the panel width keep their current/stored behaviour.
- The Explorer becomes a full-height column panel, not a drag-to-resize strip under the session list.
- VS Code, and the embedded session-tab surface, keep today's layout untouched.

## Non-goals

- More rail entries. Search, git and terminal stay where they are (toolbar buttons / right column). A future
  entry can be added to the same component; this change does not build the future one.
- A second, simultaneous Explorer column. The panel is one column with two faces.
- A rail in VS Code. The window already has an activity bar and an Explorer (`filePreview: false`).
- A global keyboard shortcut for switching views. The rail is pointer/focus reachable; a shortcut is a later
  addition to `SHORTCUTS` if the owner asks.
- Redesigning the session list or the Explorer's rows. Their internals stay; only the frame changes.
- A light-theme variant of the rail. It inherits the web palette and the VS Code tokens.

## Anti-goals

- A generic VS Code clone with placeholder entries. Every rail entry must open a real, working view.
- Two mounted, visible copies of the left column on any width.
- Keeping the Explorer's old height splitter as dead state "for later". It loses its surface here; the state
  goes with it.
- The rail disappearing when the panel folds, which would make the screenshot's model a lie.

## Constraints

- **Two hosts, one bundle.** The rail exists only where the Explorer does: `capabilities.filePreview === true`
  (the browser/server host). VS Code advertises `false`, and the embedded surface (`embedded` input) renders no
  left column at all. Both keep today's left column facing and behaviour; the panel wrapper is the only
  addition.
- **The rail is chrome, not a region.** `LayoutState` models columns the reader can drag, fold and remember
  (`left`, `main`, `right`). The rail is a fixed 48px strip with no drag, no stored width and no independent
  visibility. It is a class on the shell (`.with-rail`) plus a CSS variable, not a fourth `RegionId`.
- **Emulated encapsulation.** The parent cannot reach into a child's DOM, but it can style a child's host
  element. The panel wrapper (`.nav`) therefore owns the layout; the view components fill it.
- **Grid placement.** Today's shell relies on auto-placement with 2–3 column templates. A fourth optional
  track breaks that (auto-placement would put the nav into a 0px rail track on hosts with no rail). The
  design uses explicit grid areas instead so every host/width combination is stated once.
- **Session shortcuts must survive the swap.** `SessionNav` binds `session.new`, `session.search` and
  `project.filter` in its constructor. Unmounting it when Files is in front would silently unbind them, so it
  stays mounted and hidden.
- **Reduced motion.** The panel's fold transition already respects `prefers-reduced-motion`; the rail adds no
  new animation.

## Approaches considered

**A. Rail as a shell column; the panel swaps faces (chosen).** A 48px rail track at the left edge, the existing
left column beside it, and `leftPane` state choosing sessions or files. The fold hides the panel and keeps
the rail. Matches the reference exactly and leaves the command/toolbar model alone.

**B. A strip inside the session sidebar's top edge.** No new column, but the strip folds away with the
sidebar and steals vertical room from the tree. It is not the screenshot's model and would need a second
redesign when a third entry arrives.

**C. Rail plus a separate Explorer column.** Both views visible at once. Rejected: 48 + 288 + 288 before the
conversation starts, a fourth template combination for every existing one, and two remembered widths. The
reference keeps one panel.

## Design

### Rail (`features/activity-rail`)

A new standalone, OnPush component, `morse-activity-rail`, rendered by the shell only while
`capabilities.filePreview === true` and not `embedded`.

- Markup: `<nav class="rail" aria-label="Views">` with two `<button type="button">` entries, Sessions then
  Explorer. Each carries `title`, `aria-label` ("Sessions view" / "Explorer view"), `aria-pressed` for the
  active entry, and a visible 2px accent bar plus brighter foreground when active.
- Marks: the existing document sprite (`#morse-session` for Sessions, `#morse-folder` for Explorer). No new
  assets, no external fetch (the VS Code webview rule). The rail draws at 20px inside a 40px hit area.
- Styling: `--morse-rail-width: 48px`, background `--morse-bg`, a right hairline (`--morse-border`), entries
  muted by default and `--morse-fg` when active/hovered. Hover uses `--morse-hover`. Focus uses the global
  focus ring. The rail is chrome, so its background is the shell's, not the panel's.
- Interaction (the rail owns the switch, the way the toolbar owns the right column's):
  - choose a view different from the current one: set it, and if the panel is folded, open it;
  - choose the view already in front: toggle the panel folded/open.
- Which "folded" that means depends on the width, and the rail reads `(min-width: 760px)` at click
  time (CSS stays the visual decider; this is only the handler). **Wide:** `LayoutState.setVisible('left', …)`
  / `toggleVisible('left')`, the stored fold. **Narrow:** `ShellState.openNavigation()` /
  `toggleNavigation()`, the drawer — never `LayoutState`, whose stored preference belongs to the desktop
  layout and must not be rewritten by using the drawer.
- The component reads `ShellState.leftPane` and both fold signals; it owns no state of its own.

### View state (`ShellState`)

- Add `export type LeftPane = 'sessions' | 'files';` beside `RightPane`.
- Add a stored signal, key `morse.left.pane` (values `sessions` | `files`; default `sessions`), with
  `leftPane` and `setLeftPane`, mirroring `rightPane`. A new key, so no stored-layout migration.
- The tabbed host has no files view: the shell's effective view is `sessions` when
  `capabilities.filePreview !== true`, without overwriting a stored `files` preference (a reader moving
  between hosts keeps it).
- The stored view is read at construction; a stored `files` opens Files on the next web load.

### Shell (`shell/app.html`, `shell/app.css`, `shell/app.ts`)

- Render `<morse-activity-rail class="rail" />` before the left column, gated as above.
- Wrap the left column in a plain `div.nav` (keeping the class, the `.open` drawer state and the width
  variable). Inside it, render both views as `.left-view` children:
  - `morse-session-nav` always, `[hidden]` when the view is files (shortcuts stay bound);
  - `morse-file-explorer` only after Files has been selected once (lazy first mount), `[hidden]` when the
    view is sessions. After that it stays mounted so its expanded folders, filter and scroll survive a swap.
- **The column's right-edge resize handle moves from `SessionNav` to the wrapper**, so it exists over both
  faces. It is the same `morseSplitter="'left'"`, `edge="right"` handle and the same stored width; only its
  owner changes. `App` imports `Splitter`; `SessionNav` drops it (and its `.edge-resize` styles move to
  `app.css`), because a handle that vanishes when Files is in front would make the column unresizable in
  the view that shows long paths.
- `.nav` becomes a flex column filling the middle row, `position: relative` (the handle is absolute against
  it); `.left-view` children take `flex: 1; min-height: 0`, and an explicit
  `.left-view[hidden] { display: none }` beats each component's `:host { display: flex }`.
- Grid: use named areas and one rule per real combination:
  - no rail: `nav main` (+ `git` when the right column is mounted), collapsed `nav` track 0;
  - with rail: `rail nav main` (+ `git`), collapsed `rail nav(0) main`;
  - git expanded: `rail nav git` / `nav git` with the conversation column absent;
  - embedded: `main` only.
  `.rail { grid-area: rail }`, `.nav { grid-area: nav }`, `.chat { grid-area: main }`,
  `.git-panel, .search-panel { grid-area: git }`.
- Fold: `.shell.collapsed` zeroes the nav track and keeps `.rail`; `.shell.collapsed .nav { visibility: hidden }`
  continues to cover focus. The toolbar's fold button is unchanged.
- Narrow (<760px): the rail keeps its track and sits above the scrim (z-index above the drawer's scrim, below
  dialogs), so it stays usable while the drawer is open. The drawer starts at the rail's right edge and its
  width accounts for both edges (`min(100% - 96px, 420px)`). Clicking the active entry closes the drawer through
  the same toggle path. Hosts without a rail keep the current full-width drawer.
- Remove `--morse-explorer-height` from the shell host bindings and the `explorerHeight` computed.

### Explorer as a column panel (`features/file-explorer`)

- Delete the height machinery: the `Splitter` import, `.resize` handle, `folded`/`collapsed` signals,
  `toggleFold`, `MIN_EXPLORER_HEIGHT`, `explorerMax`, and the folded host class. The pane's title is an
  ordinary label (`folded` input omitted), keeping the refresh action, the filter and the tree.
- Host fills its column: `height: 100%`, flex column, `min-width: 0`, no top border; background
  `--morse-nav-bg` and a right hairline so it reads as the same column as the session list.
- The filter and rows always render (no `@if (!collapsed())` wrappers); `.rows` keeps the scroll.
- Behaviour is unchanged: click a file → `WorkspaceTabs.openFile`; clicking a folder toggles; the active
  file is revealed and scrolled into view; the git badges and lazy directory levels stay.
- The Explorer is no longer gated on a session being in front. It reads the host's workspace, which exists
  without an open tab; VS Code's Explorer behaves the same. The old `!noSessionInFront()` condition and the
  two spec assertions built on it go.
- Retire the Explorer's pane id: remove `'explorer'` from `PaneId`, its min/max, its `SIZE_KEYS` entry and
  `LayoutState.explorerSize`, plus the splitter specs that drag it. Its height has no surface left.

### Hosts

- **Web/server** (`filePreview: true`): rail + two-face panel; everything above.
- **VS Code** (`filePreview: false`): no rail, no Explorer mount, the left column remains `morse-session-nav`
  exactly as today. Toolbar, git and search are already capability-gated and do not change.
- **Embedded session tab** (`embedded: true`): no rail and no left column, as today.

### Accessibility

- The rail is a `nav` landmark labelled "Views"; buttons are real buttons with accessible names and
  `aria-pressed`. The active entry is visually distinct without relying on colour alone (accent bar + fill).
- Hidden views use `display: none`, so their controls leave the tab order; the visible view keeps its own
  focus handling. Switching views moves no focus implicitly.
- The panel fold keeps `aria-expanded` on the toolbar button; the rail's `aria-pressed` says which face is in
  front even while the panel is folded.

### Tests

- New `activity-rail.spec.ts`: order (Sessions above Explorer), active marking, switch-and-open, active-entry
  toggle on a wide layout (`LayoutState`), and the same toggle on a narrow one (`ShellState` drawer, stored
  fold untouched), and that it renders no other entries.
- `app.spec.ts` / a web-host spec: rail renders with `filePreview`; choosing Files hides `morse-session-nav`,
  shows `morse-file-explorer`; choosing Sessions reverses it; folding keeps `morse-activity-rail` and the
  session view mounted; the stored `morse.left.pane` is applied; a host without `filePreview` renders no rail;
  the column's resize handle is present in both views.
- `app.embedded.spec.ts`: still no rail, no session nav, no Explorer.
- `file-explorer.spec.ts`: drop folded/height expectations; keep filter, reveal and row behaviour.
- `splitter.spec.ts` / `layout-state` specs: remove the explorer-size cases.
- `app.bottom-panel.spec.ts`: replace the two "never an Explorer" assertions with "not mounted until Files is
  chosen", and add the no-session case showing the Explorer once chosen.

## Decisions made on the owner's behalf

- Rail width 48px, entries 40px, order Sessions then Explorer ("below session").
- The rail is visible on narrow windows too, with the drawer beside it, rather than losing access to Files.
- Session nav stays mounted when hidden; the Explorer mounts on first use and then stays.
- The column's resize handle moves to the shell wrapper, so both faces can be resized.
- The Explorer is available without an open session, because it is the workspace's tree, not a tab's.
- The Explorer's drag-height state is deleted, not preserved.
- Clicking the active rail entry folds/unfolds the panel, the VS Code gesture; on narrow it toggles the
  drawer, leaving the stored desktop fold alone.
- The old redesign document's "what's left" note gets a one-line pointer to this decision (the plan carries it).

## What's left to the builder

- The exact sprite choice for Files (`morse-folder` versus a new files glyph) if the folder reads as a
  tree-row mark rather than a rail mark.
- Whether a third rail entry is worth adding now; the design deliberately says no.
- Whether the rail should animate its accent bar; defaults to no new motion.
- Up/down arrow navigation within the rail (a roving-tabindex pattern). Not needed for two entries; add it
  when a third arrives.
