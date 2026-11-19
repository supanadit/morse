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
- **Every shape and sentence in this document is Morse's own.** Nothing here is reproduced from
  another project, and no file names, identifiers or prose are borrowed from one.

## The live row

`BotRoutingActive` gains four fields, and `BotActivity` gains three optional ones. All additive.

```ts
interface BotActivity {
  kind: 'starting' | 'thinking' | 'writing' | 'tool';
  label: string;
  tool?: string;
  at: number;
  /** A tool's outcome, once known. Absent while it runs; absent on a thought. */
  status?: 'running' | 'ok' | 'error';
  /** What a failed tool said, trimmed to a line the row can open. */
  error?: string;
  /** How long a finished tool took, so the record can point at the slow ones. */
  durationMs?: number;
}

interface BotRoutingActive {
  target: string;
  username: string;
  activity: BotActivity;      // unchanged: the current step
  startedAt: number;          // when this turn was taken off the queue
  steps: BotActivity[];       // newest last, capped at 8; `activity` is the last
  handoffs: BotHandoff[];     // bot sends made during this turn
  partial?: string;           // the answer so far, text channel only
}

interface BotHandoff {
  username: string;           // the bot asked
  conversationId: string;     // the thread or room it was asked in
  deliveryId: string;         // the ask it created, so its state is read exactly
  at: number;
  /** Read from that delivery: queued→asked, running→working, done→done;
   *  failed, dropped or cancelled→failed. */
  state: 'asked' | 'working' | 'done' | 'failed';
  /** What that bot is doing there right now, when it has a live step. */
  activity?: BotActivity;
}
```

- **Steps come from what the engine already sends.** `agent/tool-start` opens a step with
  `status: 'running'`; `agent/tool-update` advances it; `agent/tool-end` closes it with `ok` or
  `error`, its `durationMs`, and the failure text it already carries. A thought and a written answer
  are steps too. No engine is asked for anything new, and the case the current mapping drops is the
  one that matters most: a tool that failed is drawn as failed, with its own text, instead of
  vanishing into "Thinking it over…".
- **Silence is the client's to read.** The newest step's `at` is all it needs: at 20 s of quiet the
  row stops its shimmer and says it is waiting on the model. A `tool` step still running keeps its
  shimmer however long it runs — a slow command is work, not a stall — and the turn's own deadline
  is what eventually ends it.
- **Streamed text is paced, not dumped.** `agent/delta` on the text channel accumulates into
  `partial`; the service pushes at most every 150 ms and once more before `agent/message`. The
  client reveals what it received at a rate that rises with the unread backlog and stops on a word
  boundary, so a burst reads as writing rather than a wall, and a slow trickle is not padded. The
  reveal uses a transform, not a repainted label.
- **Handoffs are live.** `busSend` records one entry on the *sender's* current turn. Its `state` is
  read from the target's delivery whenever the row is drawn, so it moves asked → working → done
  without another event, and a peer that failed is `failed` on the sender's row rather than only in
  a note elsewhere. `activity` is the peer's live step in that conversation, when it has one.
- **The row.** `bot-chat.html`'s presence row draws the current label, elapsed from `startedAt`
  (hidden under 5 s; minutes after a minute), the newest three steps behind a chevron, `partial` as
  muted pre-wrap text, and one chip per handoff — `asked @loom · open thread` — which opens that
  conversation. A failed step opens its error. Existing Stop and ring behaviour is unchanged. The
  row keeps its `role="status"` with one sentence naming the bot and what it is doing.

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
  is recorded too: "how long it ran, where it stopped" is exactly what the record is for. A handoff
  is stored with the state it ended in, so a delegated ask that failed is visible in the record as
  well as in the room's note.
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
  turn: `Sigil · 38s · 4 steps · asked @loom → thread`. Expanding shows the steps — each with its
  outcome, its error when it failed, and its handoff link — and `name` comes from the trace, never
  the current roster.

## Answers that come back

