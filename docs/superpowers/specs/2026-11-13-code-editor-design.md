# A real code editor for the browser host — and LSP gone

## Intent

The browser host's file tabs render a static highlighted `<pre>`. It reads like a diff viewer:
no caret, no selection bands you can trust, no folding, no sticky context, no find that keeps
its place. openidea's editor (CodeMirror 6 with an IntelliJ-parity layer) is the reference our
human partner pointed at: *"the editor looks and feels crazy comfortable."*

At the same time Morse is an agent GUI, not an IDE. The LSP machinery (language servers spawned by
the host, hover/definition/references/diagnostics) is the part of the app that makes it feel like
a half-finished IDE and the part that costs the most to keep. It goes away entirely.

So: **one good read-only editor, no language servers, no new bundle weight on first paint.**

## Goals

1. A file tab in the browser host renders its content in CodeMirror 6, read-only.
2. The comfort comes from a small, deliberate port of openidea's layer, not from CM's defaults:
   caret glide, smooth blink, caret-row tint, sticky scrolled declarations, indent guides,
   rainbow brackets, fold gutter, active-line gutter, scroll-past-end, soft-wrap padding.
3. Syntax highlighting is incremental (Lezer), with colours taken from Morse's existing tokens so a
   file tab and a transcript code block agree.
4. LSP is deleted end to end: server module, protocol, capability, frontend UI, env vars, docs.
5. No growth of the initial bundle: the editor and every grammar load in lazy chunks.
6. Pinning a range is redesigned, not preserved: wherever a file tab exists, the annotation lives in
   a card beside the code (D6) and the chip becomes a reference; where no editor exists (VS Code), the
   chip keeps the note. Ranges come from the editor state instead of the DOM.
7. The VS Code host and every other frontend keep working; nothing on the wire changes shape.
8. `npm run test:fast` stays green throughout.

## Non-goals

- Editing, saving, dirty state, `writeFile`, conflict handling. Read-only, by decision.
- Completion, diagnostics, hover, go-to-definition, references, inlays, code actions, formatting.
- Multi-caret, column mode, overwrite mode, clipboard history, relative line numbers, distraction
  free mode, rendered doc comments, code lens, VCS lanes, minimap.
- Monaco (see Approaches).
- Any change to the VS Code host: it never shows the preview (`capabilities.filePreview` is off
  there) and its own editor is not ours to replace.
- Transcript and markdown code blocks: they keep highlight.js.
- Diff modes (`unified` / `split`) and binary/too-large fallbacks: unchanged.

## Anti-goals

- Turning Morse into an IDE by another route. If a feature needs a language server to be good, it
  is out of scope rather than half-built.
- A second theme system. The editor reads Morse tokens; it does not invent a palette.
- Forking openidea. We port a named list of behaviours, not a repository.

## Constraints

- **Bundle ceiling.** Initial JS is ~1.24 MB against `maximumError` 1.3 MB in
  `packages/ui-angular/angular.json`. Everything new ships as lazy chunks.
- **Layer rules.** `packages/ui-angular/src/app/shell/conventions.spec.ts` enforces:
  styles/templates in their own files (no inline `styles:`/`template:`), imports only point at the
  same layer or to the right (`routing → shell → features → ui → services → state → host`), only
  `shell`/`routing` may reach into two features, and the host seam depends on no other layer.
