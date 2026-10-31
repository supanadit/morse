# Tasks

## 1. Position map — core

- [x] 1.1 Introduce `view/position-map.ts` mapping each buffer offset to a view slot with `viewToBuffer(x,y)` and `bufferToRect(offset)`, and verify round-trip tests on single-line, double-wrap and trailing-empty shapes pass.
- [x] 1.2 Add span kinds `hide` (fence lines suppressed) and `block` (panel root) to the decorate output and verify the scanner's non-overlap/order postcondition still holds including fence content.
- [x] 1.3 Teach the view to emit hidden fence lines as line-height spacers so textarea offsets remain canonical, and verify a keystroke never reflows a spacer line on CDP.

## 2. View layer replacing the mirror

- [x] 2.1 Rename `app/ui/markdown-paint/` to `app/ui/markdown-view/` owning layout, caret bar and selection bands, and verify `ui-angular` imports / tests resolve after the rename.
- [x] 2.2 Render the caret as an absolutely-positioned div sourced from `bufferToRect` and selection bands from the span list, and verify click/drag/double-click map to the expected source offset in a browser test.
- [x] 2.3 Bypass native selection display (textarea `caret-color: transparent; color: transparent`) while keeping native IME composition text; verify IME composition shows at the caret and undo still works.

## 3. Caret-aware block rendering

- [x] 3.1 Implement the D4 placement gate (panel when selection outside the block, source when inside) recomputed on `selectionchange`, and verify both transitions with `composer.markdown.spec` assertions.
- [x] 3.2 Render panel chrome (rounded tint, padding, language badge) while the caret is outside and verify geometry matches the composer's font metrics variables (`--mdp-*`).
- [x] 3.3 Keep panel rendering disabled during composition and resume on composition end (`compositionstart`/`end`), and verify no panel glyphs remain in the composition text.

## 4. Wiring the textarea as an input shim

- [x] 4.1 Shrink the native textarea to follow the caret position (Monaco pattern) while its value stays the full draft, and verify Tab/Enter/IME/select-all/copy/paste all continue to pass `composer.markdown.spec`.
- [x] 4.2 Sync rAF coalesced paints to `selectionchange` plus input, and verify the keystroke path records zero decorate scans (existing perf assertion stays green).
- [x] 4.3 Add feature flag `composer.markdown.viewMode` (default off) wired into `composer.ts`, and verify toggling it at runtime switches presentations without losing draft.

## 5. Guards and soak verification

- [x] 5.1 Add position-map round-trip tests across the full matrix (short, wraps twice, emoji width, trailing spaces, single-line trailing empty) and verify in jsdom plus headless Chrome.
- [x] 5.2 Keep the existing `composer.markdown.spec` (6) and `composer.palette.spec` (+1) green after the flip, and verify on real Chrome by loading `~/.vscode/extensions/supanadit.morse-0.26.1` with the new vsix.
- [x] 5.3 Re-run `npm run build :ui-runtime` and `npx ng test --watch=false` and confirm 215+ ui-runtime and 803+ ui-angular tests pass, then archive the precedent change and this one.

## Workflow follow-up

- Archive `live-markdown-composer` first (its delta must land as the live main spec), then archive this change as a MODIFIED delta; flip `composer.markdown.viewMode` default on afterward.
- Sync the webview and repackage vsix per the project's published flow once Chrome verification passes.
