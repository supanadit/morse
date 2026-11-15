# Message editing, branching and session icons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an edit rewrite OpenCode in place instead of spawning a session, add "Branch from here" for a finished answer on both engines, fix the transcript-to-engine prompt mapping, and give forks and subagents their own session icons.

**Architecture:** The agent port grows `rewrite(entryId)` (each engine's own edit: OpenCode stages and commits a revert, Pi forks), `clone()` (branch at the tip) and `userMessages()` (every user message, replacing the text-filtered fork list). The host keeps orchestrating: it truncates and re-homes the transcript, and asks the registry to fork, rewrite or clone. The frontend gains one wire message and reads the existing `forkMessage` capability.

**Tech Stack:** TypeScript, Node ESM, Vitest, Angular 21 (standalone components, signals), npm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-15-message-editing-and-branching-design.md`

## Global Constraints

- `@morse/system` must never name an engine or speak an engine's transport; `npm run lint` runs `scripts/check-agent-boundary.mjs`.
- No new `HostCapabilities` field: `editMessage` and `forkMessage` already exist and both engines will honour them.
- Copy stays clipboard-only on both roles; do not add a copy/duplicate feature.
- The branch affordance appears only in the transcript's assistant action group, labelled "Branch from here".
- Engine ids are never sent to a frontend; the wire carries transcript item ids only.
- Every task ends with its own commit; commit messages follow the repo's `feat:` / `fix:` / `docs:` style.
- Rebuild a workspace's `dist` before a dependent package's tests can see new types: `npm run build -w <pkg>`.
- Comments state what the code does and why, in the voice of the file around them.

## Review Focus

- A rewrite requested while the agent is streaming must be refused before anything is staged or forked; the transcript and the engine stay untouched.
- A prompt with no text (image-only or pin-only) must resolve to its own engine message, not its neighbour, for edit, fork and branch.
- Branching from the conversation's **last** answer must clone, not fail on "no next user prompt".
- Branching while older history is unloaded must cut at the oldest loaded user row the reader can see.
- A cancelled fork (Pi answers `cancelled: true`) must leave the transcript where it was, create no row, and seed no composer.
- The branch button must be absent while streaming, on a mid-turn assistant row, and on a turn that ends in a tool call.

---

### Task 1: Port, OpenCode and Pi adapters

**Files:**
- Modify: `packages/agent/src/ports.ts:40-99`
- Modify: `packages/agent/src/session.ts:50-70`
- Modify: `packages/agent/src/domain/agent/interaction.ts:10-16`
- Modify: `packages/agent/src/domain/index.ts` (whatever re-exports `AgentForkMessage`)
- Modify: `packages/integration-opencode/src/opencode-agent.ts:330-350, 472-500`
- Modify: `packages/integration-opencode/src/internal/message-mapping.ts:150-170`
- Modify: `packages/integration-opencode/src/opencode-engine.ts:343-360`
- Modify: `packages/integration-pi/src/pi-rpc-agent.ts:263-300`
- Modify: `packages/integration-pi/src/internal/rpc/commands.ts:75-85` and its command union
- Modify: `packages/integration-pi/src/event-mapping.ts` (add `userMessagesOf`)
- Test: `packages/integration-opencode/src/opencode-agent.spec.ts:690-730`
- Test: `packages/integration-pi/src/event-mapping.spec.ts`
- Test: `packages/integration-pi/src/pi-rpc-agent.spec.ts:455-560` (fake-pi pattern)

**Interfaces:**
- Produces: `interface AgentUserMessage { entryId: string; text: string }` (renamed from `AgentForkMessage`).
- Produces: `userMessages(): Promise<AgentUserMessage[]>`, `rewrite(entryId: string): Promise<{ text: string; cancelled: boolean }>`, `clone(): Promise<{ cancelled: boolean }>` on `AgentGateway` and on the abstract `Session`.

- [ ] **Step 1: Write the failing OpenCode tests**

In `opencode-agent.spec.ts`, rename the existing "lists forkable prompts" test to `it('lists every user message, including one with no text')` and make its fixture include an empty-text user message:

```ts
const messages: ApiMessage[] = [
  { id: 'msg_4', type: 'user', time: { created: 4 }, text: '' },
  { id: 'msg_3', type: 'user', time: { created: 3 }, text: 'third' },
  { id: 'msg_2', type: 'assistant', time: { created: 2 }, content: [] },
  { id: 'msg_1', type: 'user', time: { created: 1 }, text: 'first' },
];
// expect(await agent.userMessages()).toEqual([
//   { entryId: 'msg_1', text: 'first' },
//   { entryId: 'msg_3', text: 'third' },
//   { entryId: 'msg_4', text: '' },
// ]);
```

Add two tests beside the existing fork test:

```ts
it('rewrites in place: stages and commits a revert without forking', async () => {
  const { agent, api, stream } = await harness();
  const rewritten = await agent.rewrite('msg_1');
  expect(rewritten).toEqual({ text: 'the dropped prompt', cancelled: false });
  expect(api.calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual([
    '/session/ses_1/revert/stage',
    '/session/ses_1/revert/commit',
  ]);
  expect(api.calls.find((call) => call.path.endsWith('/revert/stage'))?.body).toEqual({
    messageID: 'msg_1',
  });
  // The session did not move, so the stream subscription did not either.
  expect((await agent.state()).sessionId).toBe('ses_1');
  expect(stream.subscriptions.map((entry) => entry.sessionID)).toEqual(['ses_1']);
  await agent.dispose();
});

it('clones the full conversation onto a new session when there is no boundary', async () => {
  const { agent, api, stream } = await harness();
  const cloned = await agent.clone();
  expect(cloned).toEqual({ cancelled: false });
  expect(api.calls.find((call) => call.path.endsWith('/fork'))?.body).toBeUndefined();
  expect((await agent.state()).sessionId).toBe('ses_2');
  expect(stream.subscriptions.map((entry) => entry.sessionID)).toEqual(['ses_2']);
  await agent.dispose();
});
```

The fake handler already answers `POST …/fork` with `ses_2`; make sure it also answers the two revert calls with `undefined` (the `defaultHandler` fallthrough does).

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -w @morse/integration-opencode -- src/opencode-agent.spec.ts`
Expected: FAIL — `agent.userMessages is not a function`, `agent.rewrite is not a function`, `agent.clone is not a function`.

- [ ] **Step 3: Rename the port shapes**

In `packages/agent/src/domain/agent/interaction.ts` rename `AgentForkMessage` to:

```ts
/** One user message a fork can target, as the engine names it. */
export interface AgentUserMessage {
  entryId: string;
  text: string;
}
```

Update every export and import of the old name (`domain/index.ts`, both adapters, `ports.ts`, `session.ts`, the fakes in `packages/system/src/**/*.spec.ts`). Keep the wire and transcript types untouched.

- [ ] **Step 4: Extend the port and the abstract session**

In `ports.ts`, replace `forkMessages()` with three members:

```ts
/** Every user message the session holds, in conversation order. */
userMessages(): Promise<AgentUserMessage[]>;
/**
 * Rewrites the conversation the way this engine can: in place from `entryId`
 * forward (same session id) or by branching before it (new session id). Returns
 * the text of the message that was dropped.
 */
rewrite(entryId: string): Promise<{ text: string; cancelled: boolean }>;
/** Branches at the tip: a new session copying this conversation through the last message. */
clone(): Promise<{ cancelled: boolean }>;
```

Mirror all three in the abstract `Session` class in `session.ts` with `abstract`.

- [ ] **Step 5: Implement them in the OpenCode adapter**

In `message-mapping.ts` rename `toForkMessages` to `toUserMessages` (and its doc comment); it already keeps every `type === 'user'` message. In `opencode-agent.ts`:

```ts
async userMessages(): Promise<AgentUserMessage[]> {
  // same paged read as today's forkMessages, then toUserMessages(messages)
}

async rewrite(entryId: string): Promise<{ text: string; cancelled: boolean }> {
  const text = await this.promptText(entryId);
  const session = encodeURIComponent(this.engineId);
  await this.api.post(`/session/${session}/revert/stage`, { messageID: entryId });
  try {
    await this.api.post(`/session/${session}/revert/commit`);
  } catch (error: unknown) {
    // A stage restores the files at once; a failed commit must hand them back
    // rather than leave a half-applied boundary the user never asked for.
    await this.api.delete(`/session/${session}/revert`).catch(() => undefined);
    throw error;
  }
  await this.refreshState();
  return { text, cancelled: false };
}

async clone(): Promise<{ cancelled: boolean }> {
  const forked = await this.api.post<ApiSessionInfo>(
    `/session/${encodeURIComponent(this.engineId)}/fork`,
  );
  this.adoptSession(forked);
  return { cancelled: false };
}
```

Extract the post-fork adoption from `fork()` into `private adoptSession(forked: ApiSessionInfo | undefined): void` — the validation, `engineId`, `mergeState`, `unsubscribe`, `attach` — and have both `fork()` and `clone()` call it. `fork()` keeps its existing behaviour and body field `{ before: entryId }`.

In `opencode-engine.ts` (the draft gateway), replace `forkMessages()` with `userMessages()` and add `rewrite()` and `clone()`, each rejecting with `UnsupportedByHostError('A draft has no conversation to fork.')`.

- [ ] **Step 6: Run the OpenCode tests**

Run: `npm run test -w @morse/integration-opencode -- src/opencode-agent.spec.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing Pi tests**

In `event-mapping.spec.ts` add a pure test (reuse the entry fixtures that file already defines):

```ts
it('lists every user message on the active path, including one with no text', () => {
  const entries = [
    { id: 'e1', type: 'message', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
    { id: 'e2', type: 'message', parentId: 'e1', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
    { id: 'e3', type: 'message', parentId: 'e2', message: { role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] } },
  ];
  expect(userMessagesOf(entries)).toEqual([
    { entryId: 'e1', text: 'first' },
    { entryId: 'e3', text: '' },
  ]);
});
```

In `pi-rpc-agent.spec.ts`, following the `fakePi` pattern already at line 455, add a small fake that answers `get_state` (session file/id, id `s1`), `get_entries` (the three entries above) and `clone` (answers `{}` then reports a new session id `s2` on the next `get_state`), then:

```ts
it('reads user messages from the active path', async () => { /* expect agent.userMessages() to equal the two above */ });
it('clones onto the new session pi reports', async () => {
  const result = await agent.clone();
  expect(result).toEqual({ cancelled: false });
  const sent = /* the fake's recorded commands */;
  expect(sent.some((command) => command.type === 'clone')).toBe(true);
  expect((await agent.state()).sessionId).toBe('s2');
});
it('rewrites by forking, because pi has no edit primitive', async () => {
  const result = await agent.rewrite('e1');
  expect(result).toEqual({ text: 'first', cancelled: false });
  // the fake records a `fork` command carrying entryId 'e1'
});
```

- [ ] **Step 8: Implement them in the Pi adapter**

`commands.ts`: add

```ts
export interface RpcCloneCommand {
  type: 'clone';
}
```

and add it to the command union file alongside `RpcForkCommand`.

`event-mapping.ts`: export

```ts
/** Every user message on the given entries, in order, with its engine entry id. */
export function userMessagesOf(entries: readonly unknown[]): AgentUserMessage[];
```

Implement it by filtering `type === 'message' && message.role === 'user'` and reusing the same text extraction `toEntryHistory` uses for user rows (empty string when there is no text part).

`pi-rpc-agent.ts`:

```ts
async userMessages(): Promise<AgentUserMessage[]> {
  const data = await this.client.request<{ entries?: unknown[] }>({ type: 'get_entries' });
  return userMessagesOf(activePathEntries(Array.isArray(data?.entries) ? data.entries : []));
}

async rewrite(entryId: string): Promise<{ text: string; cancelled: boolean }> {
  // pi has no edit primitive: an edit is a fork, and the port says so.
  return this.fork(entryId);
}

async clone(): Promise<{ cancelled: boolean }> {
  const data = await this.client.request<{ cancelled?: boolean }>({ type: 'clone' });
  this.historyCache = undefined;
  await this.refreshState();
  return { cancelled: data?.cancelled === true };
}
```

- [ ] **Step 9: Run the Pi tests and the type check**

Run: `npm run test -w @morse/integration-pi -- src/event-mapping.spec.ts src/pi-rpc-agent.spec.ts`
Expected: PASS.
Run: `npm run build -w @morse/agent && npm run check-types --workspaces --if-present`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/agent packages/integration-opencode packages/integration-pi packages/system/src
git commit -m "feat(agent): add rewrite, clone and the total user-message list to the port"
```

---

### Task 2: Router and registry

**Files:**
- Modify: `packages/system/src/session/agent-router.ts:566-610`
- Modify: `packages/system/src/session/service.ts:281-331`
- Test: `packages/system/src/session/agent-router.spec.ts:105-130`
- Test: `packages/system/src/session/service.spec.ts:40-60`

**Interfaces:**
- Consumes: `userMessages()`, `rewrite(entryId)`, `clone()` from Task 1.
- Produces: `RoutedGateway.rewrite(entryId)`, `RoutedGateway.clone()`, `RoutedGateway.userMessages()`.
- Produces: `SessionRegistry.rewriteActive(entryId: string, sessionKey?: string): Promise<ForkedSession>`, `SessionRegistry.cloneActive(sessionKey?: string): Promise<ForkedSession>`.

- [ ] **Step 1: Write the failing registry tests**

In `service.spec.ts`, extend the fake gateway with `rewrite`, `clone` and `userMessages`, then add:

```ts
it('keeps the key when the engine rewrote in place', async () => {
  const gateway = fakeGateway({ sessionId: 'same', rewriteText: 'old prompt' });
  const registry = makeRegistry(gateway);
  const result = await registry.rewriteActive('entry-1');
  expect(result.key).toBe(result.previousKey);
  expect(result.text).toBe('old prompt');
  expect(result.cancelled).toBe(false);
});

it('re-keys when the engine cloned onto a new session', async () => {
  const gateway = fakeGateway({ sessionId: 'next-session' });
  const registry = makeRegistry(gateway);
  const result = await registry.cloneActive();
  expect(result.previousKey).not.toBe(result.key);
  expect(result.key).toBe('next-session');
});
```

Use the file's existing helpers for building a registry and a fake gateway; only the fixture names above are new.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -w @morse/system -- src/session/service.spec.ts`
Expected: FAIL — `registry.rewriteActive is not a function`.

- [ ] **Step 3: Implement the router passthroughs**

In `agent-router.ts`, beside `fork`:

```ts
async rewrite(entryId: string): Promise<{ text: string; cancelled: boolean }> {
  const result = await this.options.inner.rewrite(entryId);
  if (!result.cancelled) {
    // A rewrite may or may not move the session; absorbing the state is what
    // re-derives the id when it does.
    await this.state();
  }
  return result;
}

async clone(): Promise<{ cancelled: boolean }> {
  const result = await this.options.inner.clone();
  if (!result.cancelled) {
    await this.state();
  }
  return result;
}

userMessages() {
  return this.options.inner.userMessages();
}
```

- [ ] **Step 4: Implement the registry operations**

Turn `forkActive`'s body into:

```ts
private async branchActive(
  operation: 'fork' | 'rewrite' | 'clone',
  entryId: string | undefined,
  sessionKey?: string,
): Promise<ForkedSession> { /* today's body, with the call swapped */ }
```

The gateway call becomes:

```ts
const result =
  operation === 'fork'
    ? await hot.gateway.fork(entryId ?? '')
    : operation === 'rewrite'
      ? await hot.gateway.rewrite(entryId ?? '')
      : await hot.gateway.clone();
const text = 'text' in result ? result.text : '';
```

Keep the existing cancelled/key/recency/adoption logic and return `text` in every branch. Add:

```ts
forkActive(entryId: string, sessionKey?: string) { return this.branchActive('fork', entryId, sessionKey); }
rewriteActive(entryId: string, sessionKey?: string) { return this.branchActive('rewrite', entryId, sessionKey); }
cloneActive(sessionKey?: string) { return this.branchActive('clone', undefined, sessionKey); }
```

- [ ] **Step 5: Run the tests**

Run: `npm run test -w @morse/system -- src/session/service.spec.ts src/session/agent-router.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/system/src/session
git commit -m "feat(system): route rewrite and clone through the session registry"
```

---

### Task 3: Host edit rewrites in place, and the mapping becomes total

**Files:**
- Modify: `packages/system/src/host/session-controller.ts:1580-1713, 2663-2686`
- Test: `packages/system/src/host/session-controller.spec.ts:60-140, 1350-1420`

**Interfaces:**
- Consumes: `registry.rewriteActive`, `gateway.userMessages()`.
- Produces: `entryIdForEdit(items, itemId, userMessages)` — the host's only row-to-entry mapping.

- [ ] **Step 1: Write the failing host tests**

Update the fake gateway option name `forkMessages` to `userMessages` and add:

```ts
it('edits in place on an engine that rewrites: no new key, no new row', async () => {
  // gateway.rewrite returns { text: 'old', cancelled: false } and leaves sessionId alone
  // send chat/edit for the first user row
  // expect: one chat/prompt, transcripts not moved, no session/list entry added
});

it('edits through the key the engine was given when the prompt has no text', async () => {
  // transcript: user u1 with only an image, user u2 with text
  // userMessages(): [{ entryId: 'entry-1', text: '' }, { entryId: 'entry-2', text: 'second' }]
  // edit u1 -> expect rewrite called with 'entry-1'
});

it('maps the oldest loaded row when older history is still unloaded', async () => {
  // transcript holds only u3 and u4 (two user rows); userMessages() returns four
  // edit u3 -> expect rewrite called with the third engine entry, not the first
});

it('refuses an edit while the agent is streaming, before the engine is touched', async () => {
  // streaming true; send chat/edit; expect one warn notice, rewrite never called,
  // and no chat/prompt
});
```

Keep the existing fork tests and rename only the fake's `forkMessages` field; the fork path is unchanged.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -w @morse/system -- src/host/session-controller.spec.ts`
Expected: FAIL — the edit case forks (new key) and the no-text case sends the wrong entry.

- [ ] **Step 3: Switch edit to `rewriteActive`**

In `forkBefore`, replace the registry call:

```ts
const forked = await this.guard(() =>
  action === 'edit'
    ? this.options.services.registry.rewriteActive(entryId)
    : this.options.services.registry.forkActive(entryId),
);
```

Everything below it already handles a key that does not move (`transcripts.move` replaces when `from === to`). Update the `editPrompt` doc comment: it now rewrites through the engine's own edit (in place on OpenCode, a branch on Pi).

- [ ] **Step 4: Make the mapping total**

Replace `gateway.forkMessages()` with `gateway.userMessages()` and rewrite the helper:

```ts
function entryIdForEdit(
  items: TranscriptItem[],
  itemId: string,
  userMessages: AgentUserMessage[],
): string | undefined {
  const userItems = items.filter((item): item is UserTranscriptItem => item.kind === 'user');
  const index = userItems.findIndex((item) => item.id === itemId);
  if (index === -1) {
    return undefined;
  }
  // Count from the end so a partially loaded transcript still lines up: both
  // lists are total now, so the offset is exact.
  const position = userMessages.length - (userItems.length - index);
  return position >= 0 ? userMessages[position]?.entryId : undefined;
}
```

Delete the old `text || pins` predicate and update its doc comment.

- [ ] **Step 5: Run the tests**

Run: `npm run test -w @morse/system -- src/host/session-controller.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/system/src/host
git commit -m "fix(system): edit in place on engines that rewrite, and map rows to their own entry"
```

---

### Task 4: The `chat/branch` wire message and the client action

**Files:**
- Modify: `packages/protocol/src/wire/client.ts:51-70`
- Modify: `packages/protocol/src/wire.ts:46-93`
- Modify: `packages/ui-runtime/src/client.ts:30-45, 313-320`
- Test: `packages/ui-runtime/src/client.spec.ts:78-105`

**Interfaces:**
- Produces: `ChatBranchMessage { type: 'chat/branch'; payload: { itemId: string } }`.
- Produces: `MorseActions.branchMessage(itemId: string): void`.

- [ ] **Step 1: Write the failing client test**

In `client.spec.ts`, beside the fork case:

```ts
it('sends a branch as `chat/branch` with the target item id', () => {
  client.actions.branchMessage('morse-assistant-2');
  expect(transport.sent.at(-1)).toEqual({
    type: 'chat/branch',
    payload: { itemId: 'morse-assistant-2' },
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @morse/ui-runtime -- src/client.spec.ts`
Expected: FAIL — `client.actions.branchMessage is not a function`.

- [ ] **Step 3: Add the message and the action**

`wire/client.ts`, after `ChatForkMessage`:

```ts
/**
 * Branches a new session after a finished answer: the host forks before the next
 * user prompt (or clones the whole conversation at the tail), re-homes the
 * transcript through that answer and seeds nothing — the branch keeps the answer,
 * and the reader types what comes next.
 */
export interface ChatBranchMessage extends ClientMessageBase {
  type: 'chat/branch';
  payload: { itemId: string };
}
```

Add it to the `ClientToHostMessage` union, add `'chat/branch'` to `CLIENT_MESSAGE_TYPES` in `wire.ts` right after `'chat/fork'`, and in `ui-runtime/src/client.ts` add to `MorseActions`:

```ts
/** Branches after a finished answer, keeping it; nothing is sent. */
branchMessage(itemId: string): void;
```

and to `actions`: `branchMessage: (itemId) => send({ type: 'chat/branch', payload: { itemId } })`.

- [ ] **Step 4: Run the test**

Run: `npm run build -w @morse/protocol && npm run test -w @morse/ui-runtime -- src/client.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol packages/ui-runtime
git commit -m "feat(protocol): add chat/branch to the wire"
```

---

### Task 5: Host handles `chat/branch`

**Files:**
- Modify: `packages/system/src/host/session-controller.ts:440-470, 1590-1620`
- Test: `packages/system/src/host/session-controller.spec.ts` (add a `describe('HostSessionController chat/branch')` beside the chat/fork one at line 1355)

**Interfaces:**
- Consumes: `ChatBranchMessage`, `registry.cloneActive()`, `entryIdForEdit` from Tasks 3–4.
- Produces: `private branchFrom(itemId: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('branches before the next prompt, keeping the answer', async () => {
  // transcript: u1, a1, u2, a2 ; send chat/branch for a1
  // expect fork active with u2's entry id, transcript replaced with [u1, a1],
  // no composer/seed message
});

it('clones when the answer is the last one', async () => {
  // transcript: u1, a1 ; send chat/branch for a1
  // expect clone active, transcript replaced with [u1, a1] under the new key
});

it('refuses a branch while the agent is streaming', async () => {
  // streaming true; expect a warn notice and no fork/clone call
});

it('leaves everything alone when the engine cancels the clone', async () => {
  // cloneActive returns { cancelled: true, key unchanged }; expect no transcripts move,
  // no new session row, and a warn notice
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -w @morse/system -- src/host/session-controller.spec.ts`
Expected: FAIL — the message is not handled (`chat/branch` falls through) and `branchFrom` does not exist.

- [ ] **Step 3: Handle the message**

In the client-message switch, after `chat/fork`:

```ts
case 'chat/branch':
  await this.branchFrom(message.payload.itemId);
  return;
```

- [ ] **Step 4: Implement `branchFrom`**

```ts
/**
 * Branches after a finished answer without sending anything. The new branch keeps
 * that answer and everything before it: the host forks before the next user prompt
 * (both engines can), or clones the whole conversation when the answer is the last
 * one. The transcript re-homes with the same rows, so the reader sees the branch
 * point, not the old tail.
 */
private async branchFrom(itemId: string): Promise<void> {
  // Same refusals as forkBefore: a draft has nothing to branch, a missing agent or
  // session is reported, and a running turn would race the cut.
  // Then:
  // - the target must be an assistant row;
  // - find the first later item with kind 'user';
  // - nextUser exists -> const entryId = entryIdForEdit(items, nextUser.id, await gateway.userMessages())
  //                     -> registry.forkActive(entryId)
  // - otherwise -> registry.cloneActive()
  // - kept = nextUser ? items.slice(0, indexOf(nextUser)) : items.slice()
  // - activeKey = forked.key; transcripts.move(key, forked.key, kept)
  // - historyBefore = undefined; hasOlderHistory = false; loadingOlderHistory = false
  // - emitState(); void this.publishSessions()
  // Never emit composer/seed.
}
```

Use the existing notice wording style (`noticeMessage('warn', '…')`) for: no session, not ready, streaming, the row is gone, the row is not an answer, and an answer with no engine entry.

- [ ] **Step 5: Run the tests**

Run: `npm run test -w @morse/system -- src/host/session-controller.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/system/src/host
git commit -m "feat(system): branch a session after a finished answer"
```

---

### Task 6: "Branch from here" in the transcript

**Files:**
- Modify: `packages/ui-angular/src/app/features/transcript/transcript.ts:480-505`
- Modify: `packages/ui-angular/src/app/features/transcript/transcript.html:137-165`
- Modify: `packages/ui-angular/src/app/host/morse.service.ts:278-295`
- Test: `packages/ui-angular/src/app/features/transcript/transcript.spec.ts:135-220`

**Interfaces:**
- Consumes: `MorseActions.branchMessage` (Task 4).
- Produces: `MorseService.branchMessage(itemId: string): void`, `canBranch(row)` / `branch(row)` on `ChatTranscript`.

- [ ] **Step 1: Write the failing tests**

Add a `describe('ChatTranscript branching')` with the same `MorseService` stub as the editing suite (add `branchMessage` to it), and a two-turn transcript:

```ts
const items = signal<TranscriptItem[]>([
  { kind: 'user', id: 'u1', at: 1, text: 'first' },
  { kind: 'assistant', id: 'a1', at: 2, text: 'first answer', thinking: '', streaming: false },
  { kind: 'user', id: 'u2', at: 3, text: 'second' },
  { kind: 'assistant', id: 'a2', at: 4, text: 'second answer', thinking: '', streaming: false },
]);

it('offers branching on each turn\'s answer', () => { /* both a1 and a2 have [title="Branch from here"] */ });
it('does not offer it on a mid-turn assistant row', () => { /* a1 followed by a process/tool row in the same turn */ });
it('sends the branch with the answer\'s item id', () => { /* click on a2 -> branchMessage('a2') */ });
it('hides the action while streaming', () => { /* state.streaming true -> no button */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -w @morse/ui-angular -- --include='src/app/features/transcript/transcript.spec.ts'`
Expected: FAIL — no branch button.

- [ ] **Step 3: Implement the component logic**

In `transcript.ts`:

```ts
/** Keys of the assistant rows that end a turn: the answer, not a mid-turn note. */
private readonly answerKeys = computed<ReadonlySet<string>>(() => {
  const keys = new Set<string>();
  let candidate: string | undefined;
  for (const row of this.rows()) {
    if (row.kind === 'user') {
      if (candidate !== undefined) keys.add(candidate);
      candidate = undefined;
    } else if (row.kind === 'assistant') {
      candidate = row.key;
    } else if (row.kind === 'process') {
      // A tool call continues the turn, so any answer before it is not final.
      candidate = undefined;
    }
  }
  if (candidate !== undefined) keys.add(candidate);
  return keys;
});

protected canBranch(row: AssistantRow): boolean {
  return (
    this.morse.capabilities()?.forkMessage === true &&
    this.morse.state().streaming !== true &&
    this.answerKeys().has(row.key)
  );
}

protected branch(row: AssistantRow): void {
  this.morse.branchMessage(row.item.id);
}
```

Import `AssistantRow` from `@morse/ui-runtime`. Add `branchMessage` to `MorseService` beside `forkMessage`, forwarding to `this.actions.branchMessage(itemId)`.

- [ ] **Step 4: Add the button**

In the assistant `assistant-actions` block, before the copy button:

```html
@if (canBranch(row)) {
  <button type="button" class="copy-msg" title="Branch from here" (click)="branch(row)">
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path fill="currentColor" d="M4.5 1.8a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 8.4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm7-4.6a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM4.5 5.8v4.4M6.4 8h1.2a2 2 0 0 0 2-2V6" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" />
    </svg>
  </button>
}
```

The glyph matches the fork drawn on user rows; adjust the path if it reads badly at 11px, but keep `fill="currentColor"` for the nodes and the stroke for the link.

- [ ] **Step 5: Run the tests**

Run: `npm run test -w @morse/ui-angular -- --include='src/app/features/transcript/transcript.spec.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-angular/src/app/features/transcript packages/ui-angular/src/app/host/morse.service.ts
git commit -m "feat(ui): branch a session from a finished answer"
```

---

### Task 7: Session icons for originals, forks and subagents

**Files:**
- Modify: `packages/ui-runtime/src/files/tree.ts:88-127`
- Modify: `packages/ui-angular/src/app/shell/app.html:32-96`
- Modify: `packages/ui-angular/src/styles.css:276-312`
- Modify: `packages/ui-angular/src/app/features/session-nav/session-nav.ts:225-240`
- Test: `packages/ui-angular/src/app/features/session-nav/session-nav.spec.ts:414-422`

**Interfaces:**
- Produces: `IconKind` gains `'session-fork'` and `'session-bot'`; the sprite gains `#morse-session-fork` and `#morse-session-bot`.

- [ ] **Step 1: Write the failing tests**

In `session-nav.spec.ts`, extend the icon test:

```ts
it('marks an original session, a fork and a subagent with different icons', async () => {
  const { host } = await render('global', false, {
    sessions: [
      { id: 'original', title: 'Original', cwd: '/work/morse', updatedAt: 3, messageCount: 4 },
      { id: 'fork', title: 'Branch', cwd: '/work/morse', updatedAt: 2, messageCount: 2, parentId: 'original' },
      { id: 'sub', title: 'Subagent', cwd: '/work/morse', updatedAt: 1, messageCount: 1, parentId: 'original', subagent: true },
    ],
  });
  const icon = (id: string) =>
    host.querySelector(`[data-session-id="${id}"] use`)?.getAttribute('href');
  expect(icon('original')).toBe('#morse-session');
  expect(icon('fork')).toBe('#morse-session-fork');
  expect(icon('sub')).toBe('#morse-session-bot');
});
```

If rows carry no `data-session-id`, select by aria-level/label as the neighbouring tests do instead; do not add a test-only attribute.

`icon-sprite.spec.ts` already fails until `app.html` defines both symbols, because it walks `ICON_KINDS`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -w @morse/ui-angular -- --include='src/app/features/session-nav/session-nav.spec.ts' --include='src/app/shell/icon-sprite.spec.ts'`
Expected: FAIL — `session-fork` is not an `IconKind`, and the sprite has no such symbol.

- [ ] **Step 3: Add the two kinds and their shapes**

`files/tree.ts`: add `'session-fork'` and `'session-bot'` to `IconKind` and `ICON_SYMBOL`.

`app.html`, after `morse-session`:

```html
<symbol id="morse-session-fork" viewBox="0 0 16 16" fill="none" stroke="currentColor"
  stroke-width="1.2" stroke-linejoin="round">
  <circle cx="4.6" cy="3.8" r="1.8" />
  <circle cx="4.6" cy="12.2" r="1.8" />
  <circle cx="11.4" cy="6.4" r="1.8" />
  <path d="M4.6 5.6v4.8M10.4 7.8c-1.6 1.6-3.4 2-5.8 2.2" stroke-linecap="round" />
</symbol>
<symbol id="morse-session-bot" viewBox="0 0 16 16" fill="none" stroke="currentColor"
  stroke-width="1.2" stroke-linejoin="round">
  <rect x="2.6" y="5" width="10.8" height="8" rx="2" />
  <path d="M8 2.2v2.8M6.4 8.4v1.6M9.6 8.4v1.6" stroke-linecap="round" />
  <circle cx="8" cy="1.8" r="0.9" fill="currentColor" stroke="none" />
</symbol>
```

`styles.css`, beside `.file-icon.session`:

```css
.file-icon.session-fork {
  color: #6aa84f;
}
.file-icon.session-bot {
  color: #d05c5c;
}
```

- [ ] **Step 4: Pick the icon per row**

In `session-nav.ts`'s `toNode`:

```ts
// The mark says what the row is: a subagent is a delegated bot, a fork is a
// branch of another conversation, and anything else is a plain session.
icon: session.subagent === true
  ? ('session-bot' as const)
  : session.parentId !== undefined
    ? ('session-fork' as const)
    : ('session' as const),
```

- [ ] **Step 5: Run the tests**

Run: `npm run build -w @morse/ui-runtime && npm run test -w @morse/ui-angular -- --include='src/app/features/session-nav/session-nav.spec.ts' --include='src/app/shell/icon-sprite.spec.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-runtime/src/files/tree.ts packages/ui-angular/src/app/shell/app.html packages/ui-angular/src/styles.css packages/ui-angular/src/app/features/session-nav
git commit -m "feat(ui): mark forks and subagents in the session list"
```

---

### Task 8: Document the behaviour

**Files:**
- Modify: `docs/STATUS.md:118-132`

- [ ] **Step 1: Rewrite the editing/forking paragraph**

Replace the current `chat/edit` description with the engine split: edit rewrites in place on OpenCode (the Conversation and the working tree roll back to that prompt, and the discarded tail is gone once the replacement is sent) and branches on Pi (Pi has no edit primitive); `chat/fork` remains a branch of a user prompt with the composer seeded; the new `chat/branch` keeps a finished answer and branches behind it, cloning at the tail; and the session list paints originals with a purple chat, forks with a green branch, subagents with a red bot. Mention that copy stays clipboard-only and that a prompt with no text is a normal branch point.

- [ ] **Step 2: Verify the whole suite**

Run: `npm run test:fast`
Expected: PASS.
Run: `npm run lint`
Expected: PASS (agent boundary check included).

- [ ] **Step 3: Commit**

```bash
git add docs/STATUS.md
git commit -m "docs: record in-place edits, answer branching and session icons"
```
