# Message timestamps and per-message model

Date: 2026-11-15
Status: proposed

## Intent

A reader can change model at any moment mid-conversation, and nothing in the transcript says which
model wrote which answer: the picker at the foot of the composer always names the *current* one.
The clock is missing too — only the user bubble shows `HH:MM`, so a bot-mode line, an assistant
answer, a notice or a compaction divider cannot be placed in the day.

Goal: every message carries a wall-clock time in both modes, and every assistant answer in code
mode names the model that produced it — the model at the moment that row was written, not the
session's model now.

## Non-goals

- No model label in bot mode (timestamps only there).
- No wall-clock time on tool steps or thinking notes: they keep the elapsed duration they already
  show, which is the useful number inside a turn.
- No engine contract change. The engine is not asked to report the model per message.
- No new user preference: the meta is always on.

## Constraints

- Transcript items already carry `at` (every kind), so timestamps are a render change.
- `AssistantTranscriptItem.model` already exists on the wire and is filled by resumed history: pi
  writes the model id (`glm-5.3-flash`), OpenCode writes `provider/id`. Live rows never fill it.
- `agent/state` already carries `state.model` and reaches the controller for every session, active
  or not. It is deliberately not projected into the transcript today.

## Approaches considered

1. **The engine reports the message's own model (rejected).** Add `model` to `agent/message`; pi
   fills it from `message.model` and OpenCode from its step model. The most precise source, but it
   touches the agent event contract and both adapters, and an engine that reports nothing leaves a
   blank label — a failure mode Morse cannot repair.
2. **The host stamps the session's model when it creates the row (chosen).** The transcript store
   remembers the session model from `agent/state` and the projector writes it onto each assistant
   row as it opens. One implementation, every engine, no blank labels ever; a resumed row keeps the
   engine's own persisted value, which is the more precise source where it exists. The cost is
   ordering: a row created in the instant before a reported model change names the previous model.

The owner picked 2: Morse owns the stamp, so nothing can go missing.

## Design

**Host.** `SessionTranscriptStore` gains `setModel(sessionKey, model?)`, remembered per session
alongside the cursor and handed to that session's projector. `TranscriptProjector` gains
`setModel(model?)`: it stores the reference, stamps `model: model.id` when it opens an assistant
item, and — if a model change lands while an assistant item is still open without a model — fills
that item and emits the update.

The controller calls `transcripts.setModel(...)` on every `agent/state`, before it decides whether
the session is in front, so warm background sessions stamp correctly too. Nothing else on the wire
changes.

**Display.** The wire keeps the engine's identifier. The transcript resolves it against the model
catalog for display: an exact `id` match (live pi rows, history pi rows) or a `provider/id` match
(history OpenCode rows) shows the catalog `name` (`GLM-5.3-Flash`), and anything unresolved shows
the raw identifier. The tooltip is `provider/id` when the catalog knows it, otherwise the raw value.

Timestamps are `HH:MM` in the reader's locale with the full date and time in the tooltip — the same
shape the user bubble uses today. In code mode the stamp sits in the meta row under the message:
`GLM-5.3-Flash · 14:34` for an assistant answer, `14:32` for a notice or the compaction divider.
Bot mode puts its `<time>` in each user and bot entry the same way its discussion divider does now.

## What is left to the builder

- The shared time/label helpers (one place, used by transcript and bot chat).
- Exact CSS spacing of the meta row and the bot line, matching each surface's current rhythm.
- Whether an assistant row with no text (thinking-only) shows meta: it has no visible message, so no.
