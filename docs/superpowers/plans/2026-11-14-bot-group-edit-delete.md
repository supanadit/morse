# Bot Group Edit/Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reader edit or delete a bot group, keep each bot's session coherent when group membership changes, and make group/bot deletion remove the corresponding sessions and records.

**Architecture:** Protocol messages carry the two group mutations into `BotService`. The service owns all registry and transcript cleanup; engine-specific session removal sits behind an optional `removeSession` method on the per-bot gateway factory. The Angular group dialog becomes New/Edit, and the group menu gains Edit and confirmed Delete actions.

**Tech Stack:** TypeScript, Node.js, Vitest, Angular (signals, OnPush), the Morse wire protocol.

**Spec:** `docs/superpowers/specs/2026-11-14-bot-group-edit-delete-design.md`

## Global Constraints

- **New discussion is unchanged.** It clears session pointers only and never deletes engine session files.
- **Engine session files are deleted only by group deletion.** Removing a member from a group clears that member's Morse pointer only.
- **Deleting a bot removes everything of the bot's own**: its directory, DM conversation, DM transcript, group memberships and every session reference naming it.
- **A bot deletion keeps a group unless the bot was its last member.** A removed lead leaves the group leaderless.
- `BotService` remains engine-agnostic: no engine name may appear in `packages/system/src/bot/`.
- Keep the existing wire naming style: `bot/groupUpdate`, `bot/groupDelete`.
- Angular components stay OnPush and expose state through signals.

## Review Focus

- **Re-adding a removed member must start a new session**, not resume the one it left. Covered by Task 3's `updateGroup` round-trip test.
- **Deleting a group while a member is answering must stop the round and release the caller.** Covered by Task 4's held-round test.
- **Deleting a bot from a multi-member group must keep the group, its history and the remaining members' sessions.** Covered by Task 5.
- **Deleting a bot while it is answering in a group must stop that round.** Covered by Task 5's held-round test.
- **A failed engine session removal must not stop the group deletion.** Covered by Task 4's failure test.

---

### Task 1: Wire messages for group update and delete

**Files:**
- Modify: `packages/protocol/src/dto/bot.ts`
- Modify: `packages/protocol/src/wire/client.ts`
- Modify: `packages/protocol/src/wire.ts`
- Test: `packages/protocol/src/dto/bot.spec.ts`

**Interfaces:**
- Produces: `BotGroupUpdateInput { id: string; name: string; members: string[]; lead?: string; chainCap?: number }`.
- Produces: `BotGroupUpdateMessage` (`type: 'bot/groupUpdate'`) and `BotGroupDeleteMessage` (`type: 'bot/groupDelete'`, payload `{ id: string }`), both included in `ClientToHostMessage`.

- [ ] **Step 1: Add both messages to the wire test**

In `CLIENT_BOT_MESSAGES`, after the `bot/groupCreate` entry, add:

```ts
{
  type: 'bot/groupUpdate',
  payload: {
    id: 'grp-launch-ab12',
    name: 'Launch, revised',
    members: ['forge', 'scout'],
    lead: 'scout',
    chainCap: 4,
  },
},
{ type: 'bot/groupDelete', payload: { id: 'grp-launch-ab12' } },
```

- [ ] **Step 2: Run the protocol test and verify it fails**

Run: `npm run test -w @morse/protocol -- src/dto/bot.spec.ts`
Expected: FAIL — the two new types are rejected by `isClientToHostMessage`.

- [ ] **Step 3: Implement the DTO and messages**

In `packages/protocol/src/dto/bot.ts`, after `BotGroupCreateInput`, add:

```ts
/** What Edit group sends: the same room, with what the reader changed. */
export interface BotGroupUpdateInput {
  /** The group being edited; its id never changes. */
  id: string;
  name: string;
  members: string[];
  lead?: string;
  chainCap?: number;
}
```

In `packages/protocol/src/wire/client.ts`, beside `BotGroupCreateMessage`, add:

```ts
/** Changes an existing group from the Edit group dialog. */
export interface BotGroupUpdateMessage extends ClientMessageBase {
  type: 'bot/groupUpdate';
  payload: BotGroupUpdateInput;
}

/** Deletes one group, its transcript and every member's session for it. */
export interface BotGroupDeleteMessage extends ClientMessageBase {
  type: 'bot/groupDelete';
  payload: { id: string };
}
```

Import `BotGroupUpdateInput` from the DTO module in the same style as `BotGroupCreateInput`, and add both interfaces to `ClientToHostMessage`.

In `packages/protocol/src/wire.ts`, add `'bot/groupUpdate'` and `'bot/groupDelete'` to `CLIENT_MESSAGE_TYPES` after `'bot/groupCreate'`.

- [ ] **Step 4: Run the protocol test and verify it passes**

Run: `npm run test -w @morse/protocol -- src/dto/bot.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/dto/bot.ts packages/protocol/src/wire/client.ts packages/protocol/src/wire.ts packages/protocol/src/dto/bot.spec.ts
git commit -m "feat(bot): add wire messages for group update and delete"
```

---

### Task 2: Engine-native session removal hook

**Files:**
- Modify: `packages/system/src/bot/service.ts`
- Modify: `packages/integration-pi/src/bot-engine.ts`
- Modify: `packages/integration-opencode/src/bot-engine.ts`
- Test: `packages/integration-pi/src/bot-engine.spec.ts`
- Test: `packages/integration-opencode/src/bot-engine.spec.ts`

**Interfaces:**
- Produces: `BotGatewayFactory` gains optional `removeSession?(engineSessionId: string): Promise<void>`.
- Produces: `createBotPiFactory` returns a factory with `removeSession`.
- Produces: `opencodeBotAdapterFactory` returns a factory with `removeSession`.

