# File tree icons — design

Date: 2026-11-12
Status: awaiting approval

## Intent and why

The Explorer's tree draws no icons at all, and its `├─ └─` connector lines make it read
as a plain-text outline. JetBrains' Project view (the reference the user supplied) reads
better for one reason: every row carries a small coloured file-type icon, and the
hierarchy is carried by indentation alone. The owner's words: "Jetbrains IDE had good
tree view with Icons, ours don't."

## Goals

- Every row in the Explorer's tree carries a file-type icon: grey outline for folders
  (open/closed), a coloured mark per language/file type.
- Rows line up on a single icon column, the way the JetBrains screenshot does.
- Both hosts (browser bundle and VS Code webview) and both light and dark themes render
  the same icons, with no network access and no font requirement.
- The Explorer's filtered flat list uses the same icons, so searching and browsing agree.

## Non-goals

- Real JetBrains icon assets (licensing), and icon-theme packages (`material-icon-theme`
  or similar). No new dependency.
- Keyboard navigation, context menus, drag & drop, multi-select, sticky parents, or
  breadcrumbs. Those are the rest of the "feels janky" task and stay open.
- The tab strip's `fileGlyph()` marks, the session tree's rows, and file preview.
- Lettering inside the icons (JetBrains' `TS`/`RS` marks). Silhouettes and colour only.

## Constraints

- `ui-angular` is a single bundle for two hosts. Asset URLs that start with `/` work in
  the browser host but not in the VS Code webview (see the font note in `styles.css`), so
  an external `.svg` sprite is out. The sprite must live in the document.
- The theme is one stylesheet with `--morse-*` variables, `--vscode-*` first in VS Code
  and hardcoded fallbacks in the browser. Icons must read on both a dark and a light
  background.
- `TreeList` is shared by the Explorer and the session list, so any new row slot has to
  be optional and leave session rows unchanged.

## Approaches considered

**A. Hand-drawn SVG sprite inside the document (chosen).** ~20 `<symbol>`s in a
component mounted once, rows reference them with `<use href="#…">`. ~5 KB, no dependency,
fixed brand colours work on both themes, folder icons take `currentColor`.

**B. An icon-theme package** (`material-icon-theme`, `@iconify/json`). Hundreds of types
for free, but a new dependency, a licence to check, a payload bigger than the whole pane,
and it produces VS Code's look rather than the reference screenshot's.

**C. Nerd Font glyphs.** Zero assets, but the icons vanish into tofu boxes on any machine
without the font, and `styles.css` only names Nerd Font as a *fallback* for the text font.

## Design

**Mapping (`ui-runtime`, next to `fileGlyph`).**

```ts
export type IconKind =
  | 'folder' | 'folder-open'
  | 'ts' | 'js' | 'json' | 'css' | 'html' | 'markdown' | 'yaml'
  | 'shell' | 'sql' | 'go' | 'python' | 'php' | 'java' | 'rust'
  | 'image' | 'lock' | 'git' | 'generic';

export function fileIcon(name: string): IconKind;
```

Extension first, then a few exact names (`package-lock.json` → `lock`, `Dockerfile` →
`generic`, `Makefile`, `.gitignore` → `git`). No match → `generic`. `fileGlyph()` stays:
the tab strip still uses it.

**Sprite (`ui/file-icon/`).**

- `icon-sprite.ts`: one component, `<svg aria-hidden="true" class="sprite">` holding the
  `<symbol>`s, mounted exactly once in `app.html` beside the shell. Never visible.
- `file-icon.ts`: `input.required<IconKind>()`, draws
  `<svg class="file-icon" viewBox="0 0 16 16"><use [attr.href]="'#morse-' + kind()" /></svg>`,
  `aria-hidden` (the row's label already says the name), 14 px square.
- Folder symbols stroke with `currentColor` so the tree's own muted colour reaches them;
  language symbols carry fixed brand colours (`#3178c6` ts, `#d4b830` js, `#3572a5`
  python, `#00add8` go, `#e44d26` html, `#42a5f5` css, …), chosen to stay legible on
  both themes.

**Tree row (`ui/tree-list`).**

- `TreeNode` gains `readonly icon?: IconKind`, data like `badge` and `action`, so the
  session tree simply does not set it.
- The template draws `morse-file-icon` when a node has an icon and keeps its width when
  it does not, so both trees stay aligned.
- The `prefix` connector span goes. Indentation (already `row.depth`) and the chevron
  carry the hierarchy, as in the reference. **This also drops the connectors from the
  session tree**, which is the same component; `treePrefix()` stays exported but unused
  by the UI.
- `.row.group .label { font-weight: 600 }` stays: JetBrains also bolds folders.

**Explorer (`features/file-explorer`).**

- `toNodes()` sets `icon: fileIcon(node.name)`, and for a directory
  `icon: expanded().has(node.path) ? 'folder-open' : 'folder'` — so the `nodes` computed
  now also depends on `expanded()`, which already exists.
- The filtered flat list swaps its text `.glyph` span for the same `morse-file-icon`.
- The header's file count, the git badges and the reveal-on-open behaviour are untouched.

**Tests.** `ui-runtime`: `fileIcon` by extension, by exact name, and the fallback.
`tree-list`: a node with an icon draws one, a node without one draws none.
`file-explorer`: a folder row gets `folder`, then `folder-open` once expanded; a file row
gets its extension's kind. The existing `fileGlyph` spec stays green.

## What's left to the builder

- The exact path data for the 20 symbols; they are 16×16 two-colour shapes and live in
  the plan, not here.
- Whether to give the session tree its own icons (a session mark, a project mark) — a
  natural follow-up, deliberately not in this change.