A thread records where it came from. `ConversationRecord` (kind `'thread'`) gains two optional
fields, written when the thread is created: `parentId` — the conversation the asking bot was working
in — and `askedBy` — that bot's handle.

A thread is one long-lived room per pair of bots: every later ask between them reuses it, from
whichever room the sender happens to be answering in, and a thread is never deleted. So the room an
answer belongs in is recorded per ask, not per thread: `BotDelivery` gains an optional `originId`, the
room the sender was working in, set by `busSend`. The thread's `parentId`/`askedBy` remain what the
relay's own wake-up uses, because an answer has no ask of its own — that is what lets a chain climb more
than one hop.

A bot's answer is always a transcript line in the conversation it answered in. On settle, in the
lane:

- **Hand back when all hold:** `delivery.from.type === 'bot'` (a person speaking in a thread is never
  forwarded), the conversation it answered in is a `thread`, and the room to hand it back to — the
  delivery's `originId`, or the thread's `parentId` when the delivery is the relay's wake-up — still
  exists and is not the thread itself.
- **What the host does.** The peer's answer is not written into that room: the person messaged *their*
  bot, and a delegated bot speaking there — even quoted — would read as somebody else joining the
  chat. The room instead gets a delivery to the bot that asked — the delivery's sender, or the
  thread's `askedBy` for a wake-up — `kind: 'reply'`, `reason: 'bot'`, `depth + 1`, pointing at the
  room's newest line, with the peer's words on an optional `answer` field. The asker's prompt carries
  them (a `reply` wake gets the lead line that says to answer the person and not send it back), and
  the asker replies in its own words. Unless the answering bot *is* that bot, in which case nobody is
  woken: the bot that asked is the bot that just answered, and waking it would be a self-loop.
- **An empty answer.** A peer that ended without words still wakes the asker, with `answer: ''`; the
  prompt says the answer came back empty, and the asker tells the person.
- **Nobody to speak it.** If the asker left the room, or the thread never recorded one, no wake is
  possible and Morse writes the answer into the room as a routing note instead of dropping it.
- **The chain climbs.** A woken turn runs in the room's own engine session. If that room is itself a
  thread, its answer is handed back one hop further by the same rule, so a two-hop chain walks back
  thread by thread to the person's room. It terminates where it must: the last room is a `dm` or
  `group`, which is person-facing, so the answer is a normal bot message and wakes nobody. Depth still
  increments per hop and the existing depth cap (4) remains the runaway bound.
- **Person-facing answers wake nobody.** A bot answering in a `dm` or `group` was asked *in* that
  room; the person saw it, and a bot's in-room reply queues nothing, as today.
- **No `kind` terminator.** Whether a send is `message`, `assign` or `reply` changes its label, not
  whether its answer comes back — a bot that answers an `assign` with `reply` (the documented use)
  must still be handed back.
- **Header.** A delivery whose sender is a bot and whose line is a handed-back answer gets its own lead
  line in `contextFor`: a teammate answered the ask you sent; use it to answer the person, and do not
  send it back. The host mints those deliveries with `kind: 'reply'`, so the header keys off that —
  and a bot's own `reply` to another bot is framed the same way, which is correct: it is an answer to
  that bot's ask.
- **Failure is said, not silent.** A failed or cancelled turn in a thread whose answer could not be
  handed back writes a note in the room that would have received it, naming the bot and the reason,
  and wakes nobody.
- **Edge: the parent is gone.** Nothing is handed back; the thread gets a note saying the answer could
  not be handed back. The answering lane still settles and moves on.
- **Threads older than this change** have no `parentId`, and nothing backfills one. Their direct asks
  still come home — the ask carries its own room — but a wake-up inside one has nowhere to climb, so
  the answer stays in the thread, which is where it already was.

The person's own room remains the only place they are spoken to: no bot writes into a DM it was not
asked in, and no peer answers the person directly.

### What the room shows

Silence would be wrong the other way: the person asked for work and must see that it was handed on,
without ever seeing the peer as a participant.