- [ ] **Step 1: Write the pi failure test**

In `packages/integration-pi/src/bot-engine.spec.ts`, extend `createBotPiFactory`'s describe block:

```ts
it('removes one session file by its stored id', async () => {
  const botRoot = tempRoot();
  const sessionPath = join(botRoot, 'sessions', '--work--', 'session-1.jsonl');
  mkdirSync(join(botRoot, 'sessions', '--work--'), { recursive: true });
  writeFileSync(sessionPath, '{}\n');
  const factory = createBotPiFactory({
    botRoot,
    env: { PATH: '/usr/bin' },
    piPath: '/opt/pi',
    logger: silentLogger,
  });

  await factory.removeSession(sessionPath);

  expect(existsSync(sessionPath)).toBe(false);
});
```

- [ ] **Step 2: Write the OpenCode failure test**

In `packages/integration-opencode/src/bot-engine.spec.ts`, inside `describe('opencodeBotAdapterFactory')`, add:

```ts
it('removes a session through the bot engine', async () => {
  const botRoot = tempRoot();
  const fake = await startFakeServer();
  process.env['PATH'] = `${fakeBinary(botRoot)}${delimiter}${process.env['PATH'] ?? ''}`;
  process.env['FAKE_OC_URL'] = fake.url;
  process.env['FAKE_OC_PASSWORD'] = PASSWORD;
  process.env['FAKE_OC_SPAWNS'] = join(botRoot, 'spawns.log');
  process.env['FAKE_OC_STOP_FILE'] = join(botRoot, 'stopped');
  process.env['FAKE_OC_ENV_FILE'] = join(botRoot, 'env.json');
  const factory = opencodeBotAdapterFactory(botRoot, silentLogger);
  try {
    await factory.removeSession('ses_remove');
    expect(fake.requests).toContain('DELETE /api/session/ses_remove');
  } finally {
    await factory.dispose();
    await fake.close();
  }
});
```

- [ ] **Step 3: Run both tests and verify they fail**

Run: `npm run test -w @morse/integration-pi -- src/bot-engine.spec.ts`
Run: `npm run test -w @morse/integration-opencode -- src/bot-engine.spec.ts`
Expected: FAIL — `removeSession` is not a function.

- [ ] **Step 4: Add the optional method to the service contract**

In `packages/system/src/bot/service.ts`, change `BotGatewayFactory`:

```ts
export type BotGatewayFactory = AgentGatewayFactory & {
  dispose?(): Promise<void>;
  /**
   * Removes one engine session that belongs to this bot. Optional because an
   * engine that cannot delete a stored session still lets Morse clean its own
   * pointers; the caller logs the fallback instead of failing a group delete.
   */
  removeSession?(engineSessionId: string): Promise<void>;
};
```

Do not add any engine-specific code to `packages/system/src/bot/`.

- [ ] **Step 5: Implement pi removal**

In `packages/integration-pi/src/bot-engine.ts`, import `PiRpcSessionCatalog` from `./pi-rpc-session-catalog.js`. Change `createBotPiFactory`'s return type to:

```ts
PiRpcAgentFactory & { removeSession(sessionId: string): Promise<void> }
```

Build the factory and a catalog bound to the same `sessionsDir`, then return an object that keeps the factory's own methods and adds:

```ts
removeSession: (sessionId) => catalog.remove(sessionId),
```

The catalog's `remove` already rejects paths outside `sessions/` and treats an already-missing file as success.

- [ ] **Step 6: Implement OpenCode removal**

In `packages/integration-opencode/src/bot-engine.ts`, inside the object returned by `opencodeBotAdapterFactory`, add:

```ts
async removeSession(sessionId: string): Promise<void> {
  if (disposed) {
    throw disposedError();
  }
  const target = await ensureEngine();
  if (disposed) {
    throw disposedError();
  }
  await target.catalog.remove(sessionId);
},
```

`OpenCodeSessionCatalog.remove` already issues `DELETE /session/{id}`.

- [ ] **Step 7: Run both tests and verify they pass**

Run: `npm run test -w @morse/integration-pi -- src/bot-engine.spec.ts`
Run: `npm run test -w @morse/integration-opencode -- src/bot-engine.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/system/src/bot/service.ts packages/integration-pi/src/bot-engine.ts packages/integration-pi/src/bot-engine.spec.ts packages/integration-opencode/src/bot-engine.ts packages/integration-opencode/src/bot-engine.spec.ts
git commit -m "feat(bot): let an engine factory remove one stored session"
```

---

### Task 3: `updateGroup` in `BotService`

**Files:**
- Modify: `packages/system/src/bot/service.ts`
- Test: `packages/system/src/bot/service.spec.ts`

**Interfaces:**
- Consumes: `BotGroupUpdateInput` from Task 1.
- Produces: `BotService.updateGroup(input: BotGroupUpdateInput): Promise<BotConversationSummary>`.
- Produces: `BotControllerPort` includes `updateGroup`.

- [ ] **Step 1: Extend the fake factory with session removal**

In `packages/system/src/bot/service.spec.ts`, add to `FakeFactory`:

```ts
readonly removedSessions: string[] = [];
failRemoveSession = false;

removeSession(sessionId: string): Promise<void> {
  if (this.failRemoveSession) {
    return Promise.reject(new Error('engine offline'));
  }
  this.removedSessions.push(sessionId);
  return Promise.resolve();
}
```

- [ ] **Step 2: Write the failing update tests**

In the `createGroup` describe block, add:

