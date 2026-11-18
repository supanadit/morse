# Bot rooms: seeing the work, and answers that come back

## Intent and why

Two complaints from a real session, and one real failure found in that session's data.

1. **A bot at work is nearly silent.** The room shows one line that replaces itself
   (`packages/system/src/bot/activity.ts`): "Wait, let me think…", "Reading x", "Writing the
   answer…". The answer's text only appears when the whole turn lands, so a 40-second turn is 40
   seconds of an unreadable label. Nothing says a bot is talking to another bot.
2. **A thread appeared only after a reload.** `createThread` (`service.ts`) pushes the registry to
   disk but never emits `{ type: 'roster' }`, unlike every other path that adds a conversation. The
   sidebar learned about the thread on the next open.
3. **A delegated answer never reached the person.** In that session Sigil asked Loom for a system
   prompt and Loom answered in the thread. Sigil's woken turn ran in the *thread's* engine session —
   a different session from its DM — so it tried to answer the person by writing `Hey — Loom dropped
   off that prompt…` **inside the thread**. The person only got a DM answer later because they
   happened to send another message. There is no path from a bot to a person at all: a delivery can
   name a person (`BotDeliveryOrigin`'s person arm) but nothing ever writes to one.

So a delegation can complete and still leave the person waiting forever. That is the defect this
change exists to remove.

## Goals

- While a bot works, the room shows what it is doing: its steps, the answer as it is written, an
  elapsed count, and any bot it has asked, with a link to the conversation where that happened.
- After the turn, that work is still there: one collapsed line per turn, expandable, kept for a
  while and then pruned.
- A delegated ask always ends with the person answered, in the room where they first spoke.
- A thread a bot opens appears in the sidebar at once, without a reload.
- A bot that needs a bot which is not in the room either opens a thread or asks the person to add
  it, in words.

## Non-goals

- Streaming the answer as the transcript's message. The message still lands whole when the turn
  ends; what streams is the row above it.
- Persisting a bot's private reasoning as readable text. Steps show the activity label, never
  `thinking` deltas.
- A bot adding members to a room, or creating rooms. Both stay the person's.
- A peer bot DMing the person on its own initiative. The answer comes back through the asker, in the
  person's room.
- Any user-facing setting for retention, throttle or caps.

## Decisions

The person chose the shape; these are the calls made while writing it down.

- **C, fully.** Live row with steps, streamed text and handoffs, plus a persisted per-turn record.
- **The answer lands where the person first spoke, and a chain climbs one hop at a time.** Sigil
  relays it. A peer answering the person directly is not built: it would let a bot speak without the
  bot the person is talking to knowing, and the forwarded text already shows the peer's own words.
- **Onward delegation from a thread is allowed.** A woken bot may ask a third bot; its answer is
  forwarded to the room *it* was working in, so the chain walks back to the person instead of
  dead-ending. Depth still bounds it.
- **The person may type in a thread.** A person's line there is never forwarded (only a bot's answer
  is), so the thread stays a room they can join rather than a read-only window.
- **Inviting is text.** No note-with-button, no `bot_invite` tool. The bot says "add Loom here and
  I'll hand it over"; the person adds the member with the existing control.
- **A turn's work is stored only when the turn settles.** Deltas never touch disk; the running turn
  lives in memory. This keeps a chatty engine from turning into a write amplifier.

## The live row

`BotRoutingActive` (`packages/protocol/src/dto/bot.ts`) gains four fields. All are additive.

```ts
interface BotRoutingActive {
  target: string;
  username: string;
  activity: BotActivity;      // unchanged: the current step
  startedAt: number;          // when this turn was taken off the queue
  steps: BotActivity[];       // the last 5, oldest first, including `activity`
  handoffs: BotHandoff[];     // bot sends made during this turn
  partial?: string;           // the answer so far, text channel only
}

interface BotHandoff {
  username: string;           // the bot asked
  conversationId: string;     // the thread or room it was asked in
  at: number;
  activity?: BotActivity;     // what that bot is doing there right now, if anything
}
```

- **Steps.** The service already receives every event (`onGatewayEvent` → `reportActivity`). Keep
  the last five in the per-turn record; replace `activity` on each new step and push a routing
  update on the same cadence as today. `startingActivity` seeds the row only; it is not a recorded
  step (see the turn record).
