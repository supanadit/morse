# Design

## Context

See `proposal.md` for motivation.

The host already keeps an intentional **draft** before the first prompt (`isDraft`,
`draftWorkspace`, `draftCatalog`, pending model and thinking picks). The draft catalog comes from a
session-less probe; for pi that is a `--no-session` spawn, for OpenCode a set of catalog reads. The
probe is cached per model and re-read when a draft picker asks for it.

Engine creation currently has no choice: `AgentRouter.create` always uses its registered default
kind, and `probeDefaults` probes that same kind. `SessionViewState` carries one session's model,
thinking levels and commands; `HostCapabilities` describes the host's static abilities.

OpenCode 2.1.4 exposes `GET /api/agent?location[directory]=…` (primary agents include `build` and
`plan`; hidden and subagent agents are also listed), `POST /api/session` with an optional `agent`,
`POST /api/session/{id}/agent` to switch a live session, and `GET /api/model/default` for the model
a new session would use. `GET /api/config?location[directory]=…` returns the configuration
documents from lowest to highest priority, and OpenCode resolves `default_agent` from the last
document that sets it. `/api/agent` orders the resolved default primary agent first. Responses are wrapped in `{ data }`; the query
must be the deep-object `location[directory]`, because a bare `directory` resolves the server's
own location instead.

## Goals / Non-Goals

**Goals:**

- Let a user with several installed engines choose the engine per new conversation.
- Surface the modes the selected engine offers, and let an OpenCode conversation change mode while
  it runs.
- Keep the choice inside the existing draft/probe design so a first prompt opens the right session
  with the right catalogs.
- Keep the mode list and its default owned by OpenCode's configuration, not by a fixed Morse list.
- Keep pi behaviour and every existing wire consumer working without a protocol bump.

**Non-Goals:**

- Moving a running or persisted conversation between engines. The engine is fixed when the session
  is created.
- Persisting the chosen engine across host restarts. `MORSE_ENGINE` / `morse.engine` remains the
  startup default; the picker is a per-host-session preference.
- A Morse-side mode editor. Modes are OpenCode's primary agents, defined in OpenCode configuration.
- A fixed list of modes or a Morse-chosen default. Both come from OpenCode's configuration.
- Giving pi modes it does not have, or faking an empty mode list.

## Decisions

### D1 — Modes are harness-contract vocabulary, not OpenCode-specific

Add `AgentMode { id, name, description?, default? }` to `@morse/agent`, plus optional `mode` and
`availableModes` on the session state, an optional `setMode` on the gateway and an optional `mode`
on the factory's create input. The `default` marker lets the harness name the default it resolved
without the application inferring one.

Rationale: model and thinking selection already work this way; a frontend should not learn an
OpenCode-specific state field. pi simply omits the fields and operation.

Alternatives considered: putting modes in OpenCode-specific extras (leaks the engine into the
shared composer); encoding the mode in prompt text (not observable as state and not switchable).

### D2 — Static engine catalog on capabilities, dynamic choice on session state

`HostCapabilities` gains `engines: EngineOption[]` with `{ kind, label, default? }`.
`SessionViewState` gains `draft`, `engine`, `mode`, `availableModes` and `loadingEngine`.

Rationale: the installed engines are fixed at host startup, so they belong with the handshake;
the draft's choice and the session's mode change over time, so they belong in the state the host
already emits on every change. No extra round trip is needed to paint the picker.

Alternatives considered: a `host/command` query (latency, another failure path); hardcoding
`pi`/`opencode` in the frontend (breaks the engine-agnostic boundary).

### D3 — Engine changes go through `engine/set`, not the session/new payload

The composer sends `engine/set` when the user picks an engine, and `session/new` / `project/open`
stay as they are. The controller stores the draft engine and re-probes it.

Rationale: switching engines must replace the model/mode catalogs *before* the user sends; a
payload on creation would leave the pickers showing the old engine until the session exists. It
also keeps "new session here" navigation independent of the picker.

