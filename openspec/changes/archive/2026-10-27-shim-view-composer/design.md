# Design

## Context

See `proposal.md` - Why. The composer currently owns layout in a `<textarea>` and paints markdown
from a below-fold mirror that must line up exactly — a two-layout contract that allows
color-only styling and that has already produced three drift bugs (bold duplication, trailing-
newline linebox, hljs glyph width) plus a global-stylesheet gotcha. Specs:
`openspec/changes/shim-view-composer/specs/ui/markdown-composer/spec.md`.

## Goals / Non-Goals

**Goals:** one layer owns layout; a caret-following input shim keeps the native editing
experience (undo, clipboard, IME, selection); view blocks may change geometry (collapsed fence
markers, panel padding) when the caret is outside; position mapping bridges buffer ↔ view for
pointer input and caret drawing; no new runtime deps.

**Non-Goals:** no CodeMirror/TipTap/ProseMirror; no live panel evaluation or command palette;
no cross-engine changes; no data rendering beyond blocks the composer already styles; caret-
driven block motion that fires mid-keystroke.

## Decisions

### D1 — Composition status as a first-class document-state field
The input shim holds the whole buffer as native textarea value (so undo, IME, select-all, copy
work for free) but its text is made visually transparent, and its caret drawn only when the view
reports it. Native selection continues to exist on the textarea and drives the view's caret bar;
a `selectionchange` → rAF paint keeps them aligned.

### D2 — View owns layout; decoration pass becomes a render pass
Today's `decoratedMarkdownHtml` produces color spans. It gains two span kinds:
- `hard-hide`: buffer range suppressed entirely in the view (opening/closing fence lines).
- `block`: range rendered as a panel root with padding, badge and language label.

The buffer strings inside both spans are still within the textarea value; the view removes them
by `display:none`-equivalent (hidden inline with a sentinel spacer holding line height), so
the textarea's value and selection offsets remain canonical — the view never owns text.

### D3 — Position map
A position table indexes every buffer byte to a view layout slot:
- Normal range → its rendered text node.
- Hidden range → the spacer at its original line (caret can still land on either side of a
  hidden fence line per source offset).
- Block range → the block's body text node plus an offset.

Operations: `bufferToView(range)` (render-time), `viewToBuffer xy` (click → buffer offset),
`bufferToRect(offset)` (caret draw). Wrap boundaries are the hard case and get coverage (see
risks). CodeMirror's position-mapping approach is reused conceptually, not as a dependency.

### D4 — Block transition gated on caret/selection
A block renders as panel only when `[selection.start, selection.end)` is entirely outside
`[blockStart, blockEnd)`; otherwise all its lines render as source. The decision is recomputed
on `selectionchange`, not on keystroke, so typing never reflows a block under the fingers.
Gating is computed in the paint's local state, not persisted.

### D5 — Caret drawing
The caret is drawn by the view as a single absolutely-positioned `div` at the rect from
`bufferToRect` on the shim's textarea — measured via a shadow span whose font attributes equal
the shim's. IME composition text shows in the shim, which stays at the caret position.

### D6 — Hidden ranges never break the position map
The table stores every byte; hidden ranges only change `viewToBuffer`/`bufferToRect` results by
collapsing their line. Tests assert a 1:1 round-trip on each span kind.

### D7 — Rollout
Shipped behind a flag `composer.markdown.viewMode` default off, turned on after the test grid
passes. Rollback by flipping the flag.

## Risks / Trade-offs

- Position-map wrap-boundary math is the real failure mode → exhaustive round-trip tests on
  a matrix of wrap shapes (short, wraps twice, code content, emoji widths, trailing-space lines)
  before enabling.
- IME caret swing during composition is hard to pixel-sync → shim keeps its value so the
  native caret is available; view degrades to source-only rendering during composition (as
  today) and resumes panel rendering afterwards.
- Performance at 50 KB with position-map overhead → 50 KB scan is 11 ms today; position-map build
  is a single pass over the same spans; rAF coalesces paints; keystroke path keeps scan count 0.
- Geometry parity now relies on CSS only in one layer → simpler than today, but a change to the
  shim's font/line-height MUST be mirrored in the single source of truth, which is enforced by
  shared `--mdp-*` variables.

## Migration Plan

1. Land position-map + view with the shim in parallel with today's mirror behind the flag (default
   off), then run ui-angular tests + new position-map spec.
2. Enable the flag; soak on the dev webview.
3. After a viewport-free CVE-free soak, remove the flag and the now-unused mirror/geometry
   neutralization CSS in `styles.css`.

## Open Questions

- Whether pointer drag selection over a block's collapsed fence line should extend through the
  hidden text or stop at the block boundary — deferrable UI detail; tentatively "through the
  underlying buffer" (matches native), to be confirmed during implementation review.