- **Component style budget.** `anyComponentStyle` warns at 12 kB, errors at 16 kB.
- **Licence.** openidea is Apache-2.0. The port is pinned to
  [`835c446`](https://github.com/l0ng-ai/openidea/tree/835c44615b0aa847d8aa8461a5d3f812ff8c8919)
  (v0.1.43 — the tree this design was written against), so a reviewer can diff every ported file.
  Headers stay, and a `NOTICE` is **created** (the repo has none) with a "Portions derived from
  OpenIDEA" entry. CodeMirror package majors are taken from that same snapshot.
- **Environment.** Angular 22 standalone components, `OnPush`, signals, vitest + jsdom (no
  Playwright in this repo).
- **No workers, no WASM, no network at runtime.** CM6 needs none of them; keep it that way.

## Approaches considered

**A. CodeMirror 6 with a ported subset of openidea's layer — chosen.**
Lazy chunk, ~110–160 kB gzipped. We take the pieces that produce the comfort and the pieces that
delete work (positions mapping, custom gutter, custom caret drawing). Each grammar is a separate
lazy chunk, so a reader who never opens a Rust file never downloads one.

**B. Monaco.** Everything included and TextMate grammars for free, but multi-megabyte, workers, CSP
work in a webview, and it *is* the IDE machinery we are removing. Only wins if VS Code parity is
the goal, which it is not.

**C. Keep `<pre>` + highlight.js and restyle.** No new dependencies. But sticky lines, folding,
find, and a caret that glides all become hand-built, big files re-highlight wholesale, and
`ui-runtime/src/files/positions.ts` (the DOM→source mapping built around highlight.js spans) stays
forever. Cheapest, and genuinely fine if the tab only ever means "read a file beside the chat" —
which it does not, since comfort was the whole request.

**A note on pinning.** Three shapes were offered for the redesigned pin, because the old one (band +
resize handles + ✎ on the band, note edited in a composer chip) has two note surfaces and a lot of
chrome. **Picked: margin cards** — a note card beside the code, with the note edited there and the
chip reduced to a reference. The others were a selection-only "pin pill" with notes staying in the
chip (least work, but the note stays far from the code) and a GitHub-review-style hover rail (quiet on
dense files, but notes hidden until hover). The pick is the only one where the annotation lives where
the code is, which is the behaviour the old design never had.

## Decisions

### D1 — Where the editor lives

`packages/ui-angular/src/app/ui/code-editor/` — a new `ui/` layer component plus its modules:

```
ui/code-editor/
  code-editor.ts          Angular component: mounts CM, owns the view lifecycle and the note rail
  code-editor.css         CM DOM + rail styling (see D3)
  editor-setup.ts         the extension set (theme, caret, row, sticky, folding, search, keymap)
  editor-theme.ts         token → --morse-* mapping for syntaxHighlighting
  languages.ts            path extension → lazy grammar loader
  pins.ts                 the pin model the editor renders (pure, unit-tested)
  pin-selection.ts        CM selection → pin payload (pure, unit-tested)
  rail.ts                 card placement: line tops → non-overlapping card slots (pure, unit-tested)
  scroll.ts               reveal-a-line + flash decoration (pure part unit-tested)
```

It sits in `ui/` because it is generic: it renders a document, a set of ranges and a note rail, and
knows nothing about tabs, sessions or host capabilities. `features/file-preview/` owns the wiring,
and the layer rule allows a feature to import `ui/`.

The component's public surface:

**Inputs**

- `text: string` — the file's content (already fetched by the tab store).
- `path: string` — the grammar lookup key and the `aria-label`.
- `line?: number` — 1-based line to reveal and flash (search hits, git jumps, a chip click).
- `pins: readonly EditorPin[]` — every range this file carries, already filtered from the store:
  `{ id, startLine, endLine?, startColumn?, endColumn?, note? }`.

**Outputs** (all delegated; the editor owns no pin state)

- `pinRequested` — `{ startLine, endLine, startColumn, endColumn, characters, text }`, the shape
  `PendingPin` needs. Emitted on a committed gutter drag or a confirmed selection.
- `noteEdited` — `{ id, note }` from the card's editor.
- `unpinned` — `{ id }` from a card's ⌫.

### D2 — Lazy loading

`file-preview` follows the pattern `app.ts` already uses for the prompt editor: an `effect()` that
`await import('../../ui/code-editor/code-editor')` once, caches the class, and mounts it with
`ngComponentOutlet` inside the file-mode branch. A `@defer` block is explicitly not used — its
runtime would ride in the initial bundle.

Until the chunk lands the tab shows the file's plain text in a `<pre>` (unhighlighted, no
decoration). If the import rejects, the same `<pre>` stays with a small "couldn't load the editor"
note and a retry button. **The old highlight.js preview path is deleted, not kept as a fallback** —
it is the code we are replacing.

### D3 — Theme: stylesheet, not `EditorView.theme()`

CodeMirror creates its own DOM, so Angular's emulated encapsulation never stamps the component
attribute on it. Two precedent-compatible options exist; pick the one that stays readable:

- The component sets `encapsulation: ViewEncapsulation.None` and every selector in `code-editor.css`
  is prefixed with `morse-code-editor` (host element name). One file, discoverable, contained.
- `styles.css` hosts the rules, like the `.md-*` and `.hljs-*` rules already documented there for
  the same reason.

We take the first. A new case in `conventions.spec.ts` asserts that every selector in
`code-editor.css` starts with `morse-code-editor`, so the containment is a test rather than a habit.

