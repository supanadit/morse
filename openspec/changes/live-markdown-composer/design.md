# Design

## Context

The composer's prompt is a plain `<textarea>` (`packages/ui-angular/src/app/features/composer`)
grown by `app/ui/auto-grow.directive.ts`, with drafts persisted as verbatim text, `@`/`/` menus
driven by textarea selection APIs, and keyboard handling in `composer.ts`. Any formatting must sit
underneath that, not replace it. See proposal.md for why now, and `specs/ui/markdown-composer/`
for the behavior contract.

The transcript already renders markdown via `app/ui/markdown/markdown.ts` → `renderMarkdown()` in
`packages/ui-runtime/src/render/markdown.ts` (`marked` + `DOMPurify` + `highlight.js`). Those
packages are already in the bundle; the composer adds code, not dependencies.

## Goals / Non-Goals

**Goals:**

- Formatting visible on the editing surface itself, updated as the user types.
- Byte-exact buffer: the textarea remains the only input surface and the only source of truth.
- Zero change to input handling, drafts, mentions, commands, shortcuts, maximize.
- Typing never waits on formatting.

**Non-Goals:**

- True WYSIWYG document editing (caret through rendered widgets, collapsed fences, reflowing
  blocks) — that is an editor-engine change.
- Floating language labels on fence lines, toolbar actions, auto-pairing, or markdown linting.
- Any change to how the transcript renders answers.

## Decisions

**1. A mirror paint layer under the textarea — not a document editor.**
The textarea keeps every behavior it has (IME, undo, selection, a11y, selection-driven `@`/`/`
menus) for free; its text is set transparent with a visible caret, and a rendering layer beneath
mirrors the buffer and paints styled spans. Alternatives rejected: a `contenteditable` engine
(hand-rolled or ProseMirror/TipTap) replaces a working input to gain rendered widgets, and buys
the whole undo/IME/selection problem surface plus (for the libraries) 100–200 KB; CodeMirror 6
similarly replaces the surface we already know works. The mirror also satisfies the exact-buffer
requirement by construction: it paints the characters that are already there.

**2. Decorations preserve geometry — spans over verbatim text, never rendered HTML.**
The mirror renders the same characters in the same order with inline spans; blocks are styled
line-by-line (tinted backgrounds, syntax colors, dimmed fence markers), never swapped for reflowing
HTML. This is what keeps caret and paint aligned and copy/send exactly the source. Decoration may
change color and background only — never font, weight or spacing: the mirror must wrap exactly like
the textarea under it, and the host font can be proportional (VS Code sets `--vscode-font-family`).
`renderMarkdown()`
HTML is deliberately not reused here: its blocks change line geometry and cannot overlay a textarea.

**3. A small hand-rolled scanner for the decoration set — `highlight.js` for code content.**
The decoration set is small (fences, inline code, emphasis, links, headings, list markers), and a
line scanner maps decorations to offsets trivially and handles the spec's unterminated-construct
rule directly. Reusing `marked`'s lexer would mean mapping block tokens back to character offsets —
more code than the scanner, and it has no opinion about half-typed input. `highlight.js` is reused
for fenced content: its output wraps the identical characters in spans, so coloring a code block
cannot shift geometry. `marked` stays untouched for the transcript.

**4. Repaint is scheduled, never synchronous.**
Input handlers do only textarea work; painting runs in a `requestAnimationFrame` after the next
input event, coalescing bursts of typing into at most one scan per frame. The scan is O(draft).
Formatting may trail the caret by a frame; keystrokes never wait.

**5. The paint primitive is shared UI, not composer internals.**
The mirror lives in `app/ui/` beside the transcript's `markdown/`, as a directive bound to a
textarea it decorates (it creates/maintains its own mirror element and scroll sync). The composer
only hosts it; the sizing rules already in the composer CSS apply to both layers from one set of
custom properties so the two surfaces cannot drift apart.

## Risks / Trade-offs

- [Mirror and textarea drift by a pixel] → one shared set of font/padding/line-height custom
  properties for both layers, and an alignment test that compares the rendered caret row height
  and total height of identical text with the paint on and off.
- [Transparent textarea text degrades selection or find-in-page] → `color: transparent` with
  `caret-color` set; native selection highlight still paints and copy yields the source. Covered
  by the copy/selection scenarios in the spec.
- [Scanner's decoration set drifts from what the transcript renders] → cosmetic only (the buffer
  is unaffected), and the set is small and named in the spec; `highlight.js` keeps the part
  readers scrutinize — code blocks — consistent.
- [Large drafts make each repaint expensive] → rAF coalescing plus an O(n) span scan (far cheaper
  than the transcript's measured `marked` render); the perf task measures a worst-case draft and
  only then considers windowing the scan to the visible region.
- [Maximize/resize breaks alignment] → same custom properties at any size; the composer's existing
  size specs extend to the painted surface.

## Migration Plan

Single-package UI change behind no flag; drafts and sends are unchanged source text, so there is
nothing to migrate. Rollback is reverting the commit.

## Open Questions

- A dimmed language label on fence lines (mirror-only overlay) — deferred until the base look
  lands and is judged in use.
- Where the "too big to repaint whole" threshold actually sits — answered by measurement in the
  perf task, not assumed here.