```ts
it('updateGroup rewrites the room and clears only the removed member session', async () => {
  const { service, adapter, root } = harness({
    script: ({ bot }) => ({ text: `${bot} here` }),
  });
  await twoBots(service);
  const group = service.createGroup({
    name: 'Launch',
    members: ['forge', 'sable'],
    lead: 'forge',
  });
  await service.send(group.id, '@forge @sable hello');

  const before = loadBotRegistry(root).conversations.find((one) => one.id === group.id);
  expect(before?.sessions['forge']?.engineSessionId).toBeDefined();
  const sableSession = before?.sessions['sable']?.engineSessionId;
  const forgeGateway = gatewayFor(adapter, 'forge');

  const updated = await service.updateGroup({
    id: group.id,
    name: 'Launch, revised',
    members: ['sable'],
    lead: 'sable',
    chainCap: 2,
  });

  expect(updated).toMatchObject({
    title: 'Launch, revised',
    members: ['sable'],
    lead: 'sable',
    chainCap: 2,
  });
  const after = loadBotRegistry(root).conversations.find((one) => one.id === group.id);
  expect(after?.sessions['forge']).toBeUndefined();
  expect(after?.sessions['sable']?.engineSessionId).toBe(sableSession);
  expect(forgeGateway.disposed).toBe(true);
});

it('starts a fresh session when a removed member is added back', async () => {
  const { service, adapter } = harness({
    script: ({ bot }) => ({ text: `${bot} here` }),
  });
  await twoBots(service);
  const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
  await service.send(group.id, '@forge first');
  await service.updateGroup({ id: group.id, name: 'Launch', members: ['sable'] });
  await service.updateGroup({ id: group.id, name: 'Launch', members: ['sable', 'forge'] });

  await service.send(group.id, '@forge again');

  const create = factoryFor(adapter, 'forge').createCalls.at(-1);
  expect(create?.sessionId).toBeUndefined();
});

it('updateGroup validates its members and lead like createGroup', async () => {
  const { service } = harness();
  await twoBots(service);
  const group = service.createGroup({ name: 'Launch', members: ['forge'] });

  await expect(
    service.updateGroup({ id: group.id, name: '', members: ['forge'] }),
  ).rejects.toThrow('A group needs a name.');
  await expect(
    service.updateGroup({ id: group.id, name: 'Launch', members: [] }),
  ).rejects.toThrow('A group needs at least one member.');
  await expect(
    service.updateGroup({ id: group.id, name: 'Launch', members: ['forge'], lead: 'sable' }),
  ).rejects.toThrow('The lead "sable" is not a member of the group.');
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npm run test -w @morse/system -- src/bot/service.spec.ts -t "updateGroup|added back"`
Expected: FAIL — `service.updateGroup` is not a function.

- [ ] **Step 4: Add `updateGroup` to the controller port and service**

In the `BotControllerPort` union, add `'updateGroup'` after `'createGroup'`.

Implement in `BotService`, after `createGroup`:

```ts
async updateGroup(input: BotGroupUpdateInput): Promise<BotConversationSummary> {
  const group = this.registry.groups.find((candidate) => candidate.id === input.id);
  const conversation = this.registry.conversations.find(
    (candidate) => candidate.id === input.id && candidate.kind === 'group',
  );
  if (group === undefined || conversation === undefined) {
    throw new Error(`No bot group "${input.id}".`);
  }
  if (input.name.trim() === '') {
    throw new Error('A group needs a name.');
  }
  if (input.members.length === 0) {
    throw new Error('A group needs at least one member.');
  }
  for (const member of input.members) {
    this.botOrThrow(member);
  }
  if (input.lead !== undefined && !input.members.includes(input.lead)) {
    throw new Error(`The lead "${input.lead}" is not a member of the group.`);
  }

  const removed = conversation.members.filter((member) => !input.members.includes(member));
  const added = input.members.filter((member) => !conversation.members.includes(member));
  const chainCap = input.chainCap ?? this.chainCap;

  // A round already speaking for the old room must not deliver to a member that
  // just left. The UI also blocks this, but the service is the authority.
  this.stop(input.id);

  group.name = input.name.trim();
  group.members = [...input.members];
  if (input.lead === undefined) {
    delete group.lead;
  } else {
    group.lead = input.lead;
  }
  group.chainCap = chainCap;

  conversation.title = input.name.trim();
  conversation.members = [...input.members];
  if (input.lead === undefined) {
    delete conversation.lead;
  } else {
    conversation.lead = input.lead;
  }
  conversation.chainCap = chainCap;

  for (const member of [...removed, ...added]) {
    delete conversation.sessions[member];
    const warm = this.warm.get(warmKey(conversation.id, member));
    if (warm !== undefined) {
      await this.dropWarm(warm, true);
    }
  }
  this.touched(conversation);
  this.emit({ type: 'roster' });
  return this.summarize(conversation);
}
```

