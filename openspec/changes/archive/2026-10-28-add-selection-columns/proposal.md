# Proposal

## Why

Morse throws away the part of an editor selection that makes it precise. The VS Code host reads
the selected text and then reports only `startLine`/`endLine`, so a user who highlights a few words
on one line gets a whole-line pin (`L18`, `@path:18-18`). The chip cannot show which words were
meant, and the agent has to guess inside the line. Editors show `Ln/Col` and a selected-character
count for exactly this reason; Morse should preserve the same precision from the editor to the
prompt.

## What Changes

- The host captures a **selection span**: 1-based start/end line and column, the selected character
  count, and a short excerpt of the words for one-line selections.
- `context/selection`, `context/selectionLive`, `EditorSelection`, and `ChatPin` carry the span.
  Every new field is optional, so existing sessions, pins, hosts, and adapters keep working.
- Chips label a partial-line selection `L18:45-79` and a multi-line partial `L18:45-20:12`, while
  whole-line pins keep `L18-20`. One shared label helper replaces the four duplicated copies.
  Tooltips add the column range, the selected-character count, and the excerpt.
- Pin coalescing understands columns: overlapping or touching ranges on one line union their
  columns; any merge across lines falls back to whole lines, which is what those pins can honestly
  claim.
- The prompt mention grammar extends additively: `@path:18:45-18:79` (and
  `@path:18:45-20:12` when the selection crosses lines), followed by an auto-generated excerpt line
  `  | the highlighted words` for bounded one-line selections. It is distinct from the user's own
  `  > ` annotation lines. Old `@path:18-20` prompts still parse and render unchanged.
- The inverse parsers (`ui-runtime` mention rendering and pi's transcript replay) learn the new
  grammar and consume the excerpt line, so a resumed session or a fork re-renders the same chips
  without turning generated text into the user's prose or notes.
- Multi-cursor selections keep today's line envelope; a focused file with no selection keeps the
  whole-file chip. Neither is a regression.

## Capabilities

### New Capabilities

- `ui/selection-pins`: how an editor selection is captured, previewed, locked, labelled, coalesced,
  and handed to an agent with column precision.

### Modified Capabilities

None. `agent/harness-contract` already requires attachments to reach a harness; the new capability
owns the precision of a selection attachment and its prompt representation.

## Impact

- `packages/protocol`: `ChatPin`, both host wire messages, and the `engine`-adjacent view docs that
  describe a selection payload.
- `packages/agent`: the domain `ChatPin` shape used by the harness contract.
- `packages/system`: `EditorSelection` and the host context snapshot types.
- `packages/extension`: `SelectionPreviewTracker`, `VsCodeContextProvider`, the attach command, and
  the selection payload.
- `packages/ui-runtime`: mention parsing/rendering, the shared pin-range label, and the client
  listener types.
- `packages/ui-angular`: `AttachmentStore`, composer chips/tooltips, transcript chips, the file
  preview's labels, and draft persistence.
- `packages/integration-pi`, `packages/integration-opencode`: prompt serialization and the inverse
  mapping used when replaying a stored conversation.
- Documentation: `docs/STATUS.md`, `docs/NOTES-AGENT-AGNOSTIC.md`, and the frontend notes on pins.
- No new runtime dependencies and no breaking wire change; a host or adapter that does not send
  columns produces the same prompts and chips as today.
