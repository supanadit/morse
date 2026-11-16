# Agent Config Freshness and the Real Default Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a new Morse session name the model its effective OpenCode agent will really use, and make global/project config edits reach new sessions — deterministically and without restarting the OpenCode server — with a manual reload control that warns while sessions run.

**Architecture:** Read each primary agent's `model` from `/api/agent` and resolve the current model from it (falling back to `/api/model/default` only when needed). A per-engine config guard fingerprints global + project `opencode.json[c]`, reloads the location when idle, and tracks streaming sessions. The capability rides `AgentGatewayFactory` (not `AgentExtras`) so both hosts get it. The draft cache keys on mode, project and signature; the composer exposes a reload button with an inline warning.

**Tech Stack:** TypeScript, Node `fs`, OpenCode v2 HTTP API, NestJS-free `@morse/system` host controller, Angular signals, Vitest, Angular unit-test builder.

**Spec:** `docs/superpowers/specs/2026-11-16-agent-config-and-default-model-design.md`

## Global Constraints

- Do not stop, respawn or hot-swap the OpenCode server. `/api/location/reload` is the only reload mechanism.
- Never display a model that `/api/model` does not list, unless it is `/api/model/default` (the server's own fallback).
- pi is unchanged: no modes, no config reload, no new pickers.
- `@morse/agent` and `@morse/protocol` must be built (`npm run build:libs`) before tests in dependent packages, because workspace packages resolve `dist/`.
- `npm run test:fast` does not include `@morse/integration-opencode`; run that package's tests explicitly.
- Keep comments in the codebase's voice: explain *why*, not *what*.
- One conventional commit per task.

## Review Focus

- **A config edit removes or renames the agent the session uses.** The mode picker must keep the session's current mode (OpenCode may still hold it) and must not crash or blank the model. Pinned by Task 4's `refreshConfig` test with the mode gone.
- **A config edit lands while another session is streaming.** The automatic reload must not run, and the next idle probe must retry rather than consider the change consumed. Pinned by Task 2's streaming test.
- **A draft moves from project A to project B, each with a different `default_agent`.** The probe and cache must follow B. Pinned by Task 5's workspace-key test.
- **An agent model is absent from `/api/model` but `/api/model/default` is known.** Show the server's fallback, never a dead agent model. Pinned by Task 3's fallback test.
- **Morse is attached to a user-run server (`MORSE_OPENCODE_URL`).** Automatic reload must never POST; the manual force must. Pinned by Task 2's attached-server test.

---

### Task 1: Read each agent's configured model

**Files:**
- Modify: `packages/integration-opencode/src/internal/catalog.ts:43-99`
- Test: `packages/integration-opencode/src/internal/catalog.spec.ts`

**Interfaces:**
- Produces: `ApiAgentModel { id: string; providerID: string; variant?: string }`
- Produces: `AgentCatalog { modes: AgentMode[]; defaultMode?: string; models: Map<string, ApiAgentModel> }`
- Produces: `readAgentCatalog(api: OpenCodeApi, directory: string, logger: MorseLogger): Promise<AgentCatalog>`
- Keeps: `readAgentModes(api, directory, logger): Promise<AgentMode[]>` (now a thin wrapper)

- [ ] **Step 1: Write the failing tests**

Add to `catalog.spec.ts`, importing `readAgentCatalog`:

```ts
const MODELLED: ApiAgent[] = [
  { id: 'build', name: 'Build', mode: 'primary', model: { id: 'deepseek', providerID: 'opencode-go' } },
  { id: 'plan', name: 'Plan', mode: 'primary', model: { id: 'hy4', providerID: 'opencode-go' } },
  { id: 'general', name: 'General', mode: 'subagent', model: { id: 'deepseek', providerID: 'opencode-go' } },
  { id: 'title', name: 'Title', mode: 'primary', hidden: true, model: { id: 'deepseek', providerID: 'opencode-go' } },
];

it('maps each primary agent to its configured model', async () => {
  const api = new FakeApi(MODELLED, [{ type: 'document', info: { default_agent: 'build' } }]);
  const catalog = await readAgentCatalog(api as unknown as OpenCodeApi, '/work', silentLogger);

  expect(catalog.defaultMode).toBe('build');
  expect(catalog.models.get('build')).toEqual({ id: 'deepseek', providerID: 'opencode-go' });
  expect(catalog.models.get('plan')).toEqual({ id: 'hy4', providerID: 'opencode-go' });
  expect(catalog.models.has('general')).toBe(false);
  expect(catalog.models.has('title')).toBe(false);
});

it('leaves an agent without a configured model out of the model map', async () => {
  const api = new FakeApi([{ id: 'build', name: 'Build', mode: 'primary' }], []);
  const catalog = await readAgentCatalog(api as unknown as OpenCodeApi, '/work', silentLogger);
  expect(catalog.models.size).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @morse/integration-opencode -- src/internal/catalog.spec.ts`
Expected: FAIL because `readAgentCatalog` is not exported.

- [ ] **Step 3: Implement the catalog**

In `catalog.ts`:

- Add `model?: ApiAgentModel` to `ApiAgent`.
- Extract the existing `/agent` + `/config` reads into `readAgentCatalog`, building `modes`, `defaultMode` (the configured default when it exists in `primary`, else `primary[0]?.id`), and `models` only for the primary, non-hidden agents that have a model.
- Make `readAgentModes` return `(await readAgentCatalog(...)).modes`, preserving its exact calls and order.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @morse/integration-opencode -- src/internal/catalog.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/integration-opencode/src/internal/catalog.ts packages/integration-opencode/src/internal/catalog.spec.ts
git commit -m "feat(opencode): read each agent's configured model"
```

---

### Task 2: Config signature and idle location reload

**Files:**
- Modify: `packages/integration-opencode/src/engine/config-discovery.ts` (new exported signature helper)
- Create: `packages/integration-opencode/src/internal/config-guard.ts`
- Test: `packages/integration-opencode/src/internal/config-guard.spec.ts`

**Interfaces:**
- Produces: `openCodeConfigSignature(context: EngineContext, configDir: string | undefined, cwd: string): string`
- Produces: `OpenCodeConfigGuardOptions { api: Pick<OpenCodeApi, 'post'>; logger: MorseLogger; owned: boolean; configDir?: string; env?: NodeJS.ProcessEnv }`
- Produces: `class OpenCodeConfigGuard` with `signature(cwd: string): string`, `ensureFresh(cwd: string): Promise<boolean>`, `reloadNow(cwd?: string): Promise<void>`, `setStreaming(sessionId: string, streaming: boolean): void`, `forget(sessionId: string): void`

- [ ] **Step 1: Write the failing tests**

Create `config-guard.spec.ts` with a temp `XDG_CONFIG_HOME`, a `FakeApi` that records `post` paths, and these cases:

```ts
it('seeds the first signature without reloading', async () => {
  mkdirSync(join(configHome, 'opencode'), { recursive: true });
  writeFileSync(join(configHome, 'opencode', 'opencode.json'), '{"default_agent":"build"}');
  const { guard, posts } = makeGuard({ owned: true });
  await expect(guard.ensureFresh('/work')).resolves.toBe(false);
  expect(posts).toEqual([]);
});

it('reloads once when the global file changes, then stays quiet', async () => {
  const { guard, posts } = makeGuard({ owned: true });
  await guard.ensureFresh('/work');
  const file = join(configHome, 'opencode', 'opencode.json');
  utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  await expect(guard.ensureFresh('/work')).resolves.toBe(true);
  await expect(guard.ensureFresh('/work')).resolves.toBe(false);
  expect(posts).toEqual(['/location/reload']);
});

it('defers a reload while a tracked session is streaming', async () => {
  const { guard, posts } = makeGuard({ owned: true });
  await guard.ensureFresh('/work');
  guard.setStreaming('ses_1', true);
  const file = join(configHome, 'opencode', 'opencode.json');
  utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  await expect(guard.ensureFresh('/work')).resolves.toBe(false);
  expect(posts).toEqual([]);
  guard.setStreaming('ses_1', false);
  await expect(guard.ensureFresh('/work')).resolves.toBe(true);
  expect(posts).toEqual(['/location/reload']);
});

it('never reloads an attached server automatically, but reloads on demand', async () => {
  const { guard, posts } = makeGuard({ owned: false });
  await guard.ensureFresh('/work');
  const file = join(configHome, 'opencode', 'opencode.json');
  utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  await expect(guard.ensureFresh('/work')).resolves.toBe(false);
  expect(posts).toEqual([]);
  await guard.reloadNow('/work');
  expect(posts).toEqual(['/location/reload']);
});

it('covers a project .opencode/opencode.json as well as the global file', async () => {
  mkdirSync('/work/.opencode', { recursive: true });
  writeFileSync('/work/.opencode/opencode.json', '{"default_agent":"plan"}');
  const { guard, posts } = makeGuard({ owned: true });
  await guard.ensureFresh('/work');
  utimesSync('/work/.opencode/opencode.json', new Date(), new Date(Date.now() + 5_000));
  await expect(guard.ensureFresh('/work')).resolves.toBe(true);
  expect(posts).toEqual(['/location/reload']);
});
```

Use `mkdtempSync` for `configHome` and `rmSync` in `afterEach`; for `/work`, use a temp directory too. Point `XDG_CONFIG_HOME` at `configHome` via the guard's `env` option, not `process.env`, so tests stay isolated.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @morse/integration-opencode -- src/internal/config-guard.spec.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the signature helper and the guard**

In `config-discovery.ts`, add a helper that takes the candidate paths from `openCodeConfigCandidates(context, configDir, cwd)` — missing ones included, so creating the first config file changes the fingerprint — stats each with `statSync`, and returns a stable `path:mtimeMs:size` joined string; a missing file contributes `path:missing`.

In `config-guard.ts`, implement the class:

- `signature(cwd)` resolves an `EngineContext` with `resolveEngineContext({ env, cwd })` and calls the helper.
- `ensureFresh(cwd)` stores the first signature without POSTing; on a later change it POSTs `/location/reload` only when `owned` and no session id is in the streaming set, then stores the signature. A skipped change leaves the old signature so the next idle call retries.
- `reloadNow(cwd?)` always POSTs, clears the signature map, then seeds `cwd` if given.
- Failures from `post` are logged and return `false`/resolve; they never throw.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @morse/integration-opencode -- src/internal/config-guard.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/integration-opencode/src/engine/config-discovery.ts packages/integration-opencode/src/internal/config-guard.ts packages/integration-opencode/src/internal/config-guard.spec.ts
git commit -m "feat(opencode): add config signature and idle reload guard"
```

---

### Task 3: Resolve the draft's real model and expose the factory capability

**Files:**
- Modify: `packages/agent/src/ports.ts:80-132`
- Modify: `packages/integration-opencode/src/opencode-engine.ts`
- Modify: `packages/integration-opencode/src/opencode-agent.ts` (options only in this task)
- Test: `packages/integration-opencode/src/opencode-engine.spec.ts`

**Interfaces:**
- Produces: `AgentGatewayFactory.defaultEngineKind?: string`
- Produces: `AgentGatewayFactory.configSignature?(options: { workspace: WorkspaceRef; engine?: string }): string`
- Produces: `AgentGatewayFactory.reloadConfig?(options: { engine?: string; cwd?: string }): Promise<boolean | void>`
- Produces: `AgentGateway.refreshConfig?(): Promise<void>`
- Produces: `probeDefaults(options: { workspace: WorkspaceRef; engine?: string; model?: ModelRef; mode?: string })`
- Produces: `OpenCodeEngineDeps.env?: NodeJS.ProcessEnv`

- [ ] **Step 1: Write the failing tests**

Extend `FakeApi` in `opencode-engine.spec.ts` to return the agent models and to record query params. Use a fixture where `/api/model` lists `flint-40b-free` and `qwen4-max`, `/api/agent` gives `build → qwen4-max` and `plan → flint-40b-free`, `/config` defaults to `build`, and `/model/default` returns `flint-40b-free`.

```ts
it("names the default agent's configured model in a draft", async () => {
  const { engine } = engineWith();
  const state = await (await engine.factory.probeDefaults({ workspace: WORKSPACE })).state();
  expect(state.model).toMatchObject({ provider: 'opencode-go', id: 'qwen4-max' });
});

it("names the picked mode's model in a draft", async () => {
  const { engine } = engineWith();
  const state = await (await engine.factory.probeDefaults({ workspace: WORKSPACE, mode: 'plan' })).state();
  expect(state.model).toMatchObject({ provider: 'opencode-go', id: 'flint-40b-free' });
});

it('keeps an explicitly picked model over any agent default', async () => {
  const { engine } = engineWith();
  const model: ModelRef = { provider: 'opencode-go', id: 'flint-40b-free', name: 'Flint' };
  const state = await (await engine.factory.probeDefaults({ workspace: WORKSPACE, model, mode: 'build' })).state();
  expect(state.model).toMatchObject({ id: 'flint-40b-free' });
});

it('uses the server fallback when the agent model is not in the catalog', async () => {
  const { engine } = engineWith({ agentModel: { id: 'missing', providerID: 'opencode-go' } });
  const state = await (await engine.factory.probeDefaults({ workspace: WORKSPACE })).state();
  expect(state.model).toMatchObject({ id: 'flint-40b-free' });
});

it('reports no model when neither the agent nor the fallback resolves', async () => {
  const { engine } = engineWith({ models: [], defaultModel: undefined });
  const state = await (await engine.factory.probeDefaults({ workspace: WORKSPACE })).state();
  expect(state.model).toBeUndefined();
});

it('reloads the location before a probe when the config signature changed', async () => {
  const { engine, api, touchConfig } = engineWith({ owned: true, configDir: tempConfigDir });
  // The first probe seeds the signature; no reload yet.
  await (await engine.factory.probeDefaults({ workspace: WORKSPACE })).state();
  expect(api.calls.map((call) => call.path)).not.toContain('/location/reload');

  touchConfig(); // writes the config or bumps its mtime
  await (await engine.factory.probeDefaults({ workspace: WORKSPACE })).state();
  const paths = api.calls.map((call) => call.path);
  expect(paths).toContain('/location/reload');
  expect(paths.lastIndexOf('/location/reload')).toBeLessThan(paths.lastIndexOf('/model'));
});
```

`engineWith` grows options `agentModel`, `models`, `defaultModel`, `owned`, and `configDir`; it also returns `touchConfig`, which rewrites `<configDir>/opencode.json` and bumps its mtime. Use a `mkdtempSync` directory so no test reads the machine's real config.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:libs && npm run test -w @morse/integration-opencode -- src/opencode-engine.spec.ts`
Expected: FAIL with `state.model` undefined and `probeDefaults` ignoring `mode`.

- [ ] **Step 3: Implement the contract and the factory**

- `ports.ts`: add `readonly defaultEngineKind?: string`, the two optional factory methods and `refreshConfig?()` to `AgentGateway`, with comments matching the design's vocabulary. `AgentRouter` already has the getter, so it satisfies the property.
- `opencode-engine.ts`: add `env` to `OpenCodeEngineDeps`; construct one `OpenCodeConfigGuard` in the constructor; pass it to `OpenCodeAgentFactory`. Pass `env` through `createOpenCodeEngine` and `createBotOpenCodeEngine` so the guard stats the same config tree the server reads.
- `OpenCodeAgentFactory`: implement `configSignature` (`guard.signature(workspace.cwd)`) and `reloadConfig` (`guard.reloadNow(cwd)`, then `true` — this engine has a config, so the request was performed), and pass `guard` into `OpenCodeAgent.open`.
- `probeDefaults`: accept `mode`; call `guard.ensureFresh(input.workspace.cwd)`; read `readAgentCatalog`; resolve the selected model as agent model → `/model/default` → unset; append the default model only when `/model/default` is used. Keep an explicit `input.model` winning.
- `opencode-agent.ts`: add `guard?: OpenCodeConfigGuard` to `OpenCodeAgentOptions` and store it; do not change model behavior yet.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build:libs && npm run test -w @morse/integration-opencode -- src/opencode-engine.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/ports.ts packages/integration-opencode/src/opencode-engine.ts packages/integration-opencode/src/opencode-agent.ts packages/integration-opencode/src/opencode-engine.spec.ts
git commit -m "feat(opencode): resolve the draft model from the effective agent"
```

---

### Task 4: Name the model on fresh sessions, mode switches and reloads

**Files:**
- Modify: `packages/integration-opencode/src/opencode-agent.ts:226-281, 386-460, 828-934, 1025-1075`
- Test: `packages/integration-opencode/src/opencode-agent.spec.ts`

**Interfaces:**
- Consumes: `readAgentCatalog`, `ApiAgentModel` (Task 1); `OpenCodeConfigGuard` (Task 2); `guard` option (Task 3).
- Produces: `OpenCodeAgent.refreshConfig(): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Update the existing `claims no model before a run…` test to the new truth: a fresh session with no `model` and a `build` agent configured with `flint-40b-free` starts on that model. Keep the silent-fallback notice test.

Add:

```ts
it("seeds a fresh session with its agent's configured model", async () => {
  const { agent } = await harness({
    handler: (method, path, query) => {
      if (method === 'POST' && path === '/session') return sessionInfo({ model: undefined });
      if (method === 'GET' && /^\/session\/ses_[^/]+$/.test(path)) return sessionInfo({ model: undefined });
      return defaultHandler()(method, path, query, undefined);
    },
  });
  expect((await agent.state()).model).toMatchObject({ provider: 'opencode', id: 'flint-40b-free' });
  await agent.dispose();
});

it('replaces the model when a never-prompted session switches to another agent', async () => {
  const agents = [
    { id: 'build', name: 'Build', mode: 'primary', hidden: false, model: { id: 'flint-40b-free', providerID: 'opencode' } },
    { id: 'plan', name: 'Plan', mode: 'primary', hidden: false, model: { id: 'plain-model', providerID: 'opencode' } },
  ];
  let current = 'build';
  const { agent } = await harness({
    handler: (method, path, query, body) => {
      if (method === 'POST' && path.endsWith('/agent')) {
        current = (body as { agent: string }).agent;
        return undefined;
      }
      if (method === 'GET' && /^\/session\/ses_[^/]+$/.test(path)) {
        return sessionInfo({ agent: current, model: undefined });
      }
      if (method === 'GET' && path === '/agent') return agents;
      return defaultHandler()(method, path, query, undefined);
    },
  });
  await agent.setMode('plan');
  expect((await agent.state()).model).toMatchObject({ id: 'plain-model' });
  await agent.dispose();
});

it('refreshes catalogs without losing a still-valid current model', async () => {
  const { agent, api } = await harness();
  await agent.refreshConfig();
  expect(api.calls.some((call) => call.method === 'GET' && call.path === '/model')).toBe(true);
  expect((await agent.state()).model).toMatchObject({ id: 'flint-40b-free' });
  await agent.dispose();
});

it('keeps the session mode when a reload no longer lists it', async () => {
  const { agent } = await harness({
    handler: (method, path, query) => {
      if (method === 'GET' && /^\/session\/ses_[^/]+$/.test(path)) {
        return sessionInfo({ agent: 'plan', model: undefined });
      }
      if (method === 'GET' && path === '/agent') {
        return [{ id: 'build', name: 'Build', mode: 'primary', hidden: false }];
      }
      return defaultHandler()(method, path, query, undefined);
    },
  });
  await agent.refreshConfig();
  const state = await agent.state();
  expect(state.availableModes?.map((mode) => mode.id)).toEqual(['build']);
  expect(state.mode).toBe('plan');
  await agent.dispose();
});
```

The `harness` helper must accept `mode` and the default handler must include agent `model` fields.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:libs && npm run test -w @morse/integration-opencode -- src/opencode-agent.spec.ts`
Expected: FAIL — the fresh session still has no model and `refreshConfig` is missing.

- [ ] **Step 3: Implement the resolver and refresh**

In `opencode-agent.ts`:

- Add `private readonly agentModels = new Map<string, ApiAgentModel>()` and `private defaultMode: string | undefined`.
- In `open`, populate them from `readAgentCatalog`; compute the fallback model for the effective mode (agent model in the catalog → `/model/default` → undefined) only when `session.model` is absent, and pass it into `initialStateOf`.
- `initialStateOf(session, workspace, models, commands, modes, fallbackModel?)` uses `fallbackModel` when `session.model` is absent.
- `loadServerState`: when `session.model` is absent, resolve `session.agent ?? this.defaultMode` through `agentModels`, then `modelFor`; keep `selectedModel()` as the last resort.
- `setMode`: after the POST, `await this.refreshState()`.
- `refreshModes`: use `readAgentCatalog` and update `agentModels`/`defaultMode` only when the catalog returns at least one mode, matching the existing "an empty answer is a failed read" rule.
- Add `refreshConfig`: re-read `readAgentCatalog`, `/model`, `/command`, `/skill`; clear and repopulate the `models` map; merge `availableModels`, `availableModes`, `availableCommands`; if the current model is gone, resolve the current mode's agent model; never overwrite `state.mode` with an empty list; emit state. `refreshModels` and `refreshCommands` delegate to it.
- `mergeState` reports `patch.streaming` to `guard.setStreaming(this.engineId, ...)`; `dispose` calls `guard.forget(this.engineId)`; `adoptSession` transfers the tracked id.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build:libs && npm run test -w @morse/integration-opencode -- src/opencode-agent.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/integration-opencode/src/opencode-agent.ts packages/integration-opencode/src/opencode-agent.spec.ts
git commit -m "feat(opencode): name the model a fresh session will use"
```

---

### Task 5: Draft cache follows mode, project and config signature

**Files:**
- Modify: `packages/system/src/session/service.ts:100-222, 632-694`
- Test: `packages/system/src/session/service.spec.ts`

**Interfaces:**
- Consumes: `AgentGatewayFactory.defaultEngineKind?`, `configSignature?` and `reloadConfig?` (Task 3).
- Produces: `draftDefaults(engine?: string, model?: ModelRef, mode?: string, workspace?: WorkspaceRef): Promise<AgentSessionState | undefined>`
- Produces: `cachedDraftDefaults(engine?: string, model?: ModelRef, mode?: string, workspace?: WorkspaceRef): AgentSessionState | undefined`
- Produces: `reloadAgentConfig(options?: { engine?: string; cwd?: string; force?: boolean }): Promise<{ reloaded: boolean; requiresConfirmation?: boolean; running: number }>`

- [ ] **Step 1: Write the failing tests**

Extend `FakeFactory` with `signature` and `probes` recording `mode`/`workspace.cwd`, plus `reloads` and an optional `refreshConfig` on `FakeGateway`.

```ts
it('keys a draft probe by mode, project and config signature', async () => {
  const factory = new FakeFactory();
  const a = await sessions.draftDefaults('opencode', undefined, 'build', WORKSPACE);
  await sessions.draftDefaults('opencode', undefined, 'plan', WORKSPACE);
  await sessions.draftDefaults('opencode', undefined, 'build', { cwd: '/work/other', name: 'other' });
  expect(factory.probed).toHaveLength(3);
  factory.signature = 'v2';
  await sessions.draftDefaults('opencode', undefined, 'build', WORKSPACE);
  expect(factory.probed).toHaveLength(4);
  expect(a?.mode).toBe('opencode:none');
});

it('probes the drafted project, not the host default', async () => {
  const factory = new FakeFactory();
  await sessions.draftDefaults('opencode', undefined, 'build', { cwd: '/work/other', name: 'other' });
  expect(factory.probed.at(-1)?.workspace).toBe('/work/other');
});

it('warns before reloading while that engine streams, then reloads on force', async () => {
  const factory = new FakeFactory('opencode');
  const sessions = registry(factory);
  const opened = await sessions.open({ engine: 'opencode' });
  sessions.emitForTest(opened.key, { streaming: true }); // existing test hook or set state
  await expect(sessions.reloadAgentConfig({ engine: 'opencode' })).resolves.toEqual({
    reloaded: false,
    requiresConfirmation: true,
    running: 1,
  });
  expect(factory.reloads).toBe(0);
  await expect(sessions.reloadAgentConfig({ engine: 'opencode', force: true })).resolves.toEqual({
    reloaded: true,
    running: 1,
  });
  expect(factory.reloads).toBe(1);
});
```

If there is no existing eager way to mark a fake session streaming, add a test-only `setStreaming` on `FakeGateway` or emit an `agent/state` event through the existing gateway test helpers.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:libs && npm run test -w @morse/system -- src/session/service.spec.ts`
Expected: FAIL — the new parameters and `reloadAgentConfig` do not exist.

- [ ] **Step 3: Implement**

- `draftKey` takes an object and includes `engine`, `model.provider/id`, `mode`, `workspace.cwd`, `signature`.
- `draftSignature(engine, workspace)` calls `factory.configSignature?.({workspace, engine}) ?? ''`.
- Before a cache lookup, compare the signature per `engine|cwd`; a change clears `draftCache`/`draftProbes`.
- `probeDraft` uses the passed workspace (falling back to `defaultWorkspace`) and forwards `mode`.
- `reloadAgentConfig` resolves `engine ?? factory.defaultEngineKind` first, counts `state.streaming` for that engine, gates on `force`, calls `factory.reloadConfig` when the factory has one (and returns `{ reloaded: false, running }` when it does not), and — only when the answer was not `false` (this engine has no config to reload) — clears the draft maps and awaits `refreshConfig?.()` on hot gateways of that engine (logging failures). A host with two engines must never count a pi turn against an OpenCode reload.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build:libs && npm run test -w @morse/system -- src/session/service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/session/service.ts packages/system/src/session/service.spec.ts
git commit -m "feat(sessions): key draft probes by mode, project and config"
```

---

### Task 6: Router delegation and the `reloadConfig` engine capability

**Files:**
- Modify: `packages/system/src/session/agent-router.ts:51-137, 247-273`
- Modify: `packages/protocol/src/dto/host.ts:9-16`
- Test: `packages/system/src/session/agent-router.spec.ts`

**Interfaces:**
- Consumes: `configSignature?` / `reloadConfig?` on the engine factory (Task 3).
- Produces: `EngineDescriptor.reloadConfig?: boolean`
- Produces: `EngineOption.reloadConfig?: boolean`
- Produces: `AgentRouter.configSignature(options: { workspace: WorkspaceRef; engine?: string }): string`
- Produces: `AgentRouter.reloadConfig(options: { engine?: string; cwd?: string }): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

```ts
it('reports which engines can reload their config', () => {
  const router = new AgentRouter({ store, defaultWorkspace: WORKSPACE, logger: silentLogger });
  router.register(piEngine, { label: 'pi' });
  router.register(openCodeEngine, { label: 'OpenCode', default: true });
  expect(router.engineOptions()).toEqual([
    { kind: 'pi', label: 'pi' },
    { kind: 'opencode', label: 'OpenCode', default: true, reloadConfig: true },
  ]);
});

it('delegates configSignature and reloadConfig to the chosen engine', async () => {
  const signature = vi.fn(() => 'v1');
  const reload = vi.fn(() => Promise.resolve(true));
  const engine = engineWithFactory({ configSignature: signature, reloadConfig: reload });
  const router = new AgentRouter({ store, defaultWorkspace: WORKSPACE, logger: silentLogger });
  router.register(engine, {});
  expect(router.configSignature({ workspace: WORKSPACE })).toBe('v1');
  await expect(router.reloadConfig({ cwd: WORKSPACE.cwd })).resolves.toBe(true);
  expect(reload).toHaveBeenCalledWith({ cwd: WORKSPACE.cwd });
});

it('forwards a draft mode to probeDefaults', async () => {
  const probe = vi.fn(() => Promise.resolve(probeGateway));
  const engine = engineWithFactory({ probeDefaults: probe });
  const router = new AgentRouter({ store, defaultWorkspace: WORKSPACE, logger: silentLogger });
  router.register(engine, {});
  await router.probeDefaults({ workspace: WORKSPACE, mode: 'plan' });
  expect(probe).toHaveBeenCalledWith({ workspace: WORKSPACE, mode: 'plan' });
});
```

Use the spec's existing fake engine/store builders; add a factory-options helper rather than a new fixture if one exists.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:libs && npm run test -w @morse/system -- src/session/agent-router.spec.ts`
Expected: FAIL — `reloadConfig` is absent from `engineOptions` and the router.

- [ ] **Step 3: Implement**

- `EngineDescriptor` and `EngineOption` gain `reloadConfig?: boolean`.
- `engineOptions()` sets it when `entry.engine.factory.reloadConfig !== undefined`.
- `AgentRouter.configSignature` resolves the named/default engine and calls its factory's optional method, returning `''` when absent.
- `AgentRouter.reloadConfig` resolves the engine and awaits its factory's optional method, returning `false` when no engine resolves or the factory has none, so the caller never reports a reload that did not happen.
- `probeDefaults` forwards `mode`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build:libs && npm run test -w @morse/system -- src/session/agent-router.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/system/src/session/agent-router.ts packages/system/src/session/agent-router.spec.ts packages/protocol/src/dto/host.ts
git commit -m "feat(sessions): expose an engine's config reload capability"
```

---

### Task 7: Host command, draft workspace and mode re-probe

**Files:**
- Modify: `packages/protocol/src/wire/host.ts:28-130`
- Modify: `packages/system/src/host/session-controller.ts:1010-1053, 1899-2010, 2115-2185, 2725-2735`
- Test: `packages/system/src/host/session-controller.spec.ts`

**Interfaces:**
- Consumes: `SessionRegistry.draftDefaults(engine?, model?, mode?, workspace?)` and `reloadAgentConfig` (Task 5).
- Produces: `HostCommand` includes `'reloadAgentConfig'`; args `{ force?: boolean }`; answer `{ reloaded: boolean; requiresConfirmation?: boolean; running: number }`.
- Produces: `warmDraft` passes `this.draftWorkspace` and `this.draftMode`.

- [ ] **Step 1: Write the failing tests**

```ts
it('warns before reloading agent config while a session runs', async () => {
  const h = harness({ streaming: true, reloadConfig: true });
  await h.controller.handleClientMessage({
    type: 'host/command',
    payload: { command: 'reloadAgentConfig', requestId: 'r1' },
  });
  expect(resultOf(h.messages, 'r1')).toEqual({
    reloaded: false,
    requiresConfirmation: true,
    running: 1,
  });
  expect(h.reloads()).toBe(0);
});

it('forces the reload and re-probes the draft', async () => {
  const h = harness({ streaming: true, reloadConfig: true });
  await h.controller.handleClientMessage({
    type: 'host/command',
    payload: { command: 'reloadAgentConfig', args: { force: true }, requestId: 'r1' },
  });
  expect(h.reloads()).toBe(1);
  expect(resultOf(h.messages, 'r1')).toMatchObject({ reloaded: true });
  expect(h.probes()).toBeGreaterThan(0);
});

it('probes a draft with the drafted project and mode', async () => {
  const h = harness({ probeState: true });
  await h.controller.handleClientMessage({
    type: 'session/new',
    payload: { cwd: '/work/other' },
  });
  await h.controller.handleClientMessage({ type: 'mode/set', payload: { mode: 'plan' } });
  expect(h.createdProbe().workspace.cwd).toBe('/work/other');
  expect(h.createdProbe().mode).toBe('plan');
});
```

Use the spec's existing message harness; add `reloadConfig`/`refreshConfig` options to `fakeGateway` and `factory`, and a `reloadConfig` spy to the factory. Add a small `resultOf(messages, requestId)` helper that finds the `host/command/result` with that id and returns its `payload.data`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:libs && npm run test -w @morse/system -- src/host/session-controller.spec.ts`
Expected: FAIL — the command is unsupported and the draft probe ignores workspace/mode.

- [ ] **Step 3: Implement**

- Add `'reloadAgentConfig'` to `HostCommand`.
- In `runHostCommand`, intercept it beside `searchSessions`: resolve the engine and cwd from the active session or draft, call `registry.reloadAgentConfig`, answer the result, emit an info notice on success, and re-probe the draft (`warmDraft`) or `emitState` for a warm session.
- `warmDraft`: call `draftDefaults(engine, model, this.draftMode, this.draftWorkspace ?? registry.defaultWorkspace)`.
- Draft `setModel`/`refreshDraftCatalog`: forward `draftMode` and the draft workspace to `cachedDraftDefaults`/`draftDefaults`.
- Draft `setMode`: after setting `draftMode`, clear the probe cache and `await this.warmDraft()` so the model follows the mode.
- `draftProbeIsCurrent` compares the workspace too, so a probe for project A cannot land after the reader moved to B.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build:libs && npm run test -w @morse/system -- src/host/session-controller.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/wire/host.ts packages/system/src/host/session-controller.ts packages/system/src/host/session-controller.spec.ts
git commit -m "feat(host): reload agent config from the composer"
```

---

### Task 8: Composer reload button and warning

**Files:**
- Modify: `packages/ui-angular/src/app/features/composer/composer.ts:285-315, 1600-1700`
- Modify: `packages/ui-angular/src/app/features/composer/composer.html:460-540`
- Modify: `packages/ui-angular/src/app/features/composer/composer.css`
- Test: `packages/ui-angular/src/app/features/composer/composer.config-reload.spec.ts`

**Interfaces:**
- Consumes: `HostCapabilities.engines[].reloadConfig` (Task 6) and the `reloadAgentConfig` host command (Task 7).

- [ ] **Step 1: Write the failing tests**

Copy the transport/mount helpers from `composer.engine-mode.spec.ts`. Add a transport that answers `reloadAgentConfig` with a queued reply and records requests.

```ts
const CAPABLE: HostCapabilities = {
  ...TWO_ENGINES,
  engines: [{ kind: 'opencode', label: 'OpenCode', default: true, reloadConfig: true }],
};

it('shows the reload control only for an engine that offers it', async () => {
  const yes = await mount(new ReloadTransport(CAPABLE, state()));
  expect(yes.host.querySelector('.reload-config')).not.toBeNull();

  const no = await mount(new ReloadTransport(TWO_ENGINES, state()));
  expect(no.host.querySelector('.reload-config')).toBeNull();
});

it('warns with the running count, then forces on confirm', async () => {
  const transport = new ReloadTransport(CAPABLE, state());
  transport.replies.push({ reloaded: false, requiresConfirmation: true, running: 2 });
  const { fixture, host } = await mount(transport);
  (host.querySelector('.reload-config') as HTMLButtonElement).click();
  await fixture.whenStable();
  fixture.detectChanges();
  expect(host.querySelector('.reload-warning')?.textContent).toContain('2 sessions are running');
  expect(transport.commands.at(-1)).toMatchObject({ command: 'reloadAgentConfig', args: {} });

  (host.querySelector('.reload-confirm') as HTMLButtonElement).click();
  await fixture.whenStable();
  expect(transport.commands.at(-1)).toMatchObject({ command: 'reloadAgentConfig', args: { force: true } });
});

it('cancels without sending a forced reload', async () => {
  const transport = new ReloadTransport(CAPABLE, state());
  transport.replies.push({ reloaded: false, requiresConfirmation: true, running: 1 });
  const { fixture, host } = await mount(transport);
  (host.querySelector('.reload-config') as HTMLButtonElement).click();
  await fixture.whenStable();
  fixture.detectChanges();
  (host.querySelector('.reload-cancel') as HTMLButtonElement).click();
  fixture.detectChanges();
  expect(host.querySelector('.reload-warning')).toBeNull();
  expect(transport.commands).toHaveLength(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run check-types -w @morse/protocol && npm run test -w @morse/ui-angular -- --include src/app/features/composer/composer.config-reload.spec.ts`
Expected: FAIL — no `.reload-config` element.

- [ ] **Step 3: Implement**

- `composer.ts`: `protected readonly canReloadConfig = computed(() => this.engines().find(e => e.kind === this.currentEngine())?.reloadConfig === true)`, `reloadWarning = signal<{running: number} | undefined>(undefined)`, `reloadingConfig = signal(false)`, and the three handlers. Send `this.morse.requestHostCommand('reloadAgentConfig', {})`, then `{ force: true }` on confirm.
- `composer.html`: a `<button type="button" class="icon reload-config" title="Reload agent configuration" aria-label="Reload agent configuration" [disabled]="reloadingConfig()" (click)="onReloadConfig()">⟳</button>` beside the thinking picker, and the warning block above `.controls`:

```html
@if (reloadWarning(); as warning) {
  <div class="reload-warning" role="alert">
    <span>{{ warning.running }} session{{ warning.running === 1 ? '' : 's' }} are running. Reloading agent configuration also cancels pending permission and form prompts. Running turns continue at their next step.</span>
    <button type="button" class="reload-confirm" (click)="confirmReloadConfig()">Reload anyway</button>
    <button type="button" class="reload-cancel" (click)="cancelReloadConfig()">Cancel</button>
  </div>
}
```

- `composer.css`: match the existing footer/notice rhythm; keep the warning one row above the controls and the icon the same size as the thinking trigger.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -w @morse/ui-angular -- --include src/app/features/composer/composer.config-reload.spec.ts`
Expected: PASS. If the Angular builder rejects `--include`, run `npm run test -w @morse/ui-angular` and confirm the new spec passes.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/features/composer/
git commit -m "feat(ui): add agent config reload with a running-session warning"
```

---

### Task 9: Document the behavior

**Files:**
- Modify: `docs/STATUS.md:52-70`
- Modify: `docs/CONFIGURATION.md:76-100`

**Interfaces:**
- None.

- [ ] **Step 1: Update `docs/STATUS.md`**

Replace the "fresh draft claims no model" paragraph with: a fresh draft names the effective agent's configured model, validated against the catalog; it falls back to `/api/model/default`; `no model` remains only when neither resolves. Add a line that a config change reaches the next new session without restarting, and that the composer's reload control exists.

- [ ] **Step 2: Update `docs/CONFIGURATION.md`**

In the Modes/Default-mode section, state:

- The draft and a fresh session name the effective agent's model (global or project `default_agent`), not `/api/model/default` first.
- Switching Build → Plan (or any custom primary agent) in a draft follows that agent's model.
- `opencode.json[c]` changes are picked up automatically before the next new session; a running session's next turn uses the server's refreshed config.
- The composer's ⟳ control reloads every loaded location; when sessions are running it warns first and says pending forms/permissions are cancelled.

- [ ] **Step 3: Verify the docs render and link**

Run: `grep -n "reload agent configuration\|effective agent\|default_agent" docs/STATUS.md docs/CONFIGURATION.md`
Expected: the new lines appear, and no stale "shows `no model` until the reader picks one" sentence remains.

- [ ] **Step 4: Commit**

```bash
git add docs/STATUS.md docs/CONFIGURATION.md
git commit -m "docs: explain default model resolution and config reload"
```

---

### Task 10: Full verification

**Files:**
- None expected; fix anything the suite finds.

- [ ] **Step 1: Build the libraries**

Run: `npm run build:libs`
Expected: exit 0.

- [ ] **Step 2: Run the OpenCode adapter suite**

Run: `npm run test -w @morse/integration-opencode`
Expected: all pass.

- [ ] **Step 3: Run the fast suite**

Run: `npm run test:fast`
Expected: all pass.

- [ ] **Step 4: Type-check every workspace**

Run: `npm run check-types`
Expected: exit 0.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "test: verify agent config freshness end to end"
```

If there is nothing to fix, skip the commit.

---

## Self-Review

**Spec coverage**

- Agent catalog + model resolution: Tasks 1, 3, 4.
- Draft state/model and mode follow: Tasks 3, 4, 5, 7.
- Fresh session state and mode switch: Task 4.
- Draft cache mode/workspace/signature: Task 5.
- Config guard, idle reload, attached-server rule: Task 2, wired in Task 3.
- Factory capability and no `AgentExtras`: Tasks 3, 6.
- Host command warning/force: Task 7.
- Manual composer control: Task 8.
- Docs: Task 9.
- Tests: each task plus Task 10.

**Type consistency**

- `defaultEngineKind` is on the factory in Task 3 and consumed in Task 5.
- `configSignature` is synchronous in Tasks 2, 3, 5, 6.
- `reloadConfig` takes `{ engine?, cwd? }` in Tasks 3, 5, 6.
- `refreshConfig()` is on `AgentGateway` in Tasks 3, 4, 5.
- `draftDefaults` order is `(engine, model, mode, workspace)` in Tasks 5 and 7.
- `reloadAgentConfig` returns `{ reloaded, requiresConfirmation?, running }` in Tasks 5, 7, 8.

**Review Focus tests**

Each Review Focus line names the task whose test pins it: Task 4 (removed mode), Task 2 (streaming), Task 5 (project switch), Task 3 (fallback), Task 2 (attached).

**Proportion**

The plan pins interfaces, test names and assertions; implementation bodies stay with the builder. The largest tasks (2, 4) carry the two new state machines, which the spec left as builder work except for their observable rules.