Import `BotGroupUpdateInput` with the other protocol types.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npm run test -w @morse/system -- src/bot/service.spec.ts -t "updateGroup|added back"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/system/src/bot/service.ts packages/system/src/bot/service.spec.ts
git commit -m "feat(bot): edit a group without losing the kept members' sessions"
```

---

### Task 4: `deleteGroup` in `BotService`

**Files:**
- Modify: `packages/system/src/bot/service.ts`
- Test: `packages/system/src/bot/service.spec.ts`

**Interfaces:**
- Produces: `BotService.deleteGroup(id: string): Promise<void>`.
- Produces: `BotControllerPort` includes `deleteGroup`.
- Consumes: `BotGatewayFactory.removeSession` from Task 2.

- [ ] **Step 1: Write the failing delete tests**

In the same describe block, add:

```ts
it('deleteGroup removes its transcript, records and every member session', async () => {
  const { service, adapter, root } = harness({
    script: ({ bot }) => ({ text: `${bot} here` }),
  });
  await twoBots(service);
  const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
  await service.send(group.id, '@forge @sable hello');

  const stored = loadBotRegistry(root).conversations.find((one) => one.id === group.id);
  const forgeSession = stored?.sessions['forge']?.engineSessionId;
  const sableSession = stored?.sessions['sable']?.engineSessionId;
  const forgeGateway = gatewayFor(adapter, 'forge');
  const sableGateway = gatewayFor(adapter, 'sable');

  await service.deleteGroup(group.id);

  expect(service.roster().conversations.some((one) => one.id === group.id)).toBe(false);
  expect(service.transcript(group.id)).toEqual([]);
  expect(factoryFor(adapter, 'forge').removedSessions).toEqual([forgeSession]);
  expect(factoryFor(adapter, 'sable').removedSessions).toEqual([sableSession]);
  expect(forgeGateway.disposed).toBe(true);
  expect(sableGateway.disposed).toBe(true);
});

it('deleteGroup still removes the group when engine cleanup fails', async () => {
  const { service, adapter } = harness({
    script: ({ bot }) => ({ text: `${bot} here` }),
  });
  await twoBots(service);
  const group = service.createGroup({ name: 'Launch', members: ['forge'], lead: 'forge' });
  await service.send(group.id, 'hello');
  factoryFor(adapter, 'forge').failRemoveSession = true;

  await expect(service.deleteGroup(group.id)).resolves.toBeUndefined();

  expect(service.roster().conversations.some((one) => one.id === group.id)).toBe(false);
});

