# Tasks

## 1. Contract and shared helpers

- [x] 1.1 Add optional `startColumn`, `endColumn`, `characters` and `text` to the agent-domain `ChatPin` and the protocol `ChatPin`, documenting the 1-based column rule in both. Verify with `npm run check-types`.
- [x] 1.2 Extend `EditorSelection` and the `context/selection` / `context/selectionLive` payload types with the same optional fields, and update their doc comments to name the 1-based column rule. Verify with `npm run check-types -w @morse/protocol -w @morse/system`.
- [x] 1.3 Add one `pinRangeLabel()` to `@morse/ui-runtime` covering whole file, `L18`, `L18-20`, `L18:45-79` and `L18:45-20:12`, and unit-test every form plus the missing-end-column case.
- [x] 1.4 Teach `parseMentionToken` / `splitMentionTokens` the `path:line:col-line:col` grammar while keeping `path`, `path:18` and `path:18-20` valid, and test both grammars and a path that merely looks numeric.

## 2. VS Code host capture

- [x] 2.1 Extract the span math into a VS Code-free helper: start column, last selected character, end-at-line-start normalisation, character count, one-line excerpt with a 120-character cap, and the single-selection vs multi-cursor rule. Unit-test each case.
- [x] 2.2 Feed the helper from `SelectionPreviewTracker` so `toLivePreview` reports columns, count and excerpt, keeping the whole-file preview for a focused file with no selection. Verify with the span tests plus a manual VS Code drag.
- [x] 2.3 Carry the span through `VsCodeContextProvider.snapshot()` and the `morse.attachSelection` payload (`toSelectionPayload`), removing the now-unused selected-text drop. Verify by pinning a word range in VS Code and inspecting the chip data.

## 3. Chips, store and persistence

- [x] 3.1 Extend `PendingPin` and every conversion around it (`seed`, `takePins`, `asPendingPin`, live-preview dedupe) with the optional span fields, and test a persisted draft round-trip.
- [x] 3.2 Make `AttachmentStore.pin()` column-aware: union overlapping or touching ranges on one line, drop columns on any cross-line merge, and never merge a whole-file pin. Unit-test those three cases plus `replaceId` editing.
- [x] 3.3 Extend the `ui-runtime` client and `MorseService` listener types for the wider payloads, and update `client.spec.ts` to assert columns and excerpt survive the wire.
- [x] 3.4 Use the shared label in the composer's live and locked chips, and show path, column range, selected count and excerpt in the tooltip. Test the rendered chip text for a column pin, a line pin and a whole-file pin.
- [x] 3.5 Use the shared label in transcript chips, the file preview's header/annotation header and the toast that reports a pin. Test the transcript chip text and the preview label.
- [x] 3.6 Confirm draft persistence and fork seeds rehydrate columns and excerpt (`workbench-persistence.spec.ts`), and add the columns to its fixture.

## 4. Prompt serialization and replay

- [x] 4.1 In the pi adapter, emit `@path:start:col-end:col` for column pins, keep `@path:start-end` for line pins, and append the `  | excerpt` line for one-line pins only, before any `  > ` notes. Test short, long-truncated, multi-line, notes-plus-excerpt and prose-plus-pins prompts.
- [x] 4.2 Mirror the same serialization in the OpenCode adapter with the same test table, since both adapters share the mention convention.
- [x] 4.3 Extend pi's `splitTrailingMentions` to recover columns and excerpt and strip the generated `  |` line, while leaving a reader's own `  |` line and every `  >` note intact. Test old mentions, new mentions, notes, and a stray pipe line.
- [x] 4.4 Verify a fork round-trip: send a column pin, fork the prompt, and confirm the composer seed restores the same range and excerpt.

## 5. Documentation and integration checks

- [x] 5.1 Update `docs/STATUS.md`, `docs/NOTES-AGENT-AGNOSTIC.md` and `docs/FRONTENDS.md` so the documented pin form, chip labels and browser line-drag fallback match the shipped behavior.
- [x] 5.2 Run `npm run check-types`, `npm run lint` and `npm run test:fast`; fix anything they surface.
- [x] 5.3 Manual end-to-end in VS Code: highlight a few words on one line, lock the live chip, send the prompt, confirm the mention and excerpt, then resume the session and confirm the same chip renders. Record the outcome in the change.
  - Outcome: confirmed in VS Code — the live chip locked the word range, the prompt carried `@…:line:col-line:col` with its `  | ` excerpt, and resuming the session rendered the same column chip.

## Workflow follow-up

- Archive the change after review and once every task above is checked.
