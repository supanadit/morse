# Bot Feedback and Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a working bot's steps, text and handoffs visible while it works and afterwards, and make a delegated ask always end with the person answered in their own room.

**Architecture:** The lane already receives every engine event; this change keeps a per-turn record from them (steps, handoffs, answer-so-far), publishes it on the existing routing push, writes it to a per-conversation trace store when the turn settles, and relays a peer's answer out of a thread through the thread's own parent.

**Tech Stack:** TypeScript, npm workspaces, Vitest, NestJS (server host), Angular (UI), pi and OpenCode plugin assets already built.

**Spec:** `docs/superpowers/specs/2026-11-18-bot-feedback-and-replies-design.md`

## Global Constraints

- `@morse/system` stays engine-agnostic: no engine names, no plugin source, no `child_process`.
- Wire changes are additive only; `PROTOCOL_VERSION` goes 42 → 43 exactly once, in Task 1.
- Registry stays version 3; a thread gains optional `parentId`/`askedBy`; no transcript is rewritten.
- Path-safe ids only: `^[A-Za-z0-9_-]+$`.
- A trace is never read by a bot: `contextFor` reads transcripts only and must stay that way.
- Backstops unchanged: depth 4, 48 per root, queue 32, 60 per bot per hour, 24 h TTL, 5 min turn.
- No new user-facing setting; no wizard field; nothing added to `CONFIGURATION.md`.
- Values pinned here: 8 steps per turn, 8 handoffs per turn, 2 000 characters of `partial`, a partial push at most every 150 ms, 100 traces per room, 7 days of traces.
- No product names, borrowed identifiers or copied prose anywhere — code, comments, docs, commits.
- Conventional commits. `npm run test:fast` must be green on the final task.

## Review Focus

- **A tool that fails mid-turn.** The row draws it as failed with its own text, the turn continues, and the record keeps the outcome — never a silent "Thinking it over…".
- **A peer in a thread that fails or is cancelled.** The room that would have received the answer gets a note, the sender's handoff reads `failed`, and nobody waits forever.
- **A person typing in a thread.** Nothing is forwarded and no bot is woken, so the room does not grow a duplicate line.
- **A corrupt trace file.** Every other room still opens and records; the sweep reports the bad path and never overwrites it.
- **A restart mid-turn.** No half-written trace, the delivery is re-queued, and the row rebuilds from the delivery plus the fresh turn record.

---

### Task 1: Protocol shapes for steps, traces and the page

**Files:**
- Modify: `packages/protocol/src/dto/bot.ts` (`BotActivity`, `BotHandoff` new, `BotRoutingActive`)
- Modify: `packages/protocol/src/dto/bot-bus.ts` (`BotTurnTrace` new, `BotTurnTraceStatus`)
- Modify: `packages/protocol/src/wire/host.ts` (`BotTranscriptMessage.payload.traces`)
- Modify: `packages/protocol/src/version.ts` (`PROTOCOL_VERSION = 43`)
- Test: `packages/protocol/src/dto/bot.spec.ts`, `packages/protocol/src/dto/bot-bus.spec.ts`

**Interfaces:**
- Produces: `BotActivity.status?: 'running' | 'ok' | 'error'`, `BotActivity.error?: string`, `BotActivity.durationMs?: number`; `BotHandoff { username, conversationId, deliveryId, at, state: 'asked' | 'working' | 'done' | 'failed', activity?: BotActivity }`; `BotRoutingActive.startedAt: number`, `.steps: BotActivity[]`, `.handoffs: BotHandoff[]`, `.partial?: string`; `BotTurnTrace { id, conversationId, username, name, startedAt, endedAt, status: 'done' | 'failed' | 'cancelled', steps: BotActivity[], handoffs: BotHandoff[] }`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/protocol/src/dto/bot.spec.ts
it('names a tool step that failed', () => {
  const step: BotActivity = {
    kind: 'tool',
    label: 'Running npm test',
    tool: 'bash',
    at: 1,
    status: 'error',
    error: 'exit 1',
    durationMs: 1_200,
  };
  expect(step.status).toBe('error');
});