- **The answer that came back.** A wake-up's trace carries the peer's words in an optional `reply`
  (handle, display name, when it was handed back, and the text — empty when the peer ended without
  words). Above the answer that turn produced, the transcript draws one folded, centred line:
  `Messaged <name> · <time>`. Opening it shows the peer's message, attributed and rendered as
  markdown, or `came back empty`. It is folded by default and is never a chat line; the turn's own
  record still says what the turn did.
- **Waiting on a peer.** `BotRoutingState` gains an optional `waiting`: one row per ask a bot in this
  room made elsewhere and has not been answered on. The rows come from the thread's delivery file by
  `originId`, so a client opening the room late and one watching a push draw the same list; each row
  carries the peer, `asked` or `working`, the step it is on when it has one, and the thread to open.
  The bot composer draws it in the panel a session already uses for queued follow-ups — *Waiting for
  replies*, one row per peer, a click opens that thread — and a routing push reaches the asking room
  when the peer's delivery starts or settles, so the block appears, moves and disappears on its own.
  An ask answered in the same room is not listed: the peer is already visible there.

Both are additive wire fields read defensively (`waiting ?? []`), so no protocol bump: an older
frontend ignores them, and a newer one against an older host shows neither block.

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

- `PROTOCOL_VERSION` 42 → 43: `BotActivity` gains its optional outcome fields, `BotRoutingActive`
  gains its four, `BotTurnTrace` is new, and the transcript payload gains `traces`.
- Registry stays version 3. A thread's `parentId`/`askedBy` are registry-only (no wire field): a
  thread written before this change has neither, and only its wake-ups cannot climb. No transcript is
  rewritten. `BotDelivery.originId` and `BotDelivery.answer` are optional and internal to the host's
  bus (deliveries never cross the wire), so no protocol bump: a build that does not know the fields
  ignores them, and its older rows simply have no answer to carry.
- `BotTurnTrace.reply` and `BotRoutingState.waiting` are additive wire fields; the protocol version
  stays 43 because neither changes a shape a peer must understand: `waiting` is read as `?? []`, and a
  trace without `reply` draws no folded peer line.
- Traces live in their own directory and are created lazily; no data-layout step is needed, but
  `docs/DATA-COMPATIBILITY.md` names the new directory.
- `docs/STATUS.md` describes the live row, the record and the answer path.

## What is left to the builder

- The exact reveal cadence on the client, and whether one push may carry several deltas (it should).
- How many steps the row shows (three is the intent) versus how many the record keeps (the turn's
  whole list, capped at a small number).
- The exact collapsed-line grammar.
- Where the trace store's cap is enforced (write path or sweep) — as long as a room never grows
  without bound.
- Whether a handoff's `activity` is filled only for a visible room, or for a thread the person is
  not looking at (it should be, since they own both bots).

## Verification

- A delegation in a DM: Sigil asks Loom; Loom answers in the thread; the DM shows Loom's forwarded
  line and Sigil answers the person without a new person message. The thread shows both sides once.
- A two-hop chain: Sigil asks Loom, Loom asks a third bot; the answer climbs back thread by thread
  and the person's room is answered, with depth growing by one per hop.
- A bot answering in a group wakes nobody, and the person sees the answer as a normal message.
- A person typing in a thread is answered there and nothing is forwarded.
- Two bots in one room: each has its own row, its own steps, its own ring, and a handoff chip only
  on the sender.
- A bot's text reveals in the row while the answer is being written, and the row is gone the moment
  the message lands.
- A tool that fails draws as failed with its own text, and the turn continues; the record keeps that
  outcome after the turn.
- A silent engine stops shimmering after 20 s and reads as waiting, while a slow tool keeps
  shimmering until it ends.
- A handoff chip moves asked → working → done while the thread runs, without a reload, and shows
  failed when the peer's turn fails.
- The record survives a restart, is pruned at the TTL, and never appears in any bot's prompt.
- Opening a room mid-turn shows the same steps the push was sending.
- A thread created by a bot appears in the sidebar before the person next reloads.
- A group where a bot needs an absent bot: the thread path works, and the text-only ask reaches the
  person unchanged.
