# Design

## Context

See `proposal.md` for motivation and `specs/ui/selection-pins/spec.md` for the behavior contract.

Today the selection pipeline is line-only at every hop:

- `packages/extension/src/internal/vscode/selection-preview.ts` collapses the editor's selections
  into a `{startLine, endLine}` envelope and streams it as `context/selectionLive`.
- `chat-view-provider.ts` and `vscode-context-provider.ts` build a `context/selection` payload and
  an `EditorSelection`, both line-only. The latter already reads the selected text and drops it.
- `packages/protocol/src/wire/host.ts` carries the two payloads; `ChatPin` (protocol DTO and the
  agent domain copy) carries path and lines only.
- `packages/ui-angular/src/app/state/attachments.ts` stores and coalesces pins by line.
- Chips are labelled by four separate copies of the same `L<start>-<end>` function.
- Both adapters serialise a pin as `@path:start-end`; `event-mapping.ts` and `ui-runtime/rows.ts`
  parse that form back for replay and rendering.

The constraint that shapes everything below is that a mention is **prose handed to a model**, not a
URI a tool resolves. It has to stay readable to a model, stay valid for old sessions, and must not
be confused with the reader's own words.

## Goals / Non-Goals

**Goals:**

- One span shape travels from the editor to the prompt with no lossy step.
- A chip can show `L18:45-79` and a tooltip can explain the range without opening the file.
- Prompts name the exact range and, for one-line selections, quote the words.
- Old hosts, old pins, old prompts and old adapters behave exactly as they do today.

**Non-Goals:**

- Visual columns (tab expansion, wide glyphs). Columns match the editor's status bar, not a
  rendered layout.
- Selected text is not inlined for multi-line ranges; the agent still reads the file.
- No caret-only chip, no text-drag selection in the browser preview, no pixel-accurate column bands
  in the file preview. Those are follow-ups listed under Open Questions.
- No change to how images or whole-file pins travel.

## Decisions

### One optional span on the existing shapes

Add `startColumn?`, `endColumn?`, `characters?` and `text?` to `EditorSelection`,
`LiveSelectionPreview`, both host wire payloads, both `ChatPin` definitions and `PendingPin`.
Nothing gets a new versioned object or a new message type.

Why: every field is additive, so a mixed-version host/frontend pair keeps working in both
directions. A nested `span` object would be cleaner to type but would force a version check at every
boundary and make an old frontend drop the whole selection instead of just its columns.

Alternative considered: a revisioned `SelectionV2` message. Rejected — two shapes for one concept
would have to be kept in sync forever for no compatibility gain, since `parseHostMessage` only
checks the type tag.

### Capture the last selected character, not the caret boundary

The host reports `start.character + 1` as the start column and `end.character` as the end column.
An editor selection's end is exclusive, so `end.character` is exactly the 1-based column of its last
character. A selection that ends at column 1 of a later line is normalised to the last character of
the previous line, so `endColumn` is never `0`.

Why: this makes the chip's `:45-79` read like the editor's own highlight and keeps a single rule for
single-line and multi-line selections. The alternative — half-open ranges everywhere — needs a
special case at render time and reads worse in a chip.

The character count comes from the document's offsets, so it includes line breaks for a multi-line
selection; that is what the editor's "selected" count means too.

Only one non-empty selection carries columns. Multiple cursors keep the existing line envelope
because a single column pair cannot honestly describe disjoint ranges; the spec calls this out.

### A bounded excerpt travels on the pin

For a selection inside one line, the host also sends the selected words, capped at 120 characters,
single line. The cap is enforced in the host and re-checked when a pin is serialised.

Why: columns tell a model *where* to look, but models are unreliable at counting characters inside a
line. A short quote is the difference between "the words you highlighted" and "line 18 somewhere".
The cap keeps the prompt from growing with the size of the highlight, and single-line-only keeps
multi-line pins honest (a big range is still a file read).

The excerpt rides on the pin rather than being read by the adapter: the adapter has no file I/O and
no guarantee the file has not changed between the pin and the send. The host already had the text in
hand.

### Extend the mention grammar by one column form

```
@path                         whole file
@path:18-20                   whole lines        (unchanged)
@path:18:45-18:79             columns, one line
@path:18:45-20:12             columns, partial across lines
```

