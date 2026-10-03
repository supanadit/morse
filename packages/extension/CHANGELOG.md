# Changelog

## Unreleased

- Live selection chip: what you highlight in the editor appears in the composer immediately, with the
  start and end line numbers updating in real time while you drag or re-select. Clicking the chip locks it
  (it keeps its numbers and rides with the next message); a new selection afterwards makes a new live chip.
  Locked chips are sent as `@path:start-end` mentions, and the ⧉ shortcut locks the live preview without a
  round trip.

## 0.1.0

Initial release.

- Chat sidebar that drives `pi --mode rpc` in the active workspace.
- Streaming answers, thinking blocks and tool cards with input/output.
- Steer, follow-up and abort while the agent is running.
- Model and thinking-level pickers, plus context compaction.
- Project browser: several sessions in several projects at once, activate/close, LRU-hot processes.
- Session list and resume from the pi session directory.
- Pi extension dialogs (select/confirm/input/editor) mapped to VS Code UI.
- Editor selection, active file and open editors attached as prompt context.