All colours are Morse tokens. Four semantics have no token today; they are **aliases, not new
colours**, added in all three theme blocks (`:root` VS Code, light, and the standalone dark block)
so a future theme change still touches one value:

| CM semantic | token |
| --- | --- |
| keyword, tag, decorator, heading | `--morse-keyword` |
| string, regexp, escape, attribute value | `--morse-string` |
| number, literal, constant | `--morse-number` |
| type, class, builtin, property | `--morse-typename` |
| function call / definition | `--morse-info` |
| comment, punctuation, operator | `--morse-comment` (alias of `--morse-fg-muted`) |
| variable, plain text | `--morse-fg` |
| invalid | `--morse-error` |
| selection, caret row, search match | `--morse-accent` at the same mix ratios the composer's markdown view uses |

New tokens introduced: `--morse-comment` (fg-muted), `--morse-punct` (fg-muted),
`--morse-editor-bg` (code-bg), `--morse-editor-gutter` (panel). Nothing else.

### D4 — The ported comfort set, and what each costs

| Behaviour | Source (openidea) | Adaptation |
| --- | --- | --- |
| theme: gutter, active line, selection, tooltips | `cm/theme.ts` | rewritten against `--morse-*`; drop VCS lanes, method separators, distraction-free, ligatures |
| syntax colours | `cm/highlight.ts` | `HighlightStyle` mapped to the table in D3; drop doc-comment sub-tags |
| caret glide + smooth blink + block-caret option | `cm/prefs.ts` (`caretGlide`, `caretExtension`) | ported as-is, minus the settings object: glide is always on unless `prefers-reduced-motion` |
| caret-row tint under the selection | `cm/caretRow.ts` | ported as-is (31 lines) |
| sticky scrolled declarations | `cm/stickyScroll.ts` | ported; `backendFolds` replaced by syntax-tree ranges; cap at 2 lines |
| indent guides | `cm/indentGuides.ts` | ported without the rainbow variant |
| rainbow brackets | `cm/rainbowBrackets.ts` | ported, colours from `--morse-*` |
| fold gutter + chevrons | `cm/theme.ts` + CM `foldGutter` | use CM's `foldGutter`/`foldKeymap`, styled to match; do not port `cm/folding.ts` (it depends on host IPC) |
| find in file | — | CM's `search` extension + `searchKeymap`, panel styled by the theme. No custom find bar in v1 |
| read-only keymap | `cm/baseKeymap.ts` | CM `defaultKeymap` + `searchKeymap` + `foldKeymap`; `EditorView.editable.of(false)` + `EditorState.readOnly.of(true)` |
| scroll past end | `cm/prefs.ts` | 6-line spacer at the doc end |
| wrap padding | `cm/theme.ts` | continuation rows inset, so wrapped lines read as continua |

Explicitly **not** ported: multi-caret, column mode, overwrite, gutter line drag, clipboard
history, relative line numbers, `extendSelection`, doc-comment rendering, code lens, VCS lanes,
completion, `cm/smartKeys.ts`, `cm/verticalMotion.ts`, `cm/renderedDocs.ts`, `cm/languages.ts`.

Each ported file keeps openidea's Apache-2.0 header, with a line naming the upstream path and the
commit, and `NOTICE` gets a "Portions derived from OpenIDEA" entry.

### D5 — Languages

`languages.ts` maps, lazily and per file:

| Extensions | Package |
| --- | --- |
| `.ts .tsx .js .jsx .mjs .cjs .json` | `@codemirror/lang-javascript`, `@codemirror/lang-json` |
| `.html .htm .vue .svelte` | `@codemirror/lang-html` |
| `.css .scss .sass .less` | `@codemirror/lang-css` |
| `.md .mdx` | `@codemirror/lang-markdown` |
| `.py` | `@codemirror/lang-python` |
| `.rs` | `@codemirror/lang-rust` |
| `.go` | `@codemirror/lang-go` |
| `.java .kt .kts` | `@codemirror/lang-java` |
| `.sql` | `@codemirror/lang-sql` |
| `.yaml .yml` | `@codemirror/lang-yaml` |
| `.xml .svg .plist` | `@codemirror/lang-xml` |
| `.sh .bash .zsh` | `@codemirror/legacy-modes` (shell) — optional, last |
| anything else | plain text |

`@codemirror/language-data` is **not** used: it statically imports every grammar package, which
would defeat per-language chunks. The file's extension decides, and nothing else does: the host's
`FileTab.language` is a highlight.js id (`html → 'xml'`, and absent for `rs`, `java`, `sql`, `scss`,
`vue`, `mdx`), so translating it would need a second, lossy table. The header badge keeps showing that
hint; the editor ignores it. An unknown extension renders as plain text — never an error.