it('draws a live row from a turn record', () => {
  const row: BotRoutingActive = {
    target: 'Sigil',
    username: 'sigil',
    startedAt: 10,
    steps: [{ kind: 'starting', label: 'Getting started…', at: 10 }],
    handoffs: [
      { username: 'loom', conversationId: 'thread-loom-sigil', deliveryId: 'd1', at: 11, state: 'working' },
    ],
    partial: 'Tally is',
    activity: { kind: 'writing', label: 'Writing the answer…', at: 12 },
  };
  expect(row.handoffs[0]?.state).toBe('working');
});

// packages/protocol/src/dto/bot-bus.spec.ts
it('keeps a finished turn as a trace', () => {
  const trace: BotTurnTrace = {
    id: 'd1',
    conversationId: 'dm-sigil',
    username: 'sigil',
    name: 'Sigil',
    startedAt: 10,
    endedAt: 48_000,
    status: 'done',
    steps: [{ kind: 'tool', label: 'Reading brief.md', tool: 'read', at: 12, status: 'ok' }],
    handoffs: [],
  };
  expect(trace.steps[0]?.status).toBe('ok');
});

it('carries traces on a transcript page', () => {
  const payload: BotTranscriptMessage['payload'] = {
    conversationId: 'dm-sigil',
    entries: [],
    replace: false,
    traces: [],
  };
  expect(payload.traces).toEqual([]);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -w @morse/protocol -- src/dto/bot.spec.ts src/dto/bot-bus.spec.ts`
Expected: FAIL — `status` does not exist on `BotActivity`; `BotTurnTrace` is not exported; `traces` is not on the payload.

- [ ] **Step 3: Implement**

Add the fields and the new types exactly as pinned. Keep the existing commentary voice: each optional field gets one line saying when it is absent. Set `PROTOCOL_VERSION = 43`. No runtime validation lives in these files beyond what is already there.

- [ ] **Step 4: Run the tests**

Run: `npm run test -w @morse/protocol` and `npm run check-types -w @morse/protocol`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src
git commit -m "feat(protocol): carry bot steps, handoffs and turn traces"
```

---

### Task 2: Step signals from engine events

**Files:**
- Modify: `packages/system/src/bot/activity.ts` (add `stepForEvent`, keep `activityForEvent` until Task 4)
- Test: `packages/system/src/bot/activity.spec.ts`

**Interfaces:**
- Produces: `StepSignal = { kind: 'step'; step: BotActivity; toolCallId?: string } | { kind: 'tool'; toolCallId: string; status: 'running' | 'ok' | 'error'; error?: string; durationMs?: number } | { kind: 'clear' } | undefined` and `stepForEvent(event: AgentEvent, at: number): StepSignal`.
- Consumes: `agent/*` events (`tool-start`, `tool-update`, `tool-end`, `delta`, `message`, `run-start`).

- [ ] **Step 1: Write the failing tests**

```ts
it('opens a tool step that carries its outcome when it ends', () => {
  const start = stepForEvent(
    {
      type: 'agent/tool-start',
      at: 1,
      toolCallId: 't1',
      name: 'bash',
      title: 'npm test',
      input: '{"command":"npm test"}',
    },
    10,
  );
  expect(start).toMatchObject({
    kind: 'step',
    toolCallId: 't1',
    step: { kind: 'tool', tool: 'bash', status: 'running', label: 'Running npm test' },
  });

  expect(
    stepForEvent(
      { type: 'agent/tool-end', at: 1, toolCallId: 't1', status: 'error', output: 'exit 1', durationMs: 900 },
      20,
    ),
  ).toEqual({ kind: 'tool', toolCallId: 't1', status: 'error', error: 'exit 1', durationMs: 900 });
});

it('advances a running tool without inventing a step', () => {
  expect(
    stepForEvent({ type: 'agent/tool-update', at: 1, toolCallId: 't1', status: 'running' }, 15),
  ).toEqual({ kind: 'tool', toolCallId: 't1', status: 'running' });
});

it('writes and clears', () => {
  expect(stepForEvent({ type: 'agent/delta', at: 1, channel: 'text', delta: 'Ta' }, 30)).toMatchObject({
    kind: 'step',
    step: { kind: 'writing' },
  });
  expect(stepForEvent({ type: 'agent/message', at: 1, text: 'Tally', thinking: '' }, 40)).toEqual({
    kind: 'clear',
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -w @morse/system -- src/bot/activity.spec.ts`
Expected: FAIL — `stepForEvent` is not exported.

- [ ] **Step 3: Implement**

Reuse `describeTool` for the label. `tool-update` reports the status it carries; `tool-end` reports `ok` or `error`, `durationMs`, and `output` as the error text only when the status is `error`. `run-start` and a thinking delta produce a thinking step, a text delta a writing step, `message` the clear signal, every other event `undefined`. Keep the existing constants and verbs; delete none of them in this task.

- [ ] **Step 4: Run the tests**

Run: `npm run test -w @morse/system -- src/bot/activity.spec.ts` and `npm run check-types -w @morse/system`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/bot/activity.ts packages/system/src/bot/activity.spec.ts
git commit -m "feat(system): read a tool step's outcome from the engine events"
```

---

### Task 3: The per-turn record

**Files:**
- Create: `packages/system/src/bot/turns.ts`
- Test: `packages/system/src/bot/turns.spec.ts`

**Interfaces:**
- Produces: `TURN_STEPS_MAX = 8`, `TURN_HANDOFFS_MAX = 8`, `TURN_PARTIAL_MAX = 2_000`; `TurnSnapshot { username, conversationId, startedAt, steps, handoffs, partial }`; `class BotTurnTracker { constructor(clock: () => number); start(username, conversationId): void; get(username): TurnSnapshot | undefined; step(username, step: BotActivity, toolCallId?): void; toolStatus(username, toolCallId, update: { status: 'running' | 'ok' | 'error'; error?: string; durationMs?: number }): void; appendPartial(username, delta): void; handoff(username, handoff: BotHandoff): void; take(username): TurnSnapshot | undefined; clear(username): void }`.
- Consumes: `BotActivity`, `BotHandoff` from Task 1.

- [ ] **Step 1: Write the failing tests**

```ts
it('starts with a starting step and keeps the newest eight', () => {
  const tracker = new BotTurnTracker(() => 0);
  tracker.start('sigil', 'dm-sigil');
  for (let index = 0; index < 10; index += 1) {
    tracker.step('sigil', { kind: 'thinking', label: `step ${index}`, at: index });
  }
  const turn = tracker.get('sigil');
  expect(turn?.steps).toHaveLength(8);
  expect(turn?.steps.at(-1)?.label).toBe('step 9');
  expect(turn?.startedAt).toBe(0);
});

it('closes the step a tool call opened', () => {
  const tracker = new BotTurnTracker(() => 0);
  tracker.start('sigil', 'dm-sigil');
  tracker.step('sigil', { kind: 'tool', label: 'Running npm test', tool: 'bash', at: 1, status: 'running' }, 't1');
  tracker.toolStatus('sigil', 't1', { status: 'ok', durationMs: 900 });
  expect(tracker.get('sigil')?.steps.at(-1)).toMatchObject({ status: 'ok', durationMs: 900 });
});

it('keeps the tail of the answer and hands the turn over once', () => {
  const tracker = new BotTurnTracker(() => 0);
  tracker.start('sigil', 'dm-sigil');
  tracker.appendPartial('sigil', 'x'.repeat(2_500));
  expect(tracker.get('sigil')?.partial).toHaveLength(2_000);
  expect(tracker.take('sigil')?.conversationId).toBe('dm-sigil');
  expect(tracker.get('sigil')).toBeUndefined();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -w @morse/system -- src/bot/turns.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

One record per bot username, created by `start` with a `starting` step (`label: 'Getting started…'`) at the clock's time. Steps are appended and capped newest-eight; `toolStatus` mutates the step object the `toolCallId` opened (ignore an id whose step was already dropped). `partial` keeps the last `TURN_PARTIAL_MAX` characters. Handoffs are appended, capped newest-eight, and replace an existing `deliveryId`. `take` removes and returns; `clear` removes. No I/O.

- [ ] **Step 4: Run the tests**

Run: `npm run test -w @morse/system -- src/bot/turns.spec.ts` and `npm run check-types -w @morse/system`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/bot/turns.ts packages/system/src/bot/turns.spec.ts
git commit -m "feat(system): keep one turn's steps, handoffs and answer so far"
```

---

### Task 4: The service publishes the live row

**Files:**
- Modify: `packages/system/src/bot/service.ts` (`activities` map, `reportActivity`, `routing`, `pump`, `onGatewayEvent`, `busSend`)
- Modify: `packages/system/src/bot/activity.ts` (delete `activityForEvent`, `ActivitySignal`, `REVIEWING_LABEL`; keep `describeTool`, `startingStep`)
- Modify: `packages/system/src/bot/service.spec.ts`
- Test: `packages/system/src/bot/service.spec.ts`

**Interfaces:**
- Consumes: `stepForEvent` (Task 2), `BotTurnTracker` (Task 3).
- Produces: `routing()` rows carrying `startedAt`, `steps`, `handoffs` (with delivery-derived `state`) and `partial`; a constant `PARTIAL_PUSH_MS = 150` used only here.

- [ ] **Step 1: Write the failing tests**

Adapt the existing gateway harness (`gates.started()`, `gates.resolve()`), which already holds a turn open.

```ts
it('shows the steps of a running turn and the answer as it is written', async () => {
  const { service, gates } = harness();
  await service.send('dm-sigil', 'name a bot', {});
  await gates.started();
  gates.emit({ type: 'agent/tool-start', at: 1, toolCallId: 't1', name: 'read', title: 'brief.md' });
  gates.emit({ type: 'agent/tool-end', at: 2, toolCallId: 't1', status: 'ok', durationMs: 12 });
  gates.emit({ type: 'agent/delta', at: 3, channel: 'text', delta: 'Tally is' });

  const row = service.routing('dm-sigil')?.active[0];
  expect(row?.steps.map((step) => step.kind)).toEqual(['starting', 'tool', 'writing']);
  expect(row?.steps[1]).toMatchObject({ status: 'ok', durationMs: 12 });
  expect(row?.partial).toBe('Tally is');
});

it('pushes a partial answer no more than once every 150 ms', async () => {
  // Move the injected clock forward by 0, 100 and 200 ms while three deltas
  // arrive; collect the routing events and expect two, not three.
});

it('reads a handoff state from the delivery it created', async () => {
  // Start a turn, call busSend to a bot outside the room, and expect the row's
  // handoff to read 'asked'; resolve the peer's turn and expect 'done'.
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -w @morse/system -- src/bot/service.spec.ts`
Expected: FAIL — `steps` is undefined on the routing row; `partial` never arrives.

- [ ] **Step 3: Implement**

Replace the `activities` map with a `BotTurnTracker` (constructed with the service clock). `pump` calls `start` before announcing, and `runDelivery`'s settle calls `take`. `reportActivity` applies `stepForEvent`: a step appends, a tool update closes the step, `clear` is ignored (the row goes when the delivery settles). A text delta appends to `partial` and pushes only when `PARTIAL_PUSH_MS` has passed since that bot's last push, recording the push time per username; the message itself still comes from `agent/message`. `routing()` builds each active row from the tracker (falling back to a one-step starting row when a delivery was re-queued and has no record) and fills `handoffs`: each recorded handoff gains its `state` from the delivery row with that `deliveryId` (`queued → asked`, `running → working`, `done → done`, `failed|dropped|cancelled → failed`) and its `activity` from the target's tracker when its turn is in that conversation. Delete the now-unused activity map, `sameActivity`, `activityForEvent` and its labels; keep `describeTool` and add `startingStep(at): BotActivity`.

- [ ] **Step 4: Run the tests**

Run: `npm run test -w @morse/system` and `npm run check-types -w @morse/system`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/bot
git commit -m "feat(system): publish a bot's steps and answer while it works"
```

---

### Task 5: The trace store

**Files:**
- Create: `packages/system/src/bot/traces.ts`
- Test: `packages/system/src/bot/traces.spec.ts`

**Interfaces:**
- Produces: `TRACE_TTL_MS = 604_800_000`, `TRACE_LIMIT = 100`; `class BotTraceStore { constructor(dir: string); all(conversationId: string): BotTurnTrace[]; add(trace: BotTurnTrace): void; forget(conversationId: string): void; prune(now: number): void }`.
- Consumes: `BotTurnTrace` (Task 1), `writeJsonAtomic` from `store.ts`.

- [ ] **Step 1: Write the failing tests**

Real temp directories, as `deliveries.spec.ts` does.

```ts
it('keeps a conversation's turns newest last and replaces a repeated id', () => {
  const store = new BotTraceStore(dir);
  store.add(trace({ id: 'a', endedAt: 1 }));
  store.add(trace({ id: 'b', endedAt: 2 }));
  store.add(trace({ id: 'b', endedAt: 3 }));
  expect(store.all('dm-sigil').map((row) => row.endedAt)).toEqual([1, 3]);
});

it('drops what is old and keeps the newest hundred', () => {
  // 120 traces, then prune(now) with one older than TRACE_TTL_MS.
});

it('refuses an id that is not path-safe', () => {
  expect(() => store.all('../etc')).toThrow(/usable conversation id/);
});

it('throws naming the file when one is malformed', () => {
  writeFileSync(join(dir, 'dm-sigil.json'), '{"nope":');
  expect(() => store.all('dm-sigil')).toThrow(/dm-sigil\.json/);
});

it('leaves every other room readable when one file is bad', () => {
  store.add({ ...trace({ id: 'a', endedAt: 1 }), conversationId: 'dm-loom' });
  writeFileSync(join(dir, 'dm-sigil.json'), '{"nope":');
  expect(() => store.all('dm-sigil')).toThrow();
  expect(store.all('dm-loom')).toHaveLength(1);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -w @morse/system -- src/bot/traces.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

One JSON file per conversation at `<dir>/<conversationId>.json`, written through `writeJsonAtomic`. A missing file reads as `[]`; a malformed one throws with its path. `add` replaces a trace with the same id, otherwise appends, then sorts by `endedAt`. `prune(now)` drops traces whose `endedAt` is older than `now - TRACE_TTL_MS` and keeps the newest `TRACE_LIMIT`. `forget` unlinks the file and tolerates its absence. Validate the id with the same rule `deliveries.ts` uses.

- [ ] **Step 4: Run the tests**

Run: `npm run test -w @morse/system -- src/bot/traces.spec.ts` and `npm run check-types -w @morse/system`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/bot/traces.ts packages/system/src/bot/traces.spec.ts
git commit -m "feat(system): keep each room's finished turns in a bounded store"
```

---

### Task 6: The service writes traces and pages carry them

**Files:**
- Modify: `packages/system/src/bot/service.ts` (settle path, `open`, `history`, `clear`, `deleteGroup`, `deleteBot`, `newDiscussion`, prune pass)
- Modify: `packages/system/src/bot/transcripts.ts` (`TranscriptPage.traces`)
- Modify: `packages/system/src/bot/service.spec.ts`
- Modify: `packages/system/src/host/session-controller.ts` (`bot/transcript` payload)
- Test: `packages/system/src/bot/service.spec.ts`, `packages/system/src/host/session-controller.spec.ts`

**Interfaces:**
- Consumes: `BotTraceStore` (Task 5), `BotTurnTracker` (Task 3).
- Produces: `TranscriptPage { entries, hasMore, traces: BotTurnTrace[] }`; `BotEvent`'s transcript variant gains `traces?: BotTurnTrace[]`; `bot/open` and `bot/history` payloads carry `traces`.

- [ ] **Step 1: Write the failing tests**

```ts
it('records a finished turn and pushes it without reloading', async () => {
  const { service, events, gates } = harness();
  await service.send('dm-sigil', 'name a bot', {});
  await gates.started();
  gates.emit({ type: 'agent/tool-start', at: 1, toolCallId: 't1', name: 'read', title: 'brief.md' });
  gates.resolve({ reply: 'Tally — counts every coin', reason: 'settled' });
  await settle();

  const pushed = events.filter((event) => event.type === 'transcript').at(-1);
  expect(pushed?.traces?.[0]).toMatchObject({ conversationId: 'dm-sigil', username: 'sigil', status: 'done' });
  expect(service.open('dm-sigil').traces[0]?.steps.some((step) => step.kind === 'tool')).toBe(true);
});

it('forgets a room's traces with its transcript', async () => {
  // clear the room, then expect open().traces to be empty.
});

it('records a failed turn with its failure status', async () => {
  // gates.resolve({ reply: '', reason: 'error' }); expect status 'failed'.
});

it('writes no trace when a shutdown hands the delivery back', async () => {
  // hold a turn, dispose(), reopen a service on the same root; expect the room's
  // traces to be empty and the delivery to run again.
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -w @morse/system -- src/bot/service.spec.ts`
Expected: FAIL — `open(...).traces` is undefined; no transcript event carries a trace.

- [ ] **Step 3: Implement**

On settle — after the delivery's status is written and after a graceful shutdown has had its chance to requeue — build the trace from the tracker snapshot: `id` is the delivery id, `name` is the bot's display name now, `startedAt`/`endedAt` from the record and the clock, `status` from the delivery, steps and handoffs as recorded. Write it, then emit a `transcript` event for that conversation with `entries: []`, `replace: false`, `traces: [trace]`. `open`/`history` return the traces whose `endedAt` is at or after the page's oldest entry's `at`, oldest first (for `history`, also before the requested `before` entry's `at`). `clear`, `deleteGroup`, and a deleted bot's DM/threads forget their traces; `newDiscussion` keeps them (the room's history stays). Prune traces in the same opportunistic pass as `maybePruneDeliveries`. The controller copies `page.traces` into the payload.

- [ ] **Step 4: Run the tests**

Run: `npm run test -w @morse/system` and `npm run test -w @morse/server` and both `check-types`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/bot packages/system/src/host packages/server/src
git commit -m "feat(system): keep a finished turn and send it to the open room"
```

---

### Task 7: Threads know where they came from

**Files:**
- Modify: `packages/system/src/bot/types.ts` (`ConversationRecord.parentId?`, `askedBy?`)
- Modify: `packages/system/src/bot/service.ts` (`createThread`, `busSend`, `turn` return, `runDelivery`, `contextFor`)
- Test: `packages/system/src/bot/service.spec.ts`

**Interfaces:**
- Consumes: `deliveries`, `append`, `pump`, `note`.
- Produces: `createThread(sender: BotRecord, target: BotRecord, parentId: string): ConversationRecord`; `turn(...): Promise<{ status: BotDeliveryStatus; reply?: string }>`; a private `handBack(conversation, bot, delivery, answer, status)`.

- [ ] **Step 1: Write the failing tests**

```ts
it('hands a peer's answer back to the room the asker was in', async () => {
  // Sigil (dm-sigil) asks Loom; Loom answers in the thread.
  // Expect: a line in dm-sigil authored by loom, a queued reply delivery to
  // sigil there, and sigil's lane waking with that line in its prompt.
});

it('does not wake a bot that answered in its own thread', async () => {
  // The thread's askedBy bot answers there; the line appears in the parent room
  // and no delivery is queued.
});

it('leaves a group answer alone', async () => {
  // A bot asked in a group answers there: no forward, no wake.
});

it('answers a person in a thread in place', async () => {
  // The person sends in the thread; the bot answers there. Expect one line and
  // no reply delivery in the parent.
});

it('notes a failed thread answer in the room that would have received it', async () => {
  // Loom's turn fails; expect a system note in dm-sigil naming Loom and the reason.
});

it('does not forward when the thread has no parent', async () => {
  // A thread written before this change (no parentId) answers in place.
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -w @morse/system -- src/bot/service.spec.ts`
Expected: FAIL — no line is written in the DM; no reply delivery is queued.

- [ ] **Step 3: Implement**

`createThread` records `parentId` and `askedBy` (the sender's username); `busSend` passes the caller's current conversation id. `turn` returns the settled status and the reply text (`outcome.reply`). In `runDelivery`'s settle path, call `handBack`: when the delivery came from a bot, the room is a thread with a `parentId` that exists and differs from the room, append `"<peer name>, in a private thread with @<asker>: <answer>"` in the parent, and — unless the answering bot is the parent thread's `askedBy` — queue a `reply` delivery to `askedBy` in that parent (`depth + 1`, same `rootId`, `from` the answering bot) and pump it. A failed or cancelled turn writes the room's note instead, naming the bot and the reason. A non-thread room, a person's line, or a missing parent does nothing. In `contextFor`, a `reply` delivery from a bot gets a lead line saying a teammate answered the ask and it should answer the person, not send it back. Old threads have neither field and are left alone.

- [ ] **Step 4: Run the tests**

Run: `npm run test -w @morse/system` and `npm run check-types -w @morse/system`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/bot
git commit -m "feat(system): bring a delegated answer back to the person's room"
```

---

### Task 8: The sidebar hears about a new thread, and the bot can ask for an invite

**Files:**
- Modify: `packages/system/src/bot/service.ts` (emit `{ type: 'roster' }` after a thread is saved)
- Modify: `packages/system/src/bot/instruction.ts` (one sentence)
- Test: `packages/system/src/bot/service.spec.ts`, `packages/system/src/bot/instruction.spec.ts`

**Interfaces:**
- Produces: a `roster` event on thread creation; the instruction text gains one sentence.

- [ ] **Step 1: Write the failing tests**

```ts
it('announces a thread the moment a bot opens one', async () => {
  // subscribe to service events; busSend to a bot outside the room;
  // expect a { type: 'roster' } event and the thread in service.roster().
});

it('teaches the invite in words', () => {
  expect(BOT_BUS_INSTRUCTION).toContain('ask the person to add it here');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -w @morse/system -- src/bot/service.spec.ts src/bot/instruction.spec.ts`
Expected: FAIL — no roster event; the sentence is absent.

- [ ] **Step 3: Implement**

After the `saveRegistry()` that follows a new thread, emit the roster event (not before: the file must exist when a client asks). Append one sentence to `BOT_BUS_INSTRUCTION`: a bot that is not in this room can still be asked in a private thread, or the person can be asked to add it here when the work belongs in this room. Do not touch the persona files or either layout writer.

- [ ] **Step 4: Run the tests**

Run: `npm run test -w @morse/system` and `npm run check-types -w @morse/system`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/bot
git commit -m "feat(system): announce a new thread and teach the invite"
```

---

### Task 9: The client keeps the record and draws finished turns

**Files:**
- Modify: `packages/ui-angular/src/app/host/bot-state.ts` (traces per conversation)
- Modify: `packages/ui-angular/src/app/features/bot-chat/bot-chat.ts` / `bot-chat.html` (timeline merge and the collapsed line)
- Test: `packages/ui-angular/src/app/host/bot-state.spec.ts`, `packages/ui-angular/src/app/features/bot-chat/bot-chat.spec.ts`

**Interfaces:**
- Consumes: `BotTranscriptMessage['payload'].traces`, `BotTurnTrace`.
- Produces: `BotState.traces()` signal and `tracesFor(conversationId): BotTurnTrace[]`; a `timeline()` computed in the chat returning entries and traces in `at`/`endedAt` order.

- [ ] **Step 1: Write the failing tests**

```ts
it('replaces a page's traces and appends a settled one in order', () => {
  // onTranscript with replace true and two traces, then one more appended;
  // expect tracesFor() to be oldest first, and a repeated id to appear once.
});

it('draws a finished turn above its answer', () => {
  // fixture: a trace endedAt 100 and a bot entry at 120; expect the collapsed
  // line "Sigil · 0s · 2 steps" before the answer's text.
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -w @morse/ui-angular -- src/app/host/bot-state.spec.ts src/app/features/bot-chat/bot-chat.spec.ts`
Expected: FAIL — `tracesFor` is undefined; the line is not drawn.

- [ ] **Step 3: Implement**

`onTranscript` keeps `transcript.traces` per conversation: `replace` resets, `prepend` puts older ones in front, otherwise merge by id and sort by `endedAt`. `hasOlder`/clearing behaviour is unchanged. The chat builds one timeline from entries and traces sorted by the entry's `at` and the trace's `endedAt`, and the template renders a trace as a button-shaped line — `name · <duration> · <n> steps` plus `· asked @loom` when it has a handoff — that expands to the step list with each step's label, outcome, error text and handoff links. Use the trace's stored `name`, never the roster.

- [ ] **Step 4: Run the tests**

Run: `npm run test -w @morse/ui-angular` and `npm run check-types -w @morse/ui-angular`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/host packages/ui-angular/src/app/features/bot-chat
git commit -m "feat(ui): show a finished bot turn's steps above its answer"
```

---

### Task 10: The live row

**Files:**
- Create: `packages/ui-angular/src/app/features/bot-chat/reveal.ts` (paced reveal and elapsed label)
- Test: `packages/ui-angular/src/app/features/bot-chat/reveal.spec.ts`
- Modify: `packages/ui-angular/src/app/features/bot-chat/bot-chat.ts` / `bot-chat.html`
- Test: `packages/ui-angular/src/app/features/bot-chat/bot-chat.spec.ts`

**Interfaces:**
- Produces: `revealLength(shown: number, text: string, stepChars?: number, share?: number): number` (defaults `stepChars = 24`, `share = 0.25`); `elapsedLabel(ms: number): string | undefined` (`undefined` under 5 000 ms; `38s`; `2m 05s`); `rowIsQuiet(now: number, lastStepAt: number, runningTool: boolean): boolean`.
- Consumes: `BotRoutingActive.steps`, `.startedAt`, `.partial`, `.handoffs`.

- [ ] **Step 1: Write the failing tests**

```ts
it('never runs past the text and stops on a word', () => {
  const text = 'Tally is the one that survives being said out loud';
  const next = revealLength(0, text);
  expect(next).toBeLessThanOrEqual(text.length);
  expect(next === text.length || text[next - 1] === ' ').toBe(true);
});

it('keeps moving when a burst arrives at once', () => {
  expect(revealLength(0, 'a '.repeat(500))).toBeGreaterThan(24);
});

it('hides a young timer and counts in minutes after one', () => {
  expect(elapsedLabel(4_900)).toBeUndefined();
  expect(elapsedLabel(38_000)).toBe('38s');
  expect(elapsedLabel(125_000)).toBe('2m 05s');
});

it('calls a row quiet after twenty seconds, but never with a tool running', () => {
  expect(rowIsQuiet(20_000, 1_000, false)).toBe(false);
  expect(rowIsQuiet(21_000, 1_000, false)).toBe(true);
  expect(rowIsQuiet(120_000, 1_000, true)).toBe(false);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -w @morse/ui-angular -- src/app/features/bot-chat/reveal.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`revealLength` advances by `stepChars` plus `share` of what is still unread, capped at the text length, then steps back to the last space inside the advance (never below the current length). `elapsedLabel` formats from the given milliseconds. `rowIsQuiet` is true when 20 000 ms have passed since the newest step and no tool step is still `running`. In the chat, extend `acting()` with `steps`, `partial`, `handoffs`, `startedAt`; keep a signal of how much of each row's `partial` is revealed and a 50 ms interval that advances it while any row has text; clear the entry when its row disappears. The template draws: the current label, the elapsed time when defined, a chevron opening the newest three steps (each with its outcome; a failed step opens its error), the revealed `partial` as muted pre-wrap text, and one chip per handoff — `asked @loom`, `loom is working`, `loom answered`, `loom failed` — that opens its conversation. A quiet row drops its shimmer and says it is waiting on the model. The Stop button and the ring keep their current behaviour. Keep `role="status"` and give it one sentence naming the bot and what it is doing.

- [ ] **Step 4: Run the tests**

Run: `npm run test -w @morse/ui-angular` and `npm run check-types -w @morse/ui-angular`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/features/bot-chat
git commit -m "feat(ui): draw a working bot's steps, words and handoffs"
```

---

### Task 11: Documentation and the whole suite

**Files:**
- Modify: `docs/STATUS.md` (Bot mode: live steps, the record, the answer path)
- Modify: `docs/ARCHITECTURE.md` (Bot mode: the turn record and the trace store)
- Modify: `docs/DATA-COMPATIBILITY.md` (the `bot/traces` directory; thread `parentId`/`askedBy`)
- Test: none (a check step instead)

**Interfaces:**
- Produces: no code.

- [ ] **Step 1: Write the documentation**

`STATUS.md`: a bot room shows each working bot's steps, its answer as it is written, and who it asked; a finished turn stays as one line and is kept for seven days; a delegated answer comes back to the room the person spoke in. `ARCHITECTURE.md`: the per-turn record lives in memory while the lane runs and becomes a trace on settle; traces are never read by a bot. `DATA-COMPATIBILITY.md`: `<dataDir>/bot/traces/<conversation>.json`, bounded to 100 turns and 7 days; a thread's `parentId`/`askedBy` are optional and absent on threads written before this change.

- [ ] **Step 2: Check the copy rules**

Run: `grep -rniE "openbot|mausbot|openmaus" docs packages --include=*.md --include=*.ts | grep -v node_modules`
Expected: no output.

- [ ] **Step 3: Run the whole suite**

Run: `npm run test:fast`
Expected: PASS — protocol, engine-config, system, ui-runtime, server and ui-angular all green.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: describe the live row, the turn record and the answer path"
```
