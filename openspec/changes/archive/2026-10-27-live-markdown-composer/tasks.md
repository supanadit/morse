# Tasks

## 1. Decoration scanner

- [x] 1.1 Implement the decoration scanner as a pure function (draft text → decorated spans over
      verbatim text: fenced code regions, inline code, emphasis, links, headings, list markers),
      verified by unit tests per construct and by the spec's open-fence scenario — an unterminated
      ``` fence decorates to the end of the draft, and closing it ends the panel at the closing line
- [x] 1.2 Color fenced content through `highlight.js` inside the scan, with a unit test asserting
      the decorated characters concatenate back to the input exactly (geometry preservation)

## 2. Mirror paint layer

- [x] 2.1 Build the mirror directive in `app/ui/` (binds a textarea, maintains the mirror element,
      paints scanner spans, shares font/box metrics with the textarea via one set of CSS custom
      properties), verified by an alignment test: identical text with paint on and off yields the
      same total height and caret-row height
- [x] 2.2 Schedule repaints in `requestAnimationFrame` (input handlers never paint) with scroll
      sync to the textarea, verified by a test that a burst of input coalesces to at most one paint
      per frame and that no input event waits on a paint
- [x] 2.3 Document the primitive in its header (what it mirrors, the geometry-preserving rule, the
      decoration set), verified by reading the comment against `specs/ui/markdown-composer/`

## 3. Composer integration

- [x] 3.1 Host the paint layer on the composer textarea (transparent text, visible caret), with
      auto-grow and maximize both keeping the layers aligned; verified by the existing composer
      suites passing unchanged and the alignment test passing at both sizes
- [x] 3.2 Cover the spec contract at the composer level: sending a fenced draft transmits the typed
      source byte-for-byte, copying yields source, and mentions, `/` commands, Enter/Shift+Enter and
      Esc behave over formatted text exactly as without it — verified in `composer.spec.ts` and
      `composer.palette.spec.ts` additions

## 4. Performance and look check

- [x] 4.1 Measure typing in a worst-case draft (~50 KB): keystrokes land immediately and paints stay
      coalesced, verified by a perf test with a recorded measurement; only if it fails, window the
      scan to the visible region (per design.md)
- [x] 4.2 Judge the look in `ng serve` (tinted code panel, dimmed fences, inline styles, maximized
      composer) and tune spacing/colors; verified by observation and the full `ui-angular` suite
      passing (815 tests after shim-view-composer)

## Workflow follow-up

- Archive the change once review requirements are satisfied.