Alternatives considered: passing `engine` on `session/new` and probing synchronously on arrival
(the draft has already painted the wrong catalog); a client-side cache of every engine's catalog
(duplicates host state and ages).

### D4 — Probe and create are engine-aware; the draft cache is keyed by engine + model

`AgentRouter.probeDefaults` accepts an engine kind, and `SessionRegistry.draftDefaults` keys its
cache and in-flight map by `(engine, model)`. The controller uses a monotonically increasing ticket
to discard a probe answer that belongs to an engine the user has already left.

Rationale: model ids, thinking variants and modes are different per engine, so a shared cache key
would hand pi's catalog to OpenCode. The ticket prevents a slow answer from overwriting a newer
choice — the same pattern the model picker already uses for thinking levels.

Alternatives considered: clearing the cache on each switch (still races with an in-flight probe);
serialising switches (makes a quick pi → OpenCode → pi feel stuck).

### D5 — The engine is sticky across drafts; the mode is per draft

After a session opens, the chosen engine stays selected for the next draft in this host session.
The mode is consumed by the created session and the next draft starts on the engine's resolved
default. A live mode switch does not change the draft preference.

Rationale: the engine is a broader working preference; the mode belongs to a conversation, and
OpenCode itself starts new conversations on its default agent.

Alternatives considered: resetting both (annoying for engine); keeping both sticky (a Plan choice
would silently become the default for unrelated later conversations).

### D6 — Creation carries `agent` only when the user chose one; switching uses the live endpoint

OpenCode creation posts `agent` when the user chose one, and omits the field when the draft is
left on the resolved default so OpenCode applies its own configuration. A live switch posts
`/session/{id}/agent`, merges the result into state, and a state refresh reads `session.agent` so
another OpenCode client's change is observed rather than overwritten.

Rationale: OpenCode owns the agent on its session record and its configuration owns the default;
mirroring either in a Morse-only field would desynchronise the two clients. Omitting the field
also means a config change between the probe and creation is honored by the server.

Alternatives considered: always sending the resolved default (forces a possibly stale value over
the user's config); re-creating a session to change mode (loses history); sending a synthetic
prompt (changes the conversation).

### D7 — The default mode is resolved from OpenCode, never hardcoded

The resolved default comes from OpenCode's own configuration: find the last `/api/config`
document that sets `default_agent` (the same rule OpenCode applies), and otherwise use the first
primary agent in `/api/agent`'s order, which is where the server places its resolved default. The
result is reported as the current mode and marked as the default in the list. Morse never
substitutes a fixed `build` or `plan`.

When the user has not changed the mode, creation omits `agent` and lets OpenCode apply its own
default. When the user picks a mode, that id is sent explicitly.

Rationale: the user asked for the mode list and its default to follow `opencode.json` and agent
files. Verified against 2.1.4: setting `default_agent` to `plan` makes `/api/config` report it and
moves `plan` to the front of the primary list; with no setting, `build` is first because it is
OpenCode's own default, not because Morse chose it.

Alternatives considered: hardcoding `build` (wrong when the user configures another default);
reading only `/api/agent` order (explicit config is clearer and survives an ordering change);
reading only config documents (loses the built-in fallback when nothing is set).

### D8 — A draft reports OpenCode's default model

The OpenCode probe and a fresh session read `/api/model/default` when no model was chosen, and use
it for the model, thinking levels and default variant. A failure degrades to the catalog without a
selected model.

Rationale: switching the draft to OpenCode otherwise shows "no model" beside a populated model
list, which makes the new engine picker look broken. The default is what the server will use for
the first prompt.

Alternatives considered: picking the catalog's first model (not necessarily the default); leaving
it empty (current, confusing behaviour).

### D9 — One reusable option picker; engine only in a draft, mode whenever offered

The UI adds a small self-contained `morse-option-picker` (keyboard, outside-click, loading) and
uses it twice. The engine pill appears only when `draft` is true and at least two engines are
reported. The mode pill appears whenever `availableModes` is non-empty, so an OpenCode conversation
can switch mid-run. It renders exactly the list the host reports — no built-in `plan`/`build`
entries — and opening it sends `modes/refresh`, so a config change is picked up.

Rationale: a draft is the only place an engine can change, while a mode can change at any time in
OpenCode (its Tab key). Reusing one picker keeps styling and keyboard behaviour consistent with the
thinking picker; rendering the host's list keeps the modes and default owned by OpenCode.

Alternatives considered: two bespoke components (duplicate behaviour); a native `<select>` (OS
popup ignores the Morse/VS Code theme); hiding modes after the first prompt (contradicts the chosen
behaviour).

### D10 — Additive wire changes without a protocol bump

All new state/capability fields are optional and the three client messages are additive. The
frontend bundle and host ship together, so no existing message changes shape.

Rationale: an older host ignores unknown client messages and an older frontend ignores unknown
fields; bumping the protocol would reject working pairs for no compatibility gain.

Alternatives considered: bumping `PROTOCOL_VERSION` to 38 (would force a rebuild for an additive
change).

### D11 — Validate mode ids at the boundary

A draft mode must be one of the probe's offered ids; a live switch must be one of the session's
offered ids. Invalid choices are refused with a reason and leave the current mode and session
untouched.

Rationale: the UI only offers valid ids, but the host is the boundary that protects the engine
from a stale picker or a hand-written client.

Alternatives considered: trusting the server's 400 (the failure would be less actionable and later
than the pick).