Each grammar is `await import()`ed in the component after mount; until it resolves the document is
already visible (plain), and CM re-parses in place when the language arrives.

### D6 — Pinning, redesigned: the note lives in the margin

Today's preview draws each pin as a band with two resize handles, its own ✎, and a confetti burst
when ranges merge, while the note itself is edited in a composer chip. That is two note surfaces and
a lot of chrome over the code. It is replaced wholesale, not ported.

**Creating.** Two gestures, two commitments:

- **Drag the line numbers** — a range forms live and is pinned on release, as today. Whole lines, no
  columns. This is the fast path and needs no confirmation.
- **Select text** — a pill appears at the selection's end: `⧉ Pin L14:3-22`. Enter or click pins the
  exact column range; Escape or click-away dismisses. A selection is also how you copy, so this
  gesture confirms rather than fires.

**Showing.** A pinned range becomes:

- a soft line tint (`--morse-accent` at ~8%, well under the selection's ratio) plus a 2px accent rule
  in a 4px lane left of the text, so ranges read as one object without fighting the selection; and
- a **card in a note rail** on the right of the code: the range label and the note (rendered markdown,
  `morseNoteHover`-style), a preview rather than a control; and
- the same two plain buttons a diff row carries — **Notes** (edit) and **Cancel** (unpin) — floating
  at the **bottom-right corner of the band**, over the code, one shared `morse-pin-actions` component
  so the file view and the diff cannot drift apart. The pinned tint is the same in both views, and in
  neither is the highlight itself a control: clicking a pinned block leaves it pinned.

```
 14 │   const tabs = inject(WorkspaceTabs);    ┃ note ─────────────────┐
 15 │   const drafts = inject(ComposerDrafts); ┃ "drafts survive a     │
 16 │   const queued = inject(QueuedPrompts);  ┃  session switch"      │
                                            ┗━━━━━━━━━━━━━━━━━━━━━━━┛
                                          Notes  Cancel
```

**Editing a note.** The band's pair is the only editor. Its **Notes** button opens the existing
`morse-pin-annotation` popover *anchored to the button* instead of editing inside CM (widgets that
take keystrokes fight CM's own handlers; an Angular button over the scroller does not). An empty note
renders as the card's ghost "Add a note…", so the card still says what is missing.

**The rail.** It is Angular DOM beside the editor, not a CM widget: cards are absolutely positioned
from `view.coordsAtPos(lineStart)` on scroll, resize and measure, and hidden when their line is folded
or scrolled out. `rail.ts` owns the pure part — line tops → non-overlapping slots, stacking downward
when pins are close; a card pushed below the viewport comes back as the document scrolls, because the
rail is as tall as the document's scroll height. When the pane has no room for a 240px rail (the code
column would drop under 480px), the same cards overlay the right edge instead, with no second
component and no second presentation.

**What this removes.** Per-band resize handles (re-select or re-drag to change a range), the confetti
(and its `AnimationService` call), the per-band ✎ (now the band's shared pair), and — where the
editor exists — the composer's note editing: `composer.ts` loses `openAnnotation` and the annotation
target/anchor signals, and `morse-pin-annotation` leaves the composer's imports. Chips keep path,
label, hover preview, click-to-open and remove; clicking a chip opens the file at the pin's start
line, where the editor flashes it and its card waits.

**Hosts with no editor.** VS Code sets no `filePreview` capability: no tabs, no editor, no rail, so a
band-only note would strand every VS Code user. The chip's ✎ therefore survives *exactly there* —
when `capabilities.filePreview` is off, or when the pin's file cannot be shown (binary, truncated,
failed to open). It opens the same `morse-pin-annotation` component, anchored to the chip instead of
the band. One editor component, two anchors, never two designs; the band's pair is the surface
whenever there is a file to put it beside.

**Payload.** Unchanged: `path`, `startLine`, `endLine`, `startColumn`, `endColumn`, `characters`,
`text`. The browser host now fills the column fields for text selections (it never has before; only
VS Code's `getEditorContext` did), and the chip label shows `L14:3-22` when columns exist and plain
`L14-22` when they do not, which is what VS Code pins have always looked like.

**Selection source.** `file-preview.selected()` currently walks DOM ranges through
`ui-runtime/src/files/positions.ts` to recover a source span. The editor reads `state.selection.main`
offsets directly, so both the pill and the drag resolve from the document. `positions.ts` and its spec
are deleted: every call site is in `file-preview.ts`. The gutter drag becomes a custom CM gutter with
pointer handlers (`view.lineBlockAtHeight` → line numbers), ported in spirit from openidea's
`cm/gutterDrag.ts` but line-only — that file edits text, which we never do.

### D7 — LSP deleted, end to end

| Area | What goes |
| --- | --- |
| `packages/server/src/internal/lsp/` | whole directory: `lsp.service.ts`, `lsp-client.ts`, `lsp-mapping.ts`, `lsp-protocol.ts`, `language-servers.ts` and their three spec files (~1,100 lines) |
| `packages/server/src/app.module.ts` | `ServerLanguageServers` provider/export |
| `packages/server/src/internal/ws/session-factory.service.ts` | the inject, `lsp: true` capability, the four `case 'lsp*'` branches, `lspFile()` and `lspPosition()` helpers (~80 lines) |
| `packages/server/src/app/config.ts` | `lspIdleMs`, `MORSE_LSP_IDLE_MS` |
| `packages/server/src/internal/registry.spec.ts` | the LSP expectations |
| `packages/protocol/src/lsp.ts` | whole file; `index.ts` stops exporting it |
| `packages/protocol/src/wire/host.ts` | `lspHover`, `lspDefinition`, `lspReferences`, `lspDiagnostics` |
| `packages/protocol/src/dto/host.ts` | `capabilities.lsp` and its doc comment |
| `packages/ui-runtime/src/lsp/guards.ts` + spec | whole directory; `index.ts` stops exporting it |
| `packages/ui-runtime/src/files/positions.ts` + spec | whole file (see D6); `index.ts` stops exporting it |
| `packages/ui-angular/.../file-preview.ts` and `.html`/`.css` | hover card, problems popover, references card, diagnostic decorations, `lspReady`/`lspAvailable`, ~15 call sites and their CSS |
| `docs/CONFIGURATION.md`, `docs/FRONTENDS.md`, `docs/INSTALL.md` | `MORSE_LSP_*` rows, the `lsp` capability paragraph, the language-server resolution section |
| `packages/extension/CHANGELOG.md` | an entry at release time, not in this change |

Anything the LSP UI secretly served is checked in the same sweep: `file-preview`'s `line` input keeps
working (search hits and git jumps use it) but its doc comment stops mentioning language servers.
Search-panel and git jumps that previously resolved through `lspDefinition` become "open the file at
line N" — same tab, no server.

## What the file tab looks like when this lands

```
┌───────────────────────────────────────────────────────────────────────┐
│ src/app/state/workspace-tabs.ts                     TypeScript  124   │
│  File  Unified  Split                                        [2 ranges]│
├───────────────────────────────────────────────────────────────────────┤
│  118 │   export interface FileTabsSnapshot {        ┃ note ──────────┐ │  ← caret row tinted
│  119 │ ▏   tabs: PersistedTab[];                    ┃ drafts survive │ │
│  120 │ ▏   activeId?: string;                        ┃ a session      │ │  ← sticky header:
│  121 │   }                                          ┃ switch"  ✎  ⌫  │ │  ← "interface FileTab…"
│  122 │                                              ┗━━━━━━━━━━━━━━━━┛ │
│  123 │   const FILE_PREFIX = 'file:';                                  │
│   ─── │                                                                │
└───────────────────────────────────────────────────────────────────────┘
   no hover cards, no squiggles, no "problems" badge; ranges carry their notes
```

## Testing

- **Pure modules, unit-tested in vitest:** `languages.ts` (extension → package, unknown → null),
  `pin-selection.ts` (offsets → line/column/characters/text, multi-line, CRLF, trailing newline,
  empty selection), `pins.ts` (store pins → `EditorPin[]`, missing columns, open-ended ranges),
  `rail.ts` (line tops → non-overlapping slots; stacking, clamping, a card taller than the gap),
  `scroll.ts` (reveal target clamped into range), `editor-theme.ts` (every tag with a colour
  resolves to a token that exists in `styles.css`).
- **Extension behaviour, tested at `EditorState` level (no view):** folding ranges produced for a
  document, sticky-scroll ancestor selection given a syntax tree, grammar loads produce a language
  for each mapped extension.
- **The test seam for the component.** `file-preview` resolves the editor through an injection token
  (`CODE_EDITOR`), whose default value is the lazy `import()`. Specs provide a fake component with
  the same inputs and outputs, so `file-preview.spec.ts` can assert what it actually owns: that a
  `pinRequested` output reaches `AttachmentStore`, that `noteEdited` writes through, that a chip
  click sets `focusPin`, that mode/diff/binary branches still pick the right presentation. The
  editor's own behaviour is covered by the pure modules above, not by mounting CM.
- **No jsdom view tests.** `EditorView` needs layout (`Range.getClientRects`) that jsdom does not
  provide; a test that mounts it would assert nothing real. The component is kept thin for this
  reason, and the risk is carried in Risks below.
- **`conventions.spec.ts`:** the new `code-editor.css` prefix case (D3).
- **`file-preview.spec.ts` rewrite.** Its ~12 DOM-driven pin cases (gutter spans, bands, edge
  handles, the per-band ✎, the cancel button) assert the markup this change deletes. They are
  rewritten against the fake editor — not preserved — and the note flow moves to the card's new
  coverage in `file-preview.spec.ts` (store write-through) plus `pin-selection.ts`/`rail.ts` units.
  This is a planned test deletion, not collateral.
- **`composer.spec.ts` / `composer.pins.spec.ts`:** keep chip label, hover preview, remove and
  jump-to-file; add the capability gate (no `filePreview` → the chip still edits notes). The
  annotation-editor cases stay for that path.
- **Manual check in the browser host** before calling it done: open a 3,000-line TS file, a
  minified JSON, a binary, a file with CRLF, a huge truncated file; fold a block, search, drag a line
  range, select a column range and pin it, write a note in a card, unpin from a card, click a chip
  whose file is closed. Recorded in the PR body, not as a test.

## Risks and trade-offs

- **jsdom cannot mount the editor**, so the wiring has no automated safety net. Mitigation: all
  logic that can be pure is pure and tested; the component's job is mounting and input/output
  plumbing; the manual checklist above is mandatory.
- **The rail is the new failure surface.** Cards positioned from `coordsAtPos` can drift on scroll,
  resize, fold, or a wrap reflow. Mitigation: `rail.ts` is pure and unit-tested; positions are
  recomputed in one `requestMeasure` per frame rather than per card; a card whose line cannot be
  measured is hidden rather than stacked at the wrong place.
- **Sticky scroll is the most intricate port** (measurement, rebuild on viewport change, interplay
  with fold state). Mitigation: land it behind a `sticky` flag on the component, default on, and be
  ready to ship v1 without it — it is the one comfort feature that is decoration rather than
  function.
- **Two note anchors are a real cost.** The card is primary, the chip is the fallback for hosts with
  no editor; they share one component, but the gate (`capabilities.filePreview` plus "can this file
  be shown") has to stay honest or a pin ends up with no way to write its note. Mitigation: the gate
  is a pure function on the feature, unit-tested for all four combinations.
- **Per-language chunks mean a first-open delay** for a language not yet fetched (a few kB to
  60 kB). Acceptable: the document is already rendered before the grammar resolves.
- **Apache-2.0 attribution is easy to lose in a port.** Mitigation: headers stay, `NOTICE` is created,
  and the design pins the revision so a reviewer can diff.
- **Deleting LSP changes a documented public surface** (host commands, capability, env vars). Anyone
  running a third-party frontend against Morse's host loses `lsp*` answers. Accepted: LSP was never
  part of the wire's stable promise, and the removal is the point. `docs/FRONTENDS.md` says so.

## What is left to the builder

- Exact CM package versions (take openidea's majors from `835c446`; verify no duplicate
  `@codemirror/state`).
- The precise extension order in `editor-setup.ts` — CM is order-sensitive for `Prec` and for
  compartments; the design fixes the content, not the sequence.
- Whether the shell grammar (legacy-modes) lands in v1 or a follow-up.
- The sticky-scroll cap, the caret glide duration (110 ms snappy is openidea's; 140 ms may read
  better at our font size), the exact inset of the wrap padding, the pin tint ratio, and the rail's
  minimum width — tuned by looking at it.
- Whether the pill (D6) is anchored to the selection's last rect or floats at the pointer; both are
  defensible and the difference is felt, not specified.
- Whether `file-preview` keeps its `<header>` mode buttons exactly as they are or moves the
  language badge into the editor's corner; both are cosmetic and the header is not the editor's.
- The name of the chunk-splitting boundary if an implementation detail (for example a shared
  `@lezer/highlight` copy) pushes the lazy chunk past ~180 kB.
