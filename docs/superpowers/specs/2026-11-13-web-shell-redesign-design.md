# The web shell — reference-driven redesign

Date: 2026-11-13
Status: implemented

## Intent and why

The browser host looked like a VS Code panel that happened to be served over HTTP.
The owner's words: *"Refactory layout and redesign, currently looks like very sloopy."*
The supplied reference is Alpaca Labs' web app: a one-row bar with a mode row and a
centred command box; a quiet sidebar whose sections are labels over rows, not stacked panes.

Two constraints came with it:

- **VS Code keeps its own theme.** Colours there come from the user's editor, as today.
- **The web gets a palette Morse defines**, instead of the OS-preference fallback.

## Goals

- One top bar in the reference's language: the `Morse` wordmark, the mode row (`Code` now,
  `Bot` drawn but inert), a centred command box with its real shortcut printed, the
  window's buttons.
- A sidebar that is the session list, and only that: `New chat`, the session search, a
  `Sessions` section with the project tree. The file Explorer leaves the sidebar.
- A calm, dark web palette — near-black surfaces, hairline borders, a system sans UI face,
  soft pills — applied through the existing `--morse-*` tokens so no component is forked.
- Both hosts share the structure; only the palette is scoped.

## Non-goals

- A redesign of the conversation, composer, transcript or any right-hand panel. They
  inherit the palette and otherwise stay as they are.
- A working `Bot` mode. It is a disabled tab with a `Soon` mark.
- A light web theme. The web palette is dark whatever the OS preference; VS Code still
  follows the editor's theme, dark or light.
- Deleting the Explorer component. It is no longer mounted in the sidebar but stays in the
  tree for a future surface.

## Constraints

- `ui-angular` is one bundle for two hosts. The host is known before the first script runs:
  VS Code injects `acquireVsCodeApi`, a browser does not. `index.html` writes
  `document.documentElement.dataset.host` (`vscode` / `web`) from that fact, so the palette
  is already right at first paint, with no flash and no second stylesheet.
- Components style themselves; a parent cannot reach into a child's DOM. The pane's title
  type is therefore tunnelled through CSS variables (`--morse-pane-title-*`) with the old
  values as defaults, so the git and search panes do not change.

## Approaches considered

**A. A second stylesheet per host.** Two bundles, or a `link` swapped at boot. Rejected:
two palettes to keep in sync, and every new token has to be added twice.

**B. A host attribute and one additive palette block (chosen).** `[data-host='web']`
overrides the tokens after the existing `:root` and light-media blocks. VS Code matches no
rule. One file, one place to change a colour, no component knows which host it is in.

**C. A theme picker for the web.** More control, more UI and state to build. Not asked for;
the reference is one look.

## Design

**Bar (`shell/toolbar`).** `identity` = drawer/fold switches, the existing `Morse` wordmark
(no new logo mark), the mode segmented control, the status dot. `command` = the search box,
centred, with `kbd` holding `bindingLabel(binding)` read from `SHORTCUTS` (the same catalog
the keyboard uses). `actions` = the existing buttons, untouched. Container queries drop the
words at 1020px and move the command to its own row at 759px, so a 300px VS Code sidebar
still fits.

**Sidebar (`features/session-nav`).** `New chat` sits above the pane, next to the search,
so folding the list never hides the two things a reader needs before there is a list. The
project filter moves into the pane's title bar (`Sessions 12 · All projects · refresh`) and
still opens the same dialog. The Explorer is not mounted. Fold still hides every row and
keeps the two controls.

**Rows (`ui/tree-list`).** The active row is a tinted pill, not a row with an accent rule;
labels are 12.5px with a little more vertical padding. The shared tree keeps its behaviour.

**Palette (`styles.css`).** `[data-host='web']` sets `color-scheme: dark`, a system sans
stack, near-black surfaces (`#1c1c1c` shell, `#1a1a1a` sidebar, `#202020` chrome), `8%`
white hairlines, a near-white accent (buttons carry `--morse-accent-fg`, so a light accent
still reads), and the reference's green/orange data colours. The font is the largest single
difference from the old browser look: the whole UI used to render in JetBrains Mono.

**Accent foreground.** Four component rules hard-coded `#fff` on top of the accent (the
composer's send button, the branch picker's primary, the git commit button, the transcript's
edit-send). They now read `--morse-accent-fg`, which the web palette sets to near-black —
otherwise a light accent would paint white on white.

**Button cascade.** The global button look and its hover are declared inside `:where(...)`,
so they carry zero specificity and any component rule wins. Before, a transparent icon, menu
row or footer button lost its own `background` to the global `button:hover` rule and flashed
the full accent — which, with the web's near-white accent, meant a white flash on hover.
Component hovers that need to beat a component base rule still add `:not(:disabled)`.

## What's left to the builder

- Whether the web should grow a light variant of the palette; it would be a second
  `[data-host='web']` block under a preference the settings page does not yet have.
- ~~Whether the unmounted Explorer becomes a `Files` mode in the bar or is deleted.~~ It became the rail's
  `Files` view: `2026-11-13-left-rail-and-explorer-panel-design.md`.