it('deleteGroup stops a round in flight', async () => {
  const { service, adapter } = harness({
    script: ({ bot }) => ({ text: `${bot} here`, hold: true }),
  });
  await twoBots(service);
  const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
  const sending = service.send(group.id, '@forge hold on');
  await gatewayFor(adapter, 'forge').prompted;

  await service.deleteGroup(group.id);

  await expect(sending).resolves.toBeUndefined();
  expect(gatewayFor(adapter, 'forge').disposed).toBe(true);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm run test -w @morse/system -- src/bot/service.spec.ts -t "deleteGroup"`
Expected: FAIL — `service.deleteGroup` is not a function.

- [ ] **Step 3: Implement `deleteGroup` and the cleanup helper**

Add `'deleteGroup'` to `BotControllerPort` after `'updateGroup'`.

Implement in `BotService`, after `updateGroup`:

```ts
async deleteGroup(id: string): Promise<void> {
  const group = this.registry.groups.find((candidate) => candidate.id === id);
  const conversation = this.registry.conversations.find(
    (candidate) => candidate.id === id && candidate.kind === 'group',
  );
  if (group === undefined || conversation === undefined) {
    throw new Error(`No bot group "${id}".`);
  }
  this.stop(id);
  const gateways = [...this.warm.values()].filter((warm) => warm.conversationId === id);
  await Promise.all(gateways.map((warm) => this.dropWarm(warm, true)));
  for (const member of conversation.members) {
    const sessionId = conversation.sessions[member]?.engineSessionId;
    if (sessionId !== undefined) {
      await this.removeEngineSession(member, sessionId);
    }
  }
  this.transcripts.forget(id);
  this.registry.groups = this.registry.groups.filter((candidate) => candidate.id !== id);
  this.registry.conversations = this.registry.conversations.filter(
    (candidate) => candidate.id !== id,
  );
  saveBotRegistry(this.options.root, this.registry);
  this.emit({ type: 'roster' });
}
```

Add the helper below `deleteGroup`:

```ts
/**
 * Asks one bot's engine to drop a stored session. Best-effort by design: a
 * group must still be deletable when its engine is offline, so a failure is
 * logged and the Morse records are removed anyway.
 */
private async removeEngineSession(username: string, sessionId: string): Promise<void> {
  const bot = this.bot(username);
  if (bot === undefined) {
    return;
  }
  const adapter = this.options.adapters[bot.engineKind];
  if (adapter === undefined) {
    return;
  }
  const factory = this.factoryFor(bot, adapter);
  if (factory.removeSession === undefined) {
    this.options.logger.warn(
      `Bot engine "${bot.engineKind}" cannot remove a stored session; forgetting the pointer only.`,
    );
    return;
  }
  try {
    await factory.removeSession(sessionId);
  } catch (error: unknown) {
    this.options.logger.warn('Failed to remove a deleted group\'s engine session', error);
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm run test -w @morse/system -- src/bot/service.spec.ts -t "deleteGroup"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/bot/service.ts packages/system/src/bot/service.spec.ts
git commit -m "feat(bot): delete a group and its members' sessions"
```

---

### Task 5: Cascade bot deletion through groups and sessions

**Files:**
- Modify: `packages/system/src/bot/service.ts`
- Test: `packages/system/src/bot/service.spec.ts`

**Interfaces:**
- Produces: updated `BotService.deleteBot(username: string): Promise<void>` with cascading cleanup.

- [ ] **Step 1: Write the failing cascade tests**

In a new `describe('BotService bot deletion cleanup')`, add:

```ts
it('deleteBot keeps a multi-member group without the bot', async () => {
  const { service, root } = harness({
    script: ({ bot }) => ({ text: `${bot} here` }),
  });
  await twoBots(service);
  const group = service.createGroup({
    name: 'Launch',
    members: ['forge', 'sable'],
    lead: 'forge',
  });
  await service.send(group.id, '@forge @sable hello');

  await service.deleteBot('forge');

  const registry = loadBotRegistry(root);
  const kept = registry.conversations.find((one) => one.id === group.id);
  expect(kept?.members).toEqual(['sable']);
  expect(kept?.lead).toBeUndefined();
  expect(kept?.sessions['forge']).toBeUndefined();
  expect(kept?.sessions['sable']?.engineSessionId).toBeDefined();
  expect(registry.groups.find((one) => one.id === group.id)?.members).toEqual(['sable']);
  expect(registry.conversations.some((one) => one.id === 'dm-forge')).toBe(false);
  expect(service.transcript('dm-forge')).toEqual([]);
  expect(existsSync(join(root, 'forge'))).toBe(false);
});

it('deleteBot removes a group whose only member it was', async () => {
  const { service, root } = harness();
  await twoBots(service);
  const group = service.createGroup({ name: 'Solo', members: ['forge'] });

  await service.deleteBot('forge');

  const registry = loadBotRegistry(root);
  expect(registry.groups.some((one) => one.id === group.id)).toBe(false);
  expect(registry.conversations.some((one) => one.id === group.id)).toBe(false);
  expect(service.transcript(group.id)).toEqual([]);
});

it('deleteBot stops a round it is answering in a group', async () => {
  const { service, adapter } = harness({
    script: ({ bot }) => ({ text: `${bot} here`, hold: true }),
  });
  await twoBots(service);
  const group = service.createGroup({ name: 'Launch', members: ['forge', 'sable'] });
  const sending = service.send(group.id, '@forge hold on');
  await gatewayFor(adapter, 'forge').prompted;

  await service.deleteBot('forge');

  await expect(sending).resolves.toBeUndefined();
  expect(gatewayFor(adapter, 'forge').disposed).toBe(true);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm run test -w @morse/system -- src/bot/service.spec.ts -t "deleteBot"`
Expected: FAIL — groups and DM conversation are still present.

- [ ] **Step 3: Implement the cascade**

Replace the body of `deleteBot` with:

```ts
async deleteBot(username: string): Promise<void> {
  const bot = this.botOrThrow(username);
  // Any round speaking for this bot is over, including one it is answering in a
  // group whose other members remain.
  for (const [conversationId, round] of this.rounds) {
    if (round.conversation.members.includes(bot.username)) {
      this.stop(conversationId);
    }
  }
  const gateways = [...this.warm.values()].filter((warm) => warm.username === bot.username);
  await Promise.all(gateways.map((warm) => this.dropWarm(warm, true)));
  const factory = this.factories.get(bot.username);
  this.factories.delete(bot.username);
  await this.disposeFactory(factory, "Failed to dispose a deleted bot's factory");
  this.transcripts.forget(dmConversationId(bot.username));
  rmSync(this.botRoot(bot.username), { recursive: true, force: true });

  const emptiedGroups: string[] = [];
  for (const conversation of this.registry.conversations) {
    if (!conversation.members.includes(bot.username)) {
      continue;
    }
    conversation.members = conversation.members.filter((member) => member !== bot.username);
    delete conversation.sessions[bot.username];
    if (conversation.lead === bot.username) {
      delete conversation.lead;
    }
    if (conversation.kind === 'group' && conversation.members.length === 0) {
      emptiedGroups.push(conversation.id);
    }
    conversation.updatedAt = this.clock();
  }
  this.registry.bots = this.registry.bots.filter(
    (candidate) => candidate.username !== bot.username,
  );
  this.registry.groups = this.registry.groups
    .filter((group) => !emptiedGroups.includes(group.id))
    .map((group) => {
      if (!group.members.includes(bot.username)) {
        return group;
      }
      const { lead, ...rest } = group;
      return {
        ...rest,
        members: group.members.filter((member) => member !== bot.username),
        ...(lead === bot.username ? {} : { lead }),
      };
    });
  this.registry.conversations = this.registry.conversations.filter(
    (conversation) =>
      conversation.id !== dmConversationId(bot.username) &&
      !emptiedGroups.includes(conversation.id),
  );
  for (const id of emptiedGroups) {
    this.transcripts.forget(id);
  }
  saveBotRegistry(this.options.root, this.registry);
  this.emit({ type: 'roster' });
}
```

Keep the existing `deleteBot disposes the bot factory once` test green: the factory is still removed and disposed exactly once.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm run test -w @morse/system -- src/bot/service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/bot/service.ts packages/system/src/bot/service.spec.ts
git commit -m "feat(bot): cascade bot deletion through groups and sessions"
```

---

### Task 6: Route the two new messages through the host controller

**Files:**
- Modify: `packages/system/src/host/session-controller.ts`
- Test: `packages/system/src/host/session-controller.spec.ts`
- Test: `packages/server/src/internal/ws/session-factory.spec.ts`

**Interfaces:**
- Consumes: `BotControllerPort.updateGroup` and `.deleteGroup` from Tasks 3 and 4.
- Produces: `bot/groupUpdate` and `bot/groupDelete` handled in `handleBotMessage`.

- [ ] **Step 1: Write the failing controller tests**

In `packages/system/src/host/session-controller.spec.ts`, add `updateGroup` and `deleteGroup` to `fakePort`'s default object:

```ts
updateGroup: async () => group,
deleteGroup: async () => undefined,
```

Then add a test beside the existing group-create assertion:

```ts
it('edits and deletes a group through the bot port', async () => {
  const messages: HostToClientMessage[] = [];
  const updated: unknown[] = [];
  const removed: string[] = [];
  const controller = botController(
    messages,
    fakePort({
      updateGroup: async (input) => {
        updated.push(input);
        return group;
      },
      deleteGroup: async (id) => {
        removed.push(id);
      },
    }),
  );

  await controller.handleClientMessage({
    type: 'bot/groupUpdate',
    payload: { id: 'group-1', name: 'reviewers', members: ['forge'] },
  });
  await controller.handleClientMessage({
    type: 'bot/groupDelete',
    payload: { id: 'group-1' },
  });

  expect(updated).toEqual([{ id: 'group-1', name: 'reviewers', members: ['forge'] }]);
  expect(removed).toEqual(['group-1']);
  expect(messages.at(-1)).toEqual({ type: 'bot/roster', payload: { bots: [], conversations: [] } });
});
```

- [ ] **Step 2: Write the failing server wiring test**

In `packages/server/src/internal/ws/session-factory.spec.ts`, add to `fakeBot`'s service object:

```ts
updateGroup: vi.fn(() => group),
deleteGroup: vi.fn(async () => undefined),
```

Extend the existing bot mutation test, after the `bot/groupCreate` assertion:

```ts
await controller.handleClientMessage({
  type: 'bot/groupUpdate',
  payload: { id: 'group-1', name: 'reviewers, revised', members: ['forge'] },
});
expect(bot.calls.updateGroup).toHaveBeenCalled();
expect(messages.at(-1)).toEqual({ type: 'bot/roster', payload: bot.roster });

await controller.handleClientMessage({
  type: 'bot/groupDelete',
  payload: { id: 'group-1' },
});
expect(bot.calls.deleteGroup).toHaveBeenCalledWith('group-1');
expect(messages.at(-1)).toEqual({ type: 'bot/roster', payload: bot.roster });
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npm run build -w @morse/system && npm run test -w @morse/system -- src/host/session-controller.spec.ts -t "edits and deletes"`
Run: `npm run test -w @morse/server -- src/internal/ws/session-factory.spec.ts -t "group"`
Expected: FAIL — the host reports the new messages as unsupported and never calls the port.

- [ ] **Step 4: Handle both messages**

In `handleBotMessage`, after the `bot/groupCreate` case:

```ts
case 'bot/groupUpdate':
  await this.runBotAction(() => bot.updateGroup(message.payload));
  return;
case 'bot/groupDelete':
  await this.runBotAction(() => bot.deleteGroup(message.payload.id));
  return;
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npm run build -w @morse/system && npm run test -w @morse/system -- src/host/session-controller.spec.ts -t "edits and deletes"`
Run: `npm run test -w @morse/server -- src/internal/ws/session-factory.spec.ts -t "group"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/system/src/host/session-controller.ts packages/system/src/host/session-controller.spec.ts packages/server/src/internal/ws/session-factory.spec.ts
git commit -m "feat(bot): route group update and delete through the host"
```

---

### Task 7: UI service methods and edit target

**Files:**
- Modify: `packages/ui-angular/src/app/host/morse.service.ts`
- Test: `packages/ui-angular/src/app/host/morse.service.spec.ts`

**Interfaces:**
- Produces: `MorseService.updateGroup(input: BotGroupUpdateInput): void`.
- Produces: `MorseService.deleteGroup(id: string): void`.
- Produces: `MorseService.ui.groupTarget: WritableSignal<string | null>`.

- [ ] **Step 1: Write the failing UI service tests**

Beside the existing `creates a group with the dialog input` test, add:

```ts
it('updates a group with the dialog input', () => {
  const transport = new ScriptedTransport();
  const morse = mount(transport);
  const input = {
    id: 'grp-launch-ab12',
    name: 'builders',
    members: ['forge', 'sable'],
    lead: 'sable',
    chainCap: 3,
  };

  morse.updateGroup(input);

  expect(lastFrame(transport)).toEqual({ type: 'bot/groupUpdate', payload: input });
});

it('deletes a group by id', () => {
  const transport = new ScriptedTransport();
  const morse = mount(transport);

  morse.deleteGroup('grp-launch-ab12');

  expect(lastFrame(transport)).toEqual({
    type: 'bot/groupDelete',
    payload: { id: 'grp-launch-ab12' },
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm run test -w @morse/ui-angular`
Expected: FAIL — `updateGroup` and `deleteGroup` are not functions.

- [ ] **Step 3: Add the methods and the edit target**

In `MorseService.ui`, add beside `groupOpen`:

```ts
/** The group the dialog is editing, or `null` for a new group. */
groupTarget: signal<string | null>(null),
```

After `createGroup`, add:

```ts
/** Saves an edit to a group; membership changes invalidate removed members' sessions. */
updateGroup(input: BotGroupUpdateInput): void {
  this.transport.send({ type: 'bot/groupUpdate', payload: input });
}

/** Deletes a group, its transcript and its members' sessions for it. */
deleteGroup(id: string): void {
  this.transport.send({ type: 'bot/groupDelete', payload: { id } });
}
```

Import `BotGroupUpdateInput` from `@morse/protocol`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm run test -w @morse/ui-angular`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/host/morse.service.ts packages/ui-angular/src/app/host/morse.service.spec.ts
git commit -m "feat(ui): send group edits and deletions to the host"
```

---

### Task 8: Turn the group dialog into New/Edit

**Files:**
- Modify: `packages/ui-angular/src/app/features/bot-group-dialog/bot-group-dialog.ts`
- Modify: `packages/ui-angular/src/app/features/bot-group-dialog/bot-group-dialog.html`
- Test: `packages/ui-angular/src/app/features/bot-group-dialog/bot-group-dialog.spec.ts`

**Interfaces:**
- Consumes: `MorseService.ui.groupTarget`, `.updateGroup`, `.deleteGroup` from Task 7.
- Produces: the same component now prefills from a group summary when `groupTarget` names one.

- [ ] **Step 1: Write the failing edit test**

In `bot-group-dialog.spec.ts`, add a group fixture:

```ts
const launch = {
  id: 'grp-launch-ab12',
  kind: 'group' as const,
  title: 'Launch',
  members: ['forge', 'sable'],
  lead: 'forge',
  chainCap: 4,
  updatedAt: 1,
};
```

Change the `render` helper to accept an optional setup callback:

```ts
async function render(
  setup?: (morse: MorseService) => void,
): Promise<{
  fixture: ComponentFixture<BotGroupDialog>;
  host: HTMLElement;
  morse: MorseService;
}> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [BotGroupDialog],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
  }).compileComponents();
  const morse = TestBed.inject(MorseService);
  setup?.(morse);
  const fixture = TestBed.createComponent(BotGroupDialog);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, morse };
}
```

Add the test:

```ts
it('prefills and submits an edit for the group it was opened on', async () => {
  const { fixture, host, morse } = await render((service) => {
    service.bot.onRoster({ bots: [forge, sable, ember], conversations: [launch] });
    service.ui.groupTarget.set(launch.id);
  });
  const update = vi.spyOn(morse, 'updateGroup');

  expect(host.querySelector('h2')?.textContent).toContain('Edit group');
  expect(field<HTMLInputElement>(host, 'input[name="name"]').value).toBe('Launch');
  expect(
    (host.querySelector('.member input[data-bot="forge"]') as HTMLInputElement).checked,
  ).toBe(true);
  expect((host.querySelector('select[name="lead"]') as HTMLSelectElement).value).toBe('forge');
  expect(field<HTMLButtonElement>(host, '.actions button.create').textContent).toContain(
    'Save changes',
  );

  field<HTMLButtonElement>(host, '.actions button.create').click();
  fixture.detectChanges();

  expect(update).toHaveBeenCalledWith({
    id: launch.id,
    name: 'Launch',
    members: ['forge', 'sable'],
    lead: 'forge',
    chainCap: 4,
  });
  expect(morse.ui.groupOpen()).toBe(false);
  expect(morse.ui.groupTarget()).toBeNull();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test -w @morse/ui-angular`
Expected: FAIL — the dialog still creates a new group and never calls `updateGroup`.

- [ ] **Step 3: Implement edit mode**

In `bot-group-dialog.ts`:

- Read the target once when the component is constructed:

```ts
private readonly initial = this.initialGroup();

private initialGroup(): BotConversationSummary | undefined {
  const id = this.morse.ui.groupTarget();
  if (id === null) {
    return undefined;
  }
  return (this.morse.bot.roster()?.conversations ?? []).find(
    (conversation) => conversation.id === id && conversation.kind === 'group',
  );
}

protected readonly editing = this.initial !== undefined;
```

- Initialize the fields from `this.initial`:

```ts
protected readonly name = signal(this.initial?.title ?? '');
protected readonly members = signal<string[]>([...(this.initial?.members ?? [])]);
protected readonly lead = signal(this.initial?.lead ?? '');
protected readonly chainCap = signal(this.initial?.chainCap ?? 8);
```

- Replace `submit`:

```ts
protected submit(): void {
  if (!this.ready()) {
    return;
  }
  const lead = this.lead();
  const input = {
    name: this.name().trim(),
    members: [...this.members()],
    ...(lead.length > 0 ? { lead } : {}),
    chainCap: this.chainCap(),
  };
  if (this.initial === undefined) {
    this.morse.createGroup(input);
  } else {
    this.morse.updateGroup({ id: this.initial.id, ...input });
  }
  this.close();
}

private close(): void {
  this.morse.ui.groupOpen.set(false);
  this.morse.ui.groupTarget.set(null);
}
```

- Make `cancel()` call `close()`.
- Import `BotConversationSummary` from `@morse/protocol` for the method's return type.

- [ ] **Step 4: Implement the copy**

In `bot-group-dialog.html`:

```html
<h2 id="bot-group-title">{{ editing ? 'Edit group' : 'New group' }}</h2>
```

Keep the lede but make the first sentence conditional if desired; the title is the contract the test checks. Change the submit button label:

```html
{{ editing ? 'Save changes' : 'Create group' }}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npm run test -w @morse/ui-angular`
Expected: PASS, including the existing create tests.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-angular/src/app/features/bot-group-dialog/bot-group-dialog.ts packages/ui-angular/src/app/features/bot-group-dialog/bot-group-dialog.html packages/ui-angular/src/app/features/bot-group-dialog/bot-group-dialog.spec.ts
git commit -m "feat(ui): reuse the group dialog for edits"
```

---

### Task 9: Group menu Edit and Delete

**Files:**
- Modify: `packages/ui-angular/src/app/features/bot-nav/bot-nav.ts`
- Modify: `packages/ui-angular/src/app/features/bot-nav/bot-nav.html`
- Test: `packages/ui-angular/src/app/features/bot-nav/bot-nav.spec.ts`

**Interfaces:**
- Consumes: `MorseService.ui.groupTarget`, `.updateGroup` not needed here, `.deleteGroup` from Task 7.

- [ ] **Step 1: Write the failing menu tests**

Add beside the bot menu tests:

```ts
it('opens the group dialog for the group its menu asked to edit', async () => {
  const { fixture, host, morse } = await render();
  morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop] });
  fixture.detectChanges();

  rightClick(rows(host, 'group')[0] as HTMLElement);
  fixture.detectChanges();
  menuItem(host, 'edit-group').click();
  fixture.detectChanges();

  expect(morse.ui.groupTarget()).toBe('group-workshop');
  expect(morse.ui.groupOpen()).toBe(true);
  expect(host.querySelector('.context-menu')).toBeNull();
});

it('deletes a group through the menu, naming it in the confirmation', async () => {
  const { fixture, host, morse } = await render();
  morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop] });
  fixture.detectChanges();
  const remove = vi.spyOn(morse, 'deleteGroup');

  rightClick(rows(host, 'group')[0] as HTMLElement);
  fixture.detectChanges();
  menuItem(host, 'delete-group').click();
  fixture.detectChanges();

  expect(host.querySelector('.context-menu-title')?.textContent).toContain('The workshop');
  expect(remove).not.toHaveBeenCalled();

  [...host.querySelectorAll('.context-menu-item')]
    .find((one) => one.textContent?.trim() === 'Delete group')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  expect(remove).toHaveBeenCalledWith('group-workshop');
});

