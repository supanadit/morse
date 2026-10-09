<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-10-08 | Last verified: 2026-10-08 -->

# packages/ui-angular — AGENTS.md

**Precedence:** the closest `AGENTS.md` wins. This file overrides the root for files under `packages/ui-angular/`.

## Overview

The Angular frontend: views over `SessionView`, plus the app-local state that is not host state (tabs, panel, explorer, drafts, preferences). It is one frontend of a swappable pair — everything it renders it gets from the protocol.

| Path | Holds |
| --- | --- |
| `src/app/host/` | the seam to a host: `transport.token.ts` (the port), `morse.service.ts` (the client binding over it) and `view-state.ts` (one value persisted through the transport) |
| `src/app/state/` | app-local reactive state, no I/O and no DOM: `layout-state.ts` (the one home for the window's layout and every dragged size), `shell-state.ts`, `overlay-stack.ts`, `workspace-tabs.ts`, `workspace-files.store.ts`, `terminal-store.ts`, `panel-state.ts`, `mcp-state.ts`, `composer-drafts.ts`, `queued-prompts.ts`, `prompt-templates-state.ts`, `attachments.ts`, `display-prefs.ts`, `notification-prefs.ts`, `boot-handoff.ts` |
| `src/app/services/` | use-cases and adapters: `queue-drain.ts`, `workbench-persistence.ts`, `workspace-files.service.ts`, `git-panel-state.ts`, `update.ts`, `uploads.ts`, `shortcut.service.ts`, `shortcuts.catalog.ts`, `run-notifier.ts`, `notification-channel.ts` |
| `src/app/ui/` | Angular/DOM primitives and presentational atoms: `pane/` (the frame every panel is drawn in), `splitter/` (the one resize handle), `dialog/` (the shell every dialog is built on), `animation.service.ts`, `drop-zone.ts`, `drop-flight.ts`, `popover-fit.directive.ts`, `enter.directive.ts`, `shortcut-keys.ts`, `overlay-escape.ts`, `confirm-dialog.ts`, `markdown/markdown.ts`, `pin-annotation/` |
| `src/app/features/` | the view layer: **one directory per panel**, flat — `composer/`, `transcript/`, `session-nav/`, `git-panel/`, `about/`, … A panel may render the panels it is made of (the composer owns its pickers); the directory names the panel and nothing else |
| `src/app/shell/` | the `App`: layout composition — `app.ts`, `app.html`, `app.css`, and the rules as a test (`conventions.spec.ts`) |
| `src/app/routing/` | the route table and its targets: `routes.ts` (hash route → root component), `app.config.ts`, and `session-page/` (the `/session` target, which mounts the shell embedded); `src/main.ts` bootstraps a route into an element it creates |
| `src/styles.css` | the theme, `--morse-head-height`, and the rules VS Code's injected layer must not win |

## Layers

The internal layers, inner → outer. Each arrow means *depends on*, so a layer may depend only on layers to its right and may never depend on a layer to its left:

```
routing → shell → features → ui → services → state → host
```

- **R-U1** — A layer may depend only on layers to the right of it in that line, and may skip layers; it may never depend on a layer to its left.
- **R-U2** — a panel may render the panels it is made of, but no panel may depend on itself, directly or through another: a loop between two panels is the one shape that cannot be reasoned about, tested or moved apart, and `shell/conventions.spec.ts` looks for it.
- **R-U3** — `ui/` imports nothing from `features/`, `shell/` or `routing/`.
- **R-U4** — `services/` imports nothing from `ui/` (this is what keeps the chain acyclic).
- **R-U5** — `state/` imports nothing from `services/`; it talks to the host through `host/`.
- **R-U6** — `host/` imports no other layer and, of the Morse packages, only `@morse/protocol` and `@morse/ui-runtime`. (A framework package is not a Morse package: every service injects `@angular/core`.)
- **R-U7** — Only `shell/` and `routing/` may import from more than one feature.
- **R-U8** — Any layer may import `@morse/protocol` and `@morse/ui-runtime` freely: those are the framework-free core, which sits below `host`.

Enforced by `shell/conventions.spec.ts` on every run, which applies R-U1, R-U2, R-U6, R-U7 and the stylesheet rule below to every production file — a broken arrow fails there with the file and the specifier. `docs/ARCHITECTURE.md` § *Inside a frontend* carries the same list.

## Setup

`npm install` at the root, then `npm run dev:ui` (`ng serve`; :4200 may be taken → `--port 4321`). `proxy.conf.mjs` forwards `/ws`; `MORSE_SERVER_URL` or `?server=` points at another host, and `?mock=1` needs no host at all.

## Build / tests

| Task | Command |
| --- | --- |
| Build | `npm run build -w @morse/ui-angular` (`ng build` + `write-manifest.mjs`) |
| Type-check | none of its own — there is no `check-types` script here; `ng build` is the type-check |
| Tests | `npm run test -w @morse/ui-angular` (`ng test` → `@angular/build:unit-test`, vitest + jsdom, no display) — part of `npm run test:fast` |
| Sync into the extension | `npm run sync-webview` after any UI change |

## Panes and sizes

- A panel is drawn inside **`morse-pane`** (`ui/pane/`): it passes a title (and a count) and
  its content, and nothing else. The title bar is the frame the shell owns — that is what a
  docking drag will take hold of — so a panel must not grow a header of its own.
- A handle is **`[morseSplitter]`** (`ui/splitter/`): it declares which size it drags
  (`[morseSplitter]="'left'"`), which side it is on (`edge`), and how far it may go. It
  measures, follows the pointer, clamps, disables the shell's column transition, and resets
  on a double-click. Never write a `pointerdown` resize of your own.
- Every dragged size lives in **`LayoutState`** (`layout-state.ts`) — `size(id)` /
  `setSize(id, px, persist)`, `persist: false` while a drag runs — and the **shell** puts it
  on screen as a CSS variable (`--morse-nav-width`, `--morse-explorer-height`, …). A panel
  reads its own size from that variable in its stylesheet and never binds it in its
  template: a size bound onto the panel re-renders every row inside it, once a frame.

## Code style

- **UI state comes only from `reduceSessionView`** (`@morse/protocol`); a component reads `state.capabilities` instead of guessing what the host can do.
- **A shortcut is one entry in `services/shortcut.service.ts` plus a `bind()` by whoever owns the state it acts on** (the composer binds the model chooser, the thinking picker its own panel) — never a second key handler per component, so the `?` help list prints exactly what the service matches, and an unowned action shows as unavailable rather than promised.
- Only a spec marked `whileTyping` may fire with the caret in an input/textarea; only a spec marked `overlay` may open while `ShellState.modalOpen()`.
- **A dialog is built on `morse-dialog`** (`ui/dialog`), never on a hand-written `.modal-layer`: the shell owns the layer, the card, the click outside, `aria-modal` and the registration that makes it the overlay Escape is talking about. A dialog passes its own measurements as `--morse-card-*` on `morse-dialog` and adds no document key listener of its own.
- **CSS lives beside its component**, never inside it: `styleUrl: './x.css'` and `templateUrl: './x.html'`, no inline `styles: [...]` or `template:` in the class. A stylesheet buried in the class is what made `git-panel.ts` 1570 lines, 879 of them CSS; the class is about behaviour, the stylesheet about the look. `shell/conventions.spec.ts` fails an inline block. A `*.spec.ts` host may keep its throwaway inline template.
- CSS: a custom control that paints a hover state on a global `button` rule needs the same specificity to win (`.row:hover:not(:disabled)`, likewise `.group-title`, `.context-menu-item`, …). Both header rows read `--morse-head-height`; never give one its own padding.
- App-local state that must survive a reload goes through `services/workbench-persistence.ts` (and `host/view-state.ts` for a single value), not ad-hoc `localStorage`.

## Security

Rendered HTML (assistant markdown, code blocks, terminal links) is sanitized in `@morse/ui-runtime`'s `render/markdown.ts` with DOMPurify before it reaches the DOM — a new renderer must go through it, and untrusted text never becomes `innerHTML`. The view layer holds no credentials and no tokens: a stored preference is a preference, and a capability it did not verify (for example the `Notification` permission) must be re-read, never assumed.

## Commit / PR

- Conventional commits (`feat(ui): …`, `fix(ui): …`), one logical change per commit.
- A UI change is not done until `npm run build` (+ `npm run sync-webview`) ran — the VS Code host serves the copied bundle, not this source tree.
- Add or fix a spec beside the state it covers (`*.spec.ts` beside the state it covers); the UI has no other test surface.

## Examples

- `@morse/ui-runtime/src/render/markdown.ts` — parse, sanitize, highlight (the render cadence lives in `ui/markdown/markdown.ts`), in one shared place.
- `state/workspace-tabs.ts` — the tab/chip ownership model (owner session, menu scope, chip owner); read it before touching tab behaviour.
- `services/shortcut.service.ts` + `features/shortcuts-dialog/shortcuts-dialog.ts` — the registry and the list that prints it are the same data.
- `state/shell-state.ts` — signals for the shell's persisted knobs and the confirm dialog.

## Gotchas

| Symptom | Cause / fix |
| --- | --- |
| Browser UI stuck on `connecting` / `no model` | the dev server is not proxying `/ws` — check `packages/ui-angular/proxy.conf.mjs`, `MORSE_SERVER_URL` or the `?server=` override |
| UI shows `Starting the Pi agent…` | normal (cold start ~1.5 s): lifecycle is the badge (`connecting` → `starting` → `ready`), not a banner |
| UI shows one group and no project switcher | that host is `scope: 'workspace'` (VS Code) — intended, not a bug |
| `pi: No session found matching 'draft'`, agent exits code=1 | a draft tab was activated as a real session: never send `session/activate` for a tab whose `draft` flag is set (`packages/ui-angular/src/app/state/workspace-tabs.ts`); the host is already showing it |
| A banner flashes on every load | it must not: banners render only for a refused handshake, `error`/`closed`, or a handshake stalled > 6 s (`slowConnection`). The first such state after the cold start is the friendly `ConnectionScreen`, not a banner |
| A setup screen instead of the chat | `pi` is not on the host's `PATH`; the screen names the command to install and the setting/env var that host reads (`state.agentFailure`) |
| Panel has ~20px left/right margin in VS Code only | VS Code injects `@layer vscode-default { body { padding: 0 20px } }` into every webview; Morse must declare an unlayered `body { padding: 0 }` in `styles.css` to win |
| Resizing a panel stutters, or its list flickers while the pointer moves | the size is being bound in the panel's own template (or onto its host): a preview frame then re-renders every row in the pane. The size belongs in `LayoutState`, applied by the shell as a CSS variable, with the drag owned by `[morseSplitter]` |
| Sidebar comes back folded after a reload | intended: `ShellState` keeps the wide-layout fold in `localStorage` (`morse.navigation.collapsed`); clear that key to reset it |
| Compact (or `/compact`) seems to do nothing | it asks first: `ShellState.requestCompact()` opens `morse-confirm-dialog`, where Cancel is focused on purpose |
| Typing a project name in the sidebar finds no sessions | that box searches session titles only — the project button above it opens the searchable filter; the empty state offers the matching project as a jump |
| Sidebar and chat headers out of line | both rows read `--morse-head-height`; giving one of them its own padding/`min-height` is how they drift apart |
| A shortcut does nothing | no owner bound it: the action is registered by the component that owns the state (the composer, the sidebar), so a `?` list row marked "not in this host" is the honest answer — bind it there, not in `App` |
| No hover, no squiggles, no jump in the file preview | either `capabilities.lsp` is off (VS Code: its own LSP owns those files) or no server resolved for that language — the header then shows `LSP —` rather than a clean file. Install `typescript-language-server` (or set `MORSE_LSP_TS`); the resolution order is env → the project's `node_modules/.bin` → `PATH` → `npx -y` |
| The first hover over a file does nothing | by design: the host answers only from a server that is already answering, and starts a cold one in the background instead of making the request wait on `npx` (the preview's own diagnostics request is what warms it). The second hover works |
| A problem is in the list but has no squiggle | `Range.getClientRects` is missing in that DOM (jsdom, older WebKit), so the overlay measures nothing; `measureMarks` degrades to the header list on purpose instead of throwing |
| A jump opens the file but not the line | `FileTab.line` is only set by a jump (`openFile(path, line)`) and consumed once; a plain Explorer click opens at the top, and a tab already open is moved with `revealLine` |
| The hover card vanishes when reaching for "Find references" | it pins itself after `HOVER_LOCK_MS` (900 ms, the ring counts that down), and is then taken over by a hover that *settles* on another symbol, or ended by its ✕, Escape, or a press anywhere *outside* it (a press on the card is its own controls: Copy, Find references, ✕). Everything the pointer does is decided after `HOVER_DEBOUNCE_MS` (140 ms): a cursor crossing a word or a bracket on its way elsewhere changes nothing — it neither dismisses a card nor asks for one — while resting on a new symbol replaces the card and restarts the countdown; resting on the *same* symbol keeps the card and its clock. Before the pin, a 260 ms grace (`HOVER_CLOSE_DELAY_MS`) covers the pointer crossing to the card. Clicking **Find references** closes the card and opens the panel at once (it reads `Reading references…`, then `The language server did not answer.` if nothing comes back), so the card never sits on top of the list it asked for |
| A highlighted range cannot be removed from the preview | it can, two ways: the band's own **Cancel** button (bottom right of every highlight, including the band of a drag in progress) or a click on a highlighted line number (the toggle the diff view's change blocks use). Either way the composer's chip goes with it — the bands are derived from the pins. A *drag* inside a highlight still redefines it, and Escape only abandons a drag in progress |
| `/` or `?` fires while typing a prompt | characters belong to the field: only specs marked `whileTyping` may run with the caret in an input/textarea |
| A character typed with AltGr triggers an action | Windows reports AltGr as Ctrl+Alt; `ShortcutService` skips `getModifierState('AltGraph')` |
| An overlay opens behind a dialog | specs marked `overlay` stand down while `ShellState.modalOpen()`; mark the new one or it will stack |
| Two dialogs close on one press of Escape | it must not: the shell owns the only Escape listener (`ui/overlay-escape.ts`) and hands the press to the top of `state/overlay-stack.ts`, which `ui/dialog` joins while it is up. A dialog that adds its own `document:keydown.escape` puts the bug back |
| A shortcut fires behind a dialog that is up | `ShellState.modalOpen()` is `OverlayStack.depth()`, not the list of dialog flags: a dialog (or a panel) built without `ui/dialog` never registers, so the stack cannot see it |
| A dialog's card is the wrong size, or does not scroll | the shell owns `.modal-layer`/`.modal-card`; the dialog sets `--morse-card-width`, `--morse-card-max-height`, `--morse-card-padding`, `--morse-card-gap` or `--morse-card-overflow` on `morse-dialog` in its own stylesheet (the defaults are in `ui/dialog/dialog.css`) |
| The update notice never appears | the host must advertise `capabilities.updateCheck` (`MORSE_UPDATE_CHECK=0` disables it, and the VS Code webview CSP must list `https://registry.npmjs.org`); review it offline with `?mock=1&newer=0.3.0` |
| No pi update notice (the Morse one shows) | the host could not read the installed pi version, so it advertised no `capabilities.piVersion`; `readPiVersion` needs pi's own `package.json` (a symlinked `pi` is followed). Review it offline with `?mock=1&newer-pi=9.9.9` |
| `/prompts` is missing, or the editor says it cannot load | the entry is the Morse command **Edit prompt templates** (`view.prompts`, `Ctrl+Alt+E`) in the command palette, not a pi slash command; it is hidden when `capabilities.promptEditor` is off (the host could not reach pi's prompt directories) |
| The argument tester lags a keystroke behind the body | intended: the body/hint parse is debounced 200 ms (RxJS `debounceTime` in `prompt-editor.ts`), so the field list does not flicker on a half-typed `$`. Selecting a template and saving read the signals directly, not the debounced copy |
| No notification when a run finishes | it is **off by default**: turn it on from the one-time `.notify-prompt` nudge or the palette (`Turn on completion notifications`). `state/notification-prefs.ts` also picks the mode (`away` by default, so it stays quiet while the panel is focused; `always` speaks every time). VS Code raises it through `capabilities.notify` → the `notify` host command; the browser host uses the `Notification` API and needs the permission granted. If the permission is revoked later, `RunNotifier.permission` re-reads it on focus / `navigator.permissions` and the banner returns as **blocked** — the stored preference alone must not claim it works |
| The thinking dropdown keeps the previous model's levels after a model pick | intended, and now visible: pi scopes the levels to the *current* model, so they can only be re-read after the switch — RPC for a live session, a re-probe of pi for a draft. `HostSessionController.setModel` sets `loadingThinkingLevels`, so the picker spins in the trigger, shows `Reading this model's levels…`, and disables the rows (they belong to the previous model). A model the registry already probed applies in the same frame via `SessionRegistry.cachedDraftDefaults`; a newer pick keeps its own loading row (`thinkingLevelsRefresh`) |
| Streamed prose lags the model by a beat | intended: `Markdown` re-renders at most every 90 ms instead of per delta; measure `docs/DEVELOPMENT.md` before removing it |
| A session tab shows a different conversation after a while | it is pinned: a pinned controller ignores another surface's `session/activate` and returns to the empty draft when its session is closed or deleted, instead of adopting a hot one. If a tab follows the sidebar, the controller was built without `pinnedSessionId` |
| A session tab is one empty column | `.shell.embedded` must outrank `.shell.collapsed`: the fold is persisted (`morse.navigation.collapsed`), so a reader who once folded the sidebar would otherwise collapse the tab's only column to zero. The embedded rule carries both classes (`.shell.embedded.collapsed`) because the fold rule sits later in the file |
| The chat shows the Morse hero with no tab in front | intended: the browser host renders `morse-empty-session` and does **not** mount the composer when `tabs.activeId()` is undefined (`app.html` `noSessionSelected`), so a prompt cannot silently open a session. Create one from the placeholder, the sidebar, or `Ctrl+Alt+N`; the lazy "type to start" path is only for a host without a tab strip (VS Code) |
| The header names the previous project when no session is open | intended: `WorkspaceTabs.noSessionInFront` (the same signal `App` uses) is true, so `ChatHeader` shows `Morse` and drops the workspace from its meta line instead of claiming `state.workspace.name`. The workspace is still whatever the host last had; only a session tab in front makes it the subject |
| A file opens as its own tab instead of a chip, or a pin lands in another session | the row follows the session in front: `WorkspaceTabs.openFile`/`openCommitFile` attach the file to `focusedOwner()` (a chip keyed by that session) when a session tab exists, and stand alone only when none does. `contextSessionId` uses the owner so the composer/preview pin stays with it; a chip is removed with its session |
| A file chip's context menu closes the session tab | a menu's scope is the clicked tab's own: `WorkspaceTabs.menuScope(id)` returns the whole strip for a session but only the chip's row for a file. `closeOthers`/`closeToTheRight`/`closeAll` must read that scope, never `items()` directly — a chip is context, and closing it must not take a session with it |
| Closing the last chip jumps to another session’s file | `WorkspaceTabs.remove` takes the closed chip's owner session and selects it (`chipOwner`), instead of the positional neighbour in `items` — a chip is context for its session, so closing the chip in front returns to that conversation |
| Two file chips look identical | intended: when any file name in the row is shared, the whole chip row goes two lines and every chip shows its directory, clipped at the front (`.dir` with `direction: rtl` and a `<bdi>` in `tab-strip`, so the folder nearest the file stays visible). With no shared name every chip is one row. If two still look identical, their names are not in the same row — `namesClash` counts chips per session row |
| A new file is missing from the Explorer | it polls `gitStatus` every 4 s, and re-reads `listFiles{fresh: true}` only when that working tree moved (or every 60 s regardless, and always on a project switch); a hidden tab pauses the poll. No host push — the tree changes on disk. The status is asked for **before** the list, because the decision has to come from the tree this tick just read: a tick that issued both commands together decided from the previous tick's status and re-read the list one tick (4 s) after the tree had already moved |
| Editing a component's look means editing TypeScript | it should not: the stylesheet is a sibling `x.css` (`styleUrl`) and the template a sibling `x.html` (`templateUrl`). `shell/conventions.spec.ts` fails an inline `styles:`/`template:` — the CSS belongs to the file, the class to the behaviour |
| File/session tabs vanish on reload | intended only in VS Code (its own editor restores tabs). The browser host persists the open/focused tabs, panel and terminals to `<MORSE_HOME>/workbench.json` — check `capabilities.workbench` and `services/workbench-persistence.ts`; a snapshot from another `version` is ignored on purpose |
| Terminal dies on a tab switch, a hidden panel, or after `morse stop`/`start` | the shell must outlive the view: a `Terminal` never sends `terminal/close` on destroy — only an explicit reader close does (`TerminalView.close`/`closePane`, `WorkspaceTabs.closeOwnerTerminals`), and the bottom panel is hidden with a class rather than `@if`-unmounted (`app.ts` `bottomPanelEnabled` mounts, `bottomPanelVisible` hides). A draft holding a terminal is not discarded as "untouched" (`TerminalStore.hasOwner`) |
| A long prompt or its attachments vanish on reload / `morse stop` / a closed laptop | intended only in VS Code. The browser host saves every tab's draft — text, pins, mentions and inline images — to `<MORSE_HOME>/drafts.json` (`state/composer-drafts.ts`, `state/attachments.ts` via `WorkbenchPersistence`); the tab itself, a "New session" draft included, lives in `workbench.json` |
| Terminal pane stays blank and no shell is ever spawned | the xterm packages are CommonJS: a production bundle's lazy chunk exports only `default`, so `core.Terminal` is `undefined` and the pane silently never calls `terminal/open` — go through `importCjs` in `features/terminal/terminal.ts`. A unit mock with named exports hides this, so the specs mirror the `default`-only shape |
| A custom button paints the theme accent on hover | the global `button:hover:not(:disabled)` (specificity 0,2,1) beats a plain `.row:hover` (0,2,0); write the override as `.row:hover:not(:disabled)` (same for `.group-title`, `.context-menu-item`, …) |
| The Explorer cannot be resized | it can: drag its top edge (`.resize`); the height persists in `morse.explorer.height` via `ShellState` |

## When stuck

| Need | File |
| --- | --- |
| keyboard shortcuts + the `?` help list | `packages/ui-angular/src/app/services/shortcut.service.ts` ← `features/shortcuts-dialog/shortcuts-dialog.ts` |
| a model's input modalities (text/vision/audio/…) | `packages/ui-angular/src/app/features/model-picker/model-inputs.ts` ← pi's `input` on `ModelOption.input` |
| "a newer release is out" notice (Morse or pi) | `packages/ui-angular/src/app/services/update.ts` ← `capabilities.updateCheck`/`piVersion`, `docs/CONFIGURATION.md` |
| "a run finished" notice while the window is elsewhere | `packages/ui-angular/src/app/services/run-notifier.ts` + `notification-prefs.ts` ← `capabilities.notify` |
| git history + graph panel (browser host) | `packages/ui-angular/src/app/features/git-panel/git-panel.ts` ← `git/graph.ts`, `git/status.ts`, `git/diff.ts` in `@morse/ui-runtime`, `packages/server/src/internal/workspace/git-log.ts` |
| the layer rules, or the stylesheet rule — as a test rather than a promise | `packages/ui-angular/src/app/shell/conventions.spec.ts` |
| a dialog: the card, the Escape order, who is on top | `packages/ui-angular/src/app/ui/dialog/dialog.ts` ← `state/overlay-stack.ts` + `ui/overlay-escape.ts` |
| MCP servers list/enable/disable + indicator | `packages/ui-angular/src/app/features/mcp-panel/` ← `state/mcp-state.ts`, `packages/adapter-pi-rpc/src/pi-mcp.ts` (reads `~/.pi/agent/mcp.json` + `.pi/mcp.json`, status from `pi mcp list --json`) |
| prompt-template editor + argument tester | `packages/ui-angular/src/app/features/prompt-editor/` ← `state/prompt-templates-state.ts`, `packages/ui-runtime/src/prompt-template.ts` (the same expansion the composer uses); host file I/O in `packages/adapter-pi-rpc/src/pi-prompts.ts`; code-split, and scoped to the session in front |
| who is credited, and where | `packages/ui-angular/src/app/features/about/credits.ts` (guarded by `credits.spec.ts`) |
| pi is not installed (setup screen) | `packages/ui-angular/src/app/features/agent-screen/agent-screen.ts` ← `state.agentFailure` |
| cold-start splash → empty-state handoff | `packages/ui-angular/src/app/features/boot-splash/boot-splash.ts`, `packages/ui-angular/src/app/state/boot-handoff.ts` |
| offline / no-host screen | `packages/ui-angular/src/app/features/connection-screen/connection-screen.ts` |
| frontend state that must survive a reload | `packages/ui-angular/src/app/host/view-state.ts` ← `HostTransport.readState/writeState` (VS Code webview state, mock memory), `localStorage` fallback; VS Code panels also need `registerWebviewPanelSerializer` |
| measured performance baseline | `docs/DEVELOPMENT.md` ← session catalog cache, markdown render cadence |
| interface preferences a user can change | `docs/CONFIGURATION.md` §Interface preferences |
| reviewing a view with no host | `docs/FRONTENDS.md` §Developing a frontend without any host |