- **Streamed text.** `agent/delta` with `channel === 'text'` accumulates into `partial`. Push at most
  every ~150 ms and on the last delta before `agent/message`; never write `partial` to disk. Clear it
  when the message lands, so the row hands off to the message without a flicker.
- **Handoffs.** `busSend` records `{ username: target, conversationId: room.id, at }` on the *sender's*
  current turn. `routing()` fills `activity` for a handoff from the target conversation's live
  activity, so the room can say "Loom is writing (in a thread)".
- **The row.** `bot-chat.html`'s presence row renders: current label, elapsed from `startedAt`, the
  last three steps as a compact list, `partial` as muted pre-wrap text (capped for display), and one
  chip per handoff — `asked @loom · open thread` — which opens that conversation. Existing Stop and
  ring behaviour is unchanged.

## The turn record

A new `packages/system/src/bot/traces.ts`, modelled on `deliveries.ts`: one JSON file per
conversation at `<dataDir>/bot/traces/<conversationId>.json`, atomically rewritten through the
exported `writeJsonAtomic`, validated ids (`^[A-Za-z0-9_-]+$`), a missing file reads as `[]`, a
malformed one throws naming its path.

```ts
interface BotTurnTrace {
  id: string;              // the delivery id — one turn, one trace
  conversationId: string;
  username: string;
  /** The display name at settle time: a rename or a delete must not rewrite history. */
  name: string;
  startedAt: number;
  endedAt: number;
  status: 'done' | 'failed' | 'cancelled';
  steps: BotActivity[];
  handoffs: BotHandoff[];
}
```

- Written once, in the lane's settle path, from the in-memory turn record. A cancelled or failed turn
  is recorded too: "how long it ran, where it stopped" is exactly what the record is for.
- `startingActivity` seeds the live row but is not stored as a step. A turn that failed or was
  cancelled before its engine sent anything therefore has an empty step list, and the collapsed line
  says so ("could not start" / "stopped") instead of being hidden — a turn that produced nothing is
  the one the person most needs to find.
- `name` is stored, not resolved from the roster: handles are reusable after a delete, and a trace
  must keep the name it was written with. A deleted bot's traces stay in every surviving room (they
  are that room's history and read correctly from the stored name); deleting a bot removes only its
  own DM's and its threads' files, with the rooms themselves.
- Bounded: keep the newest 100 traces per conversation and prune traces older than 7 days. The sweep
  runs in the same opportunistic pass as `maybePruneDeliveries`, not on every settle.
- **Never read by a bot.** `contextFor` reads transcripts only, so the trace store is invisible to
  every engine by construction. Nothing is added to any prompt.
- `clear` and `deleteGroup`/`deleteThread` forget the room's traces with its transcript.
- **Wire.** The `bot/transcript` payload gains `traces?: BotTurnTrace[]`; `bot/open` and `bot/history`
  return the traces whose `endedAt` falls in that page's window, oldest first, and a settle pushes
  the new trace to the open room with `entries: []` so the record appears without a reload. Window
  rule: the latest page takes every trace with `endedAt` at or after the page's oldest entry `at`;
  `history` takes traces with `endedAt` at or after the requested `before` entry's `at` and before
  the page it just returned. `replace` means "the page's traces", `prepend` means "older ones". An
  older client ignores the field.
- **UI.** `bot-chat` merges traces into the entry list by `endedAt` and draws a collapsed line per
  turn: `Sigil · 38s · read 1 file · asked @loom → thread`. Expanding shows the step list and each
  handoff link. `name` comes from the trace, never the current roster.

## Answers that come back

`BotDelivery` gains `requesterConversationId?: string`: the conversation the asking bot was answering
in when it made the ask, recorded by `busSend` from the live delivery. It is the *immediate* asker's
room, not the person's — that is what lets a chain climb one hop per answer instead of dead-ending
after two.

A bot's answer is always a transcript line in the conversation it answered in. On settle, in the
lane:

- **Forward when all hold:** `delivery.from.type === 'bot'` (a person speaking in a thread is never
  forwarded), the conversation it answered in is a `thread`, and `requesterConversationId` names a
  different conversation that still exists.