it('refuses to edit or delete a group that is answering', async () => {
  const { fixture, host, morse } = await render();
  morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop] });
  morse.bot.onRouting({ conversationId: 'group-workshop', target: 'Forge', queued: [] });
  fixture.detectChanges();

  rightClick(rows(host, 'group')[0] as HTMLElement);
  fixture.detectChanges();

  expect(menuItem(host, 'edit-group').disabled).toBe(true);
  expect(menuItem(host, 'delete-group').disabled).toBe(true);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm run test -w @morse/ui-angular`
Expected: FAIL — the group menu has no `edit-group` or `delete-group` item.

- [ ] **Step 3: Extend the menu state and handlers**

In `bot-nav.ts`:

- Change the group variant:

```ts
| (MenuAnchor & { kind: 'group'; group: BotConversationSummary; confirming: boolean });
```

- Set `confirming: false` in both places that build a group menu.
- Add:

```ts
protected routingForConversation(id: string): boolean {
  return this.routing()?.conversationId === id;
}

protected editGroup(group: BotConversationSummary): void {
  this.closeMenu();
  this.morse.ui.groupTarget.set(group.id);
  this.morse.ui.groupOpen.set(true);
}

protected askDeleteGroup(group: BotConversationSummary): void {
  const open = this.menu();
  if (open === undefined) {
    return;
  }
  this.menu.set({ ...open, kind: 'group', group, confirming: true });
}

