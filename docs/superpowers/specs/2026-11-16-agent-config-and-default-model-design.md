# Agent config freshness and the real default model

Date: 2026-11-16
Status: proposed

## Intent

A new Morse session should start on the model OpenCode will actually use, and should show that
model before the first message — not `no model`. The answer must follow the *effective* agent:
the `default_agent` from the global config, a project override, or any primary agent the reader
defined (Build, Plan, a custom one).

Configuration edited while Morse runs must reach the next new session without restarting Morse or
the OpenCode server. The reader also needs a manual "reload agent configuration" control, with a
warning when a session is running.

## What is wrong today

1. `probeDefaults` (`packages/integration-opencode/src/opencode-engine.ts`) reports a model only
   when the caller passed one. A draft therefore ships `model: undefined`.
2. `initialStateOf` (`packages/integration-opencode/src/opencode-agent.ts`) reads only
   `session.model`, which OpenCode leaves empty until the first prompt.
3. `readDefaultModel` asks `GET /api/model/default`. On this machine that endpoint answers
   `opencode-go/qwen4-max` (the first catalog model) while `default_agent: build` is configured
   with `opencode-go/deepseek-v4.1-flash`. It is not agent-aware.
4. `/api/agent` already returns `model` per agent, but `ApiAgent` does not read it.
5. The draft probe is cached per `(engine, model)` in `SessionRegistry.draftCache`; it has no
   `mode` and is cleared only on dispose or when a picker opens. A new draft can therefore show a
   stale mode/model list after a config edit even though the server reloaded.
6. OpenCode 2.2.7 already watches and reloads both `~/.config/opencode/opencode.json` and a
   project `.opencode/opencode.json` (verified on this machine: a new agent appeared in
   `/api/agent` within seconds, no restart). Morse's own caches are the stale part, not the
   engine.

## Non-goals

- Do not stop or respawn the OpenCode server per session. The engine is one shared server for the
  whole host; attaching to a user-run server (`MORSE_OPENCODE_URL`) must never stop it. The
  router has no hot-swap for a registered engine.
- Do not guess a model. If neither the effective agent's model nor `/api/model/default` resolves
  in the catalog, the draft keeps `no model`.
- Do not change pi. It has no modes and no engine-level config reload; its existing pickers and
  draft probe stay as they are.
- Do not add per-message model stamping; that already exists.

## Approaches considered

1. **Show `/api/model/default` (rejected).** Smallest change, but on an agent-based config it
   names a model the agent never uses (Qwen4 Max instead of DeepSeek V4.1 Flash). It would make
   the composer confidently wrong.
2. **Keep `no model` and only fix freshness (rejected).** The reader still cannot see what the
   first message will use, which is the reported problem.
3. **Resolve from `/api/agent` per effective mode (chosen).** The server already resolves global
   and project config into the agent list. Read each primary agent's `model`, prefer it for the
   current mode, and fall back to `/api/model/default` only when the agent names none that the
   catalog knows. This is truthful, mode-aware, and needs no new OpenCode endpoint.
4. **Stop/restart the engine at idle (rejected).** Strongest reset, but it drops every session's
   event stream, cannot work for an attached server, and is unnecessary: OpenCode already reloads
   config. A location reload gives the same freshness at a fraction of the cost.

The owner picked 3, plus a deterministic idle reload and a manual reload button with a warning.

## Design

### 1. Model resolution

**Read the agent catalog.** Extend `ApiAgent` with
`model?: { id?: string; providerID?: string; variant?: string }`. Replace the body of
`readAgentModes` with a `readAgentCatalog(api, directory, logger)` that returns:

- `modes`: the same `AgentMode[]` (primary, non-hidden, default marked) the picker already uses.
- `defaultMode`: the id `defaultModeId()` resolves.
- `models`: a map from primary mode id to its configured model ref.

`readAgentModes` becomes a thin wrapper so `refreshModes` keeps its contract.

**Resolve the model for a mode.** A model is usable only when `/api/model` contains the same
`providerID`/`id`. Resolution order:

1. the effective agent's `model` from `/api/agent`, when the catalog has it;
2. `/api/model/default`, when the catalog has it (or appended, as today);
3. unset.

The effective agent is the explicitly selected mode, else the session's own `agent`, else the
default mode. This is what makes Build, Plan and custom agents each name their real model.

**Draft state.** `probeDefaults` gains `mode?: string`. It resolves the model for that mode and
sets `state.model`, `state.availableThinkingLevels` and `state.thinkingLevel` from it. An
explicitly passed `model` still wins, so a model the reader picked before any session exists is
preserved.

**Fresh session state.** `OpenCodeAgent` keeps the resolved `agentModels` map and default mode
from `open` (and refreshes them with the catalogs). One resolver answers "what model would this
session use?" for both the initial state and later refreshes:

1. the session's recorded model, when it has one;
2. the configured model of the session's own agent (`session.agent`), else the default agent;
3. the model already on screen.

`initialStateOf` uses it for a session with no recorded model, so a fresh draft/session names the
effective agent's model. A resumed session with a recorded model keeps it — the server is the
truth for a session that has run.

**Mode changes.** After switching agents, a running `setMode` calls `refreshState()`. Since the
server leaves `session.model` absent on a session that has never run, the resolver above fills the
new agent's model from the agent catalog; the pill changes with the mode instead of going stale.
A draft `setMode` clears the draft probe cache and re-runs `warmDraft()`, which forwards
`draftMode`; the model pill follows the mode unless the reader had explicitly picked a model.

**Draft cache.** The cache key includes `engine`, `mode`, the drafted project's `cwd`, the picked
`model`, and a **config signature** from the factory. A config edit therefore misses the cache and
reaches `probeDefaults` (which then runs `ensureFresh`). `SessionRegistry.draftDefaults` and
`cachedDraftDefaults` take `mode` and `workspace`; `warmDraft`, `setModel` (draft) and
`refreshDraftCatalog` forward both. A changed signature also clears the previous draft entries for
that engine so the map cannot grow with dead keys.

**The drafted project, not the host default.** `SessionRegistry.probeDraft` currently hard-codes
`defaultWorkspace`. That makes a project's own `default_agent`/agent models invisible to its
draft. The design fixes it: `draftDefaults` receives the workspace the draft targets,
`probeDraft` passes it to `probeDefaults`, and the cache key carries its `cwd`. This is required
for the Intent's "a project override decides the effective agent" to be true.

### 2. Deterministic freshness

**A shared config guard** lives in `integration-opencode`, constructed once per engine and shared
with `OpenCodeAgentFactory`.

- `signature(cwd)`: stat every candidate from `openCodeConfigCandidates(context, configDir, cwd)` —
  the project files in precedence order, then the app-level pair — and join `path:mtimeMs:size`, or
  `path:missing` for one that is not there, so creating the first config file is itself a change.
  The list is the same one `discoverOpenCodeConfigPaths` filters, so precedence is defined once.
- `ensureFresh(cwd)`: if the signature changed, and the engine tracks no streaming session, and
  the connection is owned, `POST /api/location/reload`, then remember the new signature. If a
  session is streaming, leave the signature stored so a later idle probe retries. If the
  connection is attached, do nothing: OpenCode's own watcher owns that server.
- `reloadNow(cwd)`: the manual path; always posts the reload, clears every stored signature, and
  works for attached servers too.
- Failures are logged and never fail a probe or a session open; the catalogs are still read.

`OpenCodeAgent` reports its streaming state to the guard from `mergeState` and releases its id on
`dispose`. `probeDefaults` calls `ensureFresh(directory)` before reading `/model`, `/agent`,
`/command` or `/skill`; that probe is where Morse *forces* the reload, so the next new session
reads catalogs the server has refreshed instead of waiting on OpenCode's own watcher.

**The capability rides the factory, not extras.** `AgentGatewayFactory` (in `@morse/agent`) gains
two optional methods and reads one optional property:

```ts
readonly defaultEngineKind?: string;
configSignature?(options: { workspace: WorkspaceRef; engine?: string }): string;
reloadConfig?(options: { engine?: string; cwd?: string }): Promise<boolean | void>;
```

`OpenCodeAgentFactory` implements both methods through the guard; pi omits them. `AgentRouter`
already exposes `defaultEngineKind`, delegates to the selected engine's factory, and reports
`reloadConfig: true` in `engineOptions()` for an engine whose factory has it. `EngineOption`
carries the flag so the frontend shows or hides the control without hardcoding engine kinds.
`SessionRegistry` uses `defaultEngineKind` to scope the running-session count when the draft has
not picked an engine yet.

This deliberately does **not** use `AgentExtras`. The VS Code composition root
(`packages/extension/src/app/main.ts`) does not register OpenCode's extras — that is what keeps
its MCP/prompt panels off — so an extras-based capability would make the reload button
browser-only. A factory capability exists in both hosts without changing what VS Code offers.

The signature is synchronous (`statSync`) because `SessionRegistry.cachedDraftDefaults` is a
synchronous lookup; a handful of local stats is cheap.

**Cache invalidation.** `SessionRegistry` gains a `reloadAgentConfig({ engine?, cwd?, force? })`
that:

1. counts hot sessions of **that engine** whose state is streaming (`engineOf(key)`):
   `/api/location/reload` only affects the OpenCode server, so a pi turn must not trigger the
   warning;
2. without `force`, returns `{ reloaded: false, requiresConfirmation: true, running }` when that
   count is above zero;
