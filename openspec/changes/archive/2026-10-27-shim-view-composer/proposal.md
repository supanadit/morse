# Proposal

## Why

The composer's live markdown layer keeps two layouts in step: a textarea that owns layout and a
mirror that must match it exactly, character for character. That contract caps presentation at
color-only styling — the fluid look the team wants (fence markers collapsed into a rendered code
panel with a language badge when the caret is outside the block, editable source when the caret is
inside it, as in Obsidian) is structurally impossible there: hiding or reshaping text in the mirror
would detach the caret from the glyphs. Monaco and CodeMirror solve this by inverting the split —
one layer owns layout, an input shim follows the caret — and this change adopts that split so the
composer can render blocks fluidly and so the class of two-layout drift bugs (three so far) is
gone for good.

## What Changes

- The textarea stops owning layout. It stays the input surface — full value, native undo, copy,
  selection, IME — but becomes a caret-following shim whose own text is never laid out for
  display; the caret is drawn where the view reports the buffer position to be.
- The paint layer becomes the view. It owns layout and may now change geometry (hide fence
  markers, add panel padding and badges), not just color.
- Fluid block rendering, Obsidian-style: a fenced code block renders as a rounded, tinted panel
  with a language badge while the caret is outside it, and as ordinary fenced source while the
  caret is anywhere inside it. Transitions happen on caret/selection movement, never mid-keystroke.
- A position map (buffer offsets ↔ view coordinates) serves clicks, caret drawing and selection
  rendering across hidden and reshaped ranges.
- Unchanged by design: the buffer stays the byte-exact typed source; send, copy, persist, Enter/
  Shift+Enter, Esc, `@` mentions, `/` commands, maximize, IME composition and undo behave exactly
  as today; the composer chrome (hint bar, controls row, status line) is untouched.
- **BREAKING**: none user-facing. Internally, `ui/markdown-composer`'s color-only presentation
  rule is superseded by view-owned layout.

## Capabilities

### New Capabilities

(none — this is the same durable behavior: how the composer presents markdown while editing)

### Modified Capabilities

- `ui/markdown-composer`: the formatting requirement gains caret-responsive block rendering
  (rendered panel when the caret is outside a fence block, source when inside); the editing-
  behavior requirement gains explicit guarantees that pointer input maps to source positions and
  that caret/selection always sit on the glyphs they belong to. Note: this capability is authored
  by the still-unarchived `live-markdown-composer` change — archive/sync that change first, or
  reconcile the two deltas in order when syncing.

## Impact

- `packages/ui-angular/src/app/ui/markdown-paint/` grows from mirror into the view: caret and
  selection rendering, the position map, and block-level decorations.
- `packages/ui-angular/src/app/features/composer/`: textarea becomes the input shim (composer.css
  and the wrapper's role change; the composer's own behavior code is untouched).
- `packages/ui-runtime/src/render/decorate.ts`: the scanner keeps its role (pure functions over
  the buffer) and gains block/hidden-range spans that feed the position map.
- Tests: position-mapping cases (clicks at wrap boundaries, inside hidden fence lines, at block
  edges), caret/selection placement, and the existing composer suites passing unchanged.
- No new runtime dependencies (same rule as the previous change). Expected growth is about the
  size of the current paint layer again.