The column form always names both endpoints (`18:45-18:79`, never `18:45-79`), because the short
form is indistinguishable from a line range. Lines stay 1-based; the line part of the mention is
still a valid range for an agent that ignores columns.

Rejected alternatives:

- `@path:18:45-79` — shorter, but ambiguous against `@path:18-79`.
- A `  > line 18, columns 45-79` note line — collides with the reader's own annotation syntax,
  which the transcript renders and the inverse parser recovers.
- Inlining the selected text on the mention line — breaks the token grammar, complicates escaping,
  and grows without a natural cap.

### A generated excerpt uses its own marker

The excerpt follows the mention as `  | the selected words`, two spaces deep and one line, capped.
The reader's annotations keep `  > `.

Why a new marker: the transcript already round-trips `  > ` lines into a pin's editable note. Reusing
it would make generated words look like the reader's annotation, and would be re-emitted as a note on
the next fork. `  |` is easy to tell apart in a prompt and trivial to consume in the inverse parser.
The excerpt sits directly under the mention and before any `  > ` notes, so the existing bottom-up
parser sees notes, then excerpt, then the mention.

### Column-aware coalescing degrades to lines

Two ranges on the same line merge when they overlap or touch, and the result keeps the union of
their columns. Any merge that involves two different lines drops columns. A whole-file pin remains a
different kind of chip.

Why: a union across a line break (or with a full line) is not a rectangle, and pretending it has one
column pair would misreport the selection. Degrading to `L18-19` is the honest label.

### One label helper

A single `pinRangeLabel()` lives in `ui-runtime` and is used by the composer, transcript, file
preview and annotation header. It encodes the four cases: whole file, whole lines, one-line columns,
cross-line columns.

Why: the four existing copies already drifted in tiny ways (en dash vs hyphen, empty-end handling).
Adding a fifth case to four copies would guarantee a visible inconsistency.

### Inverse parsing is version-tolerant

`ui-runtime/rows.ts` and pi's `event-mapping.ts` learn the column grammar and consume the `  |` line.
A `  > ` note still attaches to the pin above it. Older mentions parse to lines exactly as before.

The generated line is only consumed when it sits between a column mention and that pin's notes; a
reader's own `  |` line elsewhere in the prompt is left alone.

## Risks / Trade-offs

- **Character offsets are not visual columns** → A tab counts as one, exactly like the editor's status
  bar, and the excerpt removes the need to count at all. Documented in the spec.
- **A truncated excerpt can cut a word** → Truncate at the limit and keep the column range as the
  authority; the agent can still read the line.
- **Models may ignore the column part** → The excerpt is the primary signal; columns serve agents and
  tooling that do count positions, and the line portion remains a valid old-style range.
- **Generated prompt text could look like user prose** → A dedicated `  |` marker, consumed
  symmetrically by both replay paths, and never rendered as prose or as a note.
- **New prompt text changes token counts for tiny selections** → Bounded at 120 characters and only
  for one-line pins; whole-line and whole-file prompts are byte-identical to today.
- **Multi-cursor selections stay coarse** → Accepted; the spec keeps the line envelope and the UI is
  not asked to pretend otherwise.
- **File-preview bands remain line-height** → The label and tooltip carry the columns; an exact
  character band is a follow-up, not a regression.
- **Old adapters ignore the new fields** → They keep serialising lines; the prompt is the same as
  before, and no stored session changes shape.

## Migration Plan

1. Contract first: add the optional fields to the protocol/agent shapes and the wire messages.
2. Host capture: fill them in VS Code; a host that does not fill them keeps producing today's
   payloads.
3. Frontend: render the new labels, tooltips and coalescing; persist/rehydrate the optional fields.
4. Adapters: emit and inverse-parse the column mention and the `  |` excerpt.
5. Docs and tests.

Rollback is safe at any step: every consumer treats the new fields as optional, and an older build
ignores them. No stored-format bump is needed, and there are no new dependencies.

## Open Questions

- Should a caret with no selection show `L18:45` in the preview header? Deferred; it is a display
  change with no prompt impact.
- Should selecting text with the pointer (not the line gutter) in the browser file preview pin a
  column range? Deferred to its own change.
- Should the preview band draw exact character geometry instead of a full-line band? Deferred;
  needs font-metric work.