### D12 — Engine labels live on the router registration

`register(engine, { label })` records the display name; `engineOptions()` returns kind, label and
default. Both hosts pass `pi` and `OpenCode`.

Rationale: labels are host presentation, not harness behaviour; keeping them out of
`SessionEngine` avoids turning the contract into UI vocabulary.

Alternatives considered: a `label` on every engine class (couples adapters to wording); deriving
from `kind` (cannot spell `OpenCode`).

## Risks / Trade-offs

- **Default resolution relies on config precedence plus OpenCode's agent order** → an explicit
  `default_agent` in the last config document wins; when none is set, the first primary agent is
  used because the server places its resolved default first. If a future server changes that
  ordering, the fallback could disagree until the session reports its agent. Mitigation: never
  hardcode an id; omit `agent` when the user made no choice, so the server's own default always
  applies; tests cover both explicit and fallback resolution.
- **Switching engines discards a pending model/thinking/mode pick** → this is deliberate because
  catalogs differ. Mitigation: a visible loading state and a held Send while the new catalog
  lands.
- **A slow probe can answer after the user moved on** → the per-engine ticket ignores stale
  answers. Mitigation: covered by controller tests with deferred probes.
- **Four pills crowd a narrow composer** → container queries collapse or wrap the metrics row.
  Mitigation: layout tests at the narrow breakpoint.
- **A mode switch while a turn is running may be refused by OpenCode** → the error is surfaced and
  the state keeps the old mode. Mitigation: no optimistic state change.
- **Custom project agents require the deep-object `location[directory]` query** → using a bare
  `directory` would silently resolve the server's own location. Mitigation: mapping tests assert
  the query shape.
- **OpenCode applies configuration changes asynchronously** → `modes/refresh` reads whatever the
  server currently reports; a change the server has not loaded yet appears on the next refresh or
  new session. Mitigation: documented behaviour, a refresh on picker open, and a fresh read when a
  session is opened.

## Migration Plan

No data migration. The index and session records are unchanged. Existing sessions open in the
engine their record already names. A host that cannot initialize OpenCode reports only the engines
it can start. Rolling back removes the optional fields and messages; sessions created through the
new picker remain ordinary pi/OpenCode sessions.

## Open Questions

None. The mode list and default resolution were verified against OpenCode 2.1.4 (`/api/agent`,
`/api/config` and `default_agent`), and the fallback is recorded as a trade-off rather than an open
decision.