3. calls `factory.reloadConfig({ engine, cwd })` when the factory has one (`{ reloaded: false, running }`
   otherwise); `false` means this engine has no configuration to reload, so the caches and warm gateways are
   left alone and the result is `{ reloaded: false, running }`;
4. otherwise clears the draft probe caches and asks every hot gateway of that engine to
   `refreshConfig?.()`, then returns `{ reloaded: true, running }`.

`AgentGateway` gains an optional `refreshConfig?(): Promise<void>`. `OpenCodeAgent.refreshConfig`
re-reads the model, agent, command and skill catalogs, updates its internal model map, merges the
lists into the state, and keeps the current model if it still exists. `refreshModels` and
`refreshCommands` delegate to it; `refreshModes` does too. This makes the manual button update
warm sessions, not just new ones.

### 3. The manual control

Add `'reloadAgentConfig'` to the `HostCommand` union. `SessionController.runHostCommand`
intercepts it (beside `searchSessions`), resolves the engine and cwd from the active session or
the draft, calls `registry.reloadAgentConfig`, then re-probes the draft or emits the refreshed
state. On success it emits an info notice. On `requiresConfirmation` it answers with the running
count and does nothing else.

The composer footer shows a small reload icon beside the thinking picker when the current
engine's `EngineOption.reloadConfig` is true. Clicking it sends the command. If the answer asks
for confirmation, an inline warning appears above the controls:

> `2 sessions are running. Reloading agent configuration also cancels pending permission and
> form prompts. Running turns continue at their next step.`

with **Reload anyway** (sends `{ force: true }`) and **Cancel**. The warning is self-contained in
the composer, so the browser host and VS Code behave the same; no native dialog is required.
While the command runs the button spins and is disabled. A failure is reported through the
existing notice channel.

### 4. Docs

- `docs/STATUS.md`: a fresh draft now names the effective agent's model, and a config change
  reaches new sessions without a restart; the manual reload is documented.
- `docs/CONFIGURATION.md`: explain the resolution order (agent model → `/api/model/default`),
  global/project precedence, custom primary agents, and the reload control with its idle rule.

## Risks and edges

- An agent model that `/api/model` does not list is not displayed. The resolution falls back to
  `/api/model/default` when *that* is known, because it is the server's own fallback; if neither
  is known the panel keeps `no model` instead of naming a model that will not serve.
- `/api/location/reload` is server-wide, not per project. The guard only runs it when Morse tracks
  no streaming session, and only for an owned server. The manual path always says so first when
  sessions of that engine are running.
- The guard's signature covers `opencode.json[c]` only. Agent/command/skill markdown files are
  live-read by OpenCode; the manual button forces a full rebuild for those too.
- A reload while a turn is at a step boundary may still cancel a pending form. The confirmation
  copy states that explicitly.
- The draft probe now follows the drafted project. A draft that switches projects mid-probe gets
  a different cache key, so an older probe cannot land on the new project's panel.
- Name collisions: `readAgentCatalog` is a new export; nothing else in the repo uses that name.

## Tests

- `internal/catalog.spec.ts`: agent models are read; default mode resolves; custom primary
  agents keep their model; subagent/hidden agents are excluded; an agent whose model is absent
  from the catalog does not produce a model.
- `opencode-engine.spec.ts`: a draft names the default agent's model; a mode's model wins; an
  explicit `model` still wins; an unknown agent model falls back to `/api/model/default`; no
  resolvable model stays unset; the probe follows the passed workspace; `/api/location/reload`
  is called when the signature changed and nothing streams, skipped when a session streams or the
  connection is attached.
- `opencode-agent.spec.ts`: a fresh session carries the resolved model; a resumed session keeps
  its recorded model; switching mode on a never-prompted session replaces the model from the
  agent catalog; `refreshConfig` replaces catalogs and keeps a still-valid model.
- `agent-router.spec.ts`: `reloadConfig`/`configSignature` delegate to the engine factory and are
  no-ops for pi; `engineOptions` reports `reloadConfig`.
- `service.spec.ts`: draft cache keys include mode, workspace and signature; a changed signature
  misses the cache; `reloadAgentConfig` counts streaming sessions **of that engine**, refuses
  without `force`, clears the cache, and refreshes warm gateways.
- `session-controller.spec.ts`: the host command resolves engine/cwd, answers the warning, and
  forces; the draft forwards its workspace and mode; a draft mode pick re-probes.
- UI specs: the reload button appears only for a capable engine; the warning shows the count;
  confirm sends `force: true`; cancel sends nothing; failures surface as a notice.

## What is left to the builder

- Exact wording and placement of the inline warning, matching the composer's current rhythm.
- Whether the reload icon is always visible for a capable engine or only in the footer's overflow
  at narrow widths.
- The poll/stat cost of the signature on very deep workspaces; a bounded walk is acceptable if
  measurement shows a problem.