protected deleteGroupNow(group: BotConversationSummary): void {
  this.closeMenu();
  this.morse.deleteGroup(group.id);
  this.shell.closeNavigation();
}
```

- In `newGroup()`, set `this.morse.ui.groupTarget.set(null)` before opening.
- Let `routingFor(bot)` call `routingForConversation(\`dm-${bot.username}\`)` so both menus use one rule.

- [ ] **Step 4: Extend the group menu markup**

Replace the `@case ('group')` block in `bot-nav.html`:

```html
@case ('group') {
  @if (open.confirming) {
    <p class="context-menu-question">Delete group?</p>
    <p class="context-menu-title">{{ open.group.title }}</p>
    <button type="button" class="context-menu-item"
      role="menuitem"
      (click)="closeMenu()">Cancel</button>
    <button type="button" class="context-menu-item danger"
      role="menuitem"
      (click)="deleteGroupNow(open.group)">
      Delete group
    </button>
  } @else {
    <button type="button" class="context-menu-item"
      role="menuitem"
      (click)="openGroup(open.group)">
      Open
    </button>
    <button type="button" class="context-menu-item"
      role="menuitem"
      (click)="startDiscussion(open.group.id)">
      New discussion
    </button>
    <button
      type="button"
      class="context-menu-item edit-group"
      role="menuitem"
      [disabled]="routingForConversation(open.group.id)"
      [title]="
        routingForConversation(open.group.id)
          ? 'This group is answering — wait for the turn to end'
          : 'Edit ' + open.group.title
      "
      (click)="editGroup(open.group)"
    >
      Edit group…
    </button>
    <button
      type="button"
      class="context-menu-item danger delete-group"
      role="menuitem"
      [disabled]="routingForConversation(open.group.id)"
      [title]="
        routingForConversation(open.group.id)
          ? 'This group is answering — wait for the turn to end'
          : 'Delete ' + open.group.title
      "
      (click)="askDeleteGroup(open.group)"
    >
      Delete group…
    </button>
  }
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npm run test -w @morse/ui-angular`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-angular/src/app/features/bot-nav/bot-nav.ts packages/ui-angular/src/app/features/bot-nav/bot-nav.html packages/ui-angular/src/app/features/bot-nav/bot-nav.spec.ts
git commit -m "feat(ui): edit and delete groups from the roster menu"
```

---

### Task 10: Document the behavior and run the full gate

**Files:**
- Modify: `docs/STATUS.md`

- [ ] **Step 1: Add the shipped behavior**

In the Bot mode section, after the **Talking** bullet, add:

```md
- **Editable rooms.** A group can be renamed, re-membered, re-led and re-capped. Removing a
  member clears only that bot's pointer to the room's session, so adding it back starts fresh;
  deleting a group removes its transcript and each member's session for it. Deleting a bot
  removes everything of its own and leaves every group it shared otherwise intact — a group is
  deleted only when that bot was its last member.
```

- [ ] **Step 2: Build the libraries so dist-based specs see the new types**

Run: `npm run build:libs`
Expected: every workspace compiles.

- [ ] **Step 3: Run the full fast test gate**

Run: `npm run test:fast`
Expected: PASS across protocol, system, ui-runtime, server and ui-angular.

- [ ] **Step 4: Run type checks and lint**

Run: `npm run check-types`
Expected: PASS.
Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/STATUS.md
git commit -m "docs(bot): document group editing and session cleanup"
```