- **What the host writes.** One line in the asker's room, authored by the answering bot, saying
  where it came from: `Loom, in a private thread with @sigil: <answer>`. Then a delivery to the
  *asking* bot in that same room, `kind: 'reply'`, `reason: 'bot'`, `depth + 1`, pointing at that
  line — unless the asker is no longer a member of that room, in which case the line is still
  written (the person sees the answer) and nobody is woken.
- **The chain climbs.** A woken turn runs in the asker's own room, in that room's engine session. If
  that room is itself a thread, its answer forwards one hop further by the same rule. It terminates
  where it must: the last answer lands in a `dm` or `group`, which is person-facing, so it is a
  normal bot message and wakes nobody. Depth still increments per hop and the existing depth cap
  (4) remains the runaway bound.
- **Person-facing answers wake nobody.** A bot answering in a `dm` or `group` was asked *in* that
  room; the person saw it, and a bot's in-room reply queues nothing, as today.
- **No `kind` terminator.** Whether a send is `message`, `assign` or `reply` changes its label, not
  whether its answer comes back — a bot that answers an `assign` with `reply` (the documented use)
  must still be relayed.
- **Header.** A delivery whose sender is a bot and whose line is a forwarded answer gets its own lead
  line in `contextFor`: a teammate answered the ask you sent; use it to answer the person, and do not
  send it back. The host mints those deliveries with `kind: 'reply'`, so the header keys off that —
  and a bot's own `reply` to another bot is framed the same way, which is correct: it is an answer to
  that bot's ask.
- **Failure is said, not silent.** A failed or cancelled turn in a thread whose ask came from a bot
  writes a note in the asker's room naming the bot and the reason, and wakes nobody.
- **Edge: the asker's room is gone.** Nothing is forwarded; the thread gets a note saying the answer
  could not be handed back. The answering lane still settles and moves on.

The person's own room remains the only place they are spoken to: no bot writes into a DM it was not
asked in, and no peer answers the person directly.

## Bots outside the room

No new tool and no new control. Two things change:

- `BOT_BUS_INSTRUCTION` gains one sentence: a bot needed by this room can be asked in a private
  thread, or the person can be asked to add it here when the work belongs in this room.
- The group turn's introduction already names the room's members and `bot_list` already reports
  `inRoom`; nothing else is needed for a bot to know who is present.

## The roster push

`createThread` is the only conversation-creating path that does not announce itself. Emit
`{ type: 'roster' }` after the registry save that follows a thread's creation, so the sidebar draws
the thread while the ask is still running.

## Wire and migration

- `PROTOCOL_VERSION` 42 → 43: `BotRoutingActive` gains fields, `BotTurnTrace` is new, `BotDelivery`
  gains `requesterConversationId`, the transcript payload gains `traces`.
- Registry stays version 3. No transcript is rewritten. An old delivery without
  `requesterConversationId` simply never forwards.
- Traces live in their own directory and are created lazily; no data-layout step is needed, but
  `docs/DATA-COMPATIBILITY.md` names the new directory.
- `docs/STATUS.md` describes the live row, the record and the answer path.

## What is left to the builder

- The throttle interval for `partial`, and whether to coalesce multiple deltas per push.
- How many steps the row shows (three is the intent) versus how many the record keeps (the turn's
  whole list, capped at a small number).
- Whether a handoff chip shows the peer's live label at all, or only "asked @loom".
- The exact collapsed-line grammar.
- Where the trace store's cap is enforced (write path or sweep) — as long as a room never grows
  without bound.

## Verification

- A delegation in a DM: Sigil asks Loom; Loom answers in the thread; the DM shows Loom's forwarded
  line and Sigil answers the person without a new person message. The thread shows both sides once.
- A two-hop chain: Sigil asks Loom, Loom asks a third bot; the answer climbs back thread by thread
  and the person's room is answered, with depth growing by one per hop.
- A bot answering in a group wakes nobody, and the person sees the answer as a normal message.
- A person typing in a thread is answered there and nothing is forwarded.
- Two bots in one room: each has its own row, its own steps, its own ring, and a handoff chip only
  on the sender.
- A bot's text streams in the row while the answer is being written, and the row is gone the moment
  the message lands.
- The record survives a restart, is pruned at the TTL, and never appears in any bot's prompt.
- Opening a room mid-turn shows the same steps the push was sending.
- A thread created by a bot appears in the sidebar before the person next reloads.
- A group where a bot needs an absent bot: the thread path works, and the text-only ask reaches the
  person unchanged.
