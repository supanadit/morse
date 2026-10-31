# Tasks

## 1. Contract and protocol

- [x] 1.1 Add `AgentMode` (`id`, `name`, optional `description` and `default`) to the harness domain, add optional `mode` and `availableModes` to `AgentSessionState`, and clone the mode list in `cloneState`; verify `npm run build -w @morse/agent` and `node scripts/check-agent-boundary.mjs` pass.
- [x] 1.2 Add optional `mode` to `AgentGatewayFactory.create`, optional `setMode` and `refreshModes` to `AgentGateway`, and forward them through `RoutedGateway` only when the inner gateway has them; verify `npm run check-types --workspaces --if-present` passes with pi unchanged.
- [x] 1.3 Add protocol `EngineOption` and `ModeOption` (with an optional `default` marker), `engines` on `HostCapabilities`, and `draft`, `engine`, `mode`, `availableModes`, `loadingEngine` on `SessionViewState`; verify `npm run build -w @morse/protocol` succeeds and the protocol `SessionViewState` fixtures in `packages/protocol` still typecheck.
- [x] 1.4 Add `engine/set`, `mode/set` and `modes/refresh` to the client message union and `CLIENT_MESSAGE_TYPES`; verify `npm run build -w @morse/protocol` and the wire type tests pass.
- [x] 1.5 Document the mode port in `docs/NOTES-AGENT-AGNOSTIC.md` (a harness with no modes omits them; creation and live switching are optional); verify the boundary check still passes.

## 2. Router, registry and shared host

- [x] 2.1 Add engine labels to `AgentRouter` registrations, expose `engineOptions()` with kind/label/default, accept an engine on `create`, and accept an engine on `probeDefaults`; verify `npm run test -w @morse/system` covers the chosen engine, the default fallback and an unknown engine.
- [x] 2.2 Make `SessionRegistry.open` accept `engine` and `mode`, and make `draftDefaults`/`cachedDraftDefaults` key by engine plus model; verify engine-keyed cache and open-through-chosen-engine tests pass in `npm run test -w @morse/system`.
- [x] 2.3 Add `draftEngine`, `draftMode` and `loadingEngine` to `HostSessionController`; handle `engine/set` (draft only, validate, clear incompatible picks, re-probe with a ticket), `mode/set` (draft or live), and consume the draft engine/mode when the first prompt creates the session; verify the controller spec covers stale-probe ordering, held send, cleared picks and mode refusal.
- [x] 2.4 Add `draft`, `engine`, `mode`, `availableModes` and `loadingEngine` to the draft/live view-state mapping; verify `npm run test -w @morse/system` passes for a draft view and a live OpenCode-shaped state.
- [x] 2.5 Add `ChatService.setMode` and its refusal when the active gateway has no mode operation; verify `npm run test -w @morse/system` covers the delegation and the refusal.
- [x] 2.6 Report `router.engineOptions()` in the NestJS server capabilities and in the VS Code provider capabilities; verify `npm run build -w @morse/server` and `npm run build:extension` succeed and the existing server capability tests pass.
- [x] 2.7 Update `docs/ARCHITECTURE.md` and `docs/STATUS.md` with engine selection, mode switching and the host engine catalog; verify the described fields match the protocol and controller code.

## 3. OpenCode adapter

- [x] 3.1 Add an agent mapping that reads `/api/agent?location[directory]=…` and `/api/config`, keeps exactly the primary non-hidden agents the server reports, resolves the default from the last document setting `default_agent` and otherwise from the first primary agent OpenCode reports, and hardcodes no mode id; verify `npm run test -w @morse/integration-opencode` covers filtering, an explicit `plan` default, the no-default ordering fallback, the deep-object query, a custom agent and a removed agent disappearing.
- [x] 3.2 Report `availableModes` and the resolved default/current `mode` from the probe and from a newly opened/attached session; verify the adapter tests cover a draft defaulting to a configured `plan`, a no-config default from the server's order, a session already in `plan`, and a pi-shaped state with no modes.
- [x] 3.3 Read `/api/model/default` in the probe and for a fresh session without a model, using its variant for thinking levels; verify the adapter tests cover a reported default, a missing default and a failed default request.
- [x] 3.4 Send `agent` only when the draft chose one (omit it on the resolved default so OpenCode applies its own config), implement `setMode` through `/session/{id}/agent`, and re-read `session.agent` in `loadServerState` so another client's change is observed; verify the adapter tests assert both request bodies and the merged state.
- [x] 3.5 Implement `refreshModes` by re-reading both `/api/agent` and `/api/config`, so adding, renaming, disabling or removing a primary agent and changing `default_agent` are reflected without restarting Morse; verify the adapter test covers a changed agent list, a changed default, a removed current agent and an unchanged current mode when it still exists.
- [x] 3.6 Update `docs/CONFIGURATION.md` with how OpenCode primary agents become Morse modes, how `default_agent` and OpenCode's ordering choose the default, how custom/removed agents appear, and the per-draft engine picker plus the `MORSE_ENGINE`/`morse.engine` host default; verify the documented paths and setting names match the code.

## 4. Frontend

- [x] 4.1 Add `setEngine`, `setMode` and `refreshModes` actions and the `engines`, `draft`, `engine`, `mode`, `availableModes` and `loadingEngine` accessors to `ui-runtime`/`MorseService`; verify `npm run test -w @morse/ui-runtime` covers the sent messages and the memory transport's mocked engine/mode state.
- [x] 4.2 Build the reusable `morse-option-picker` (trigger, listbox, keyboard, outside-click, loading row, selected check); verify its component spec covers open/close, arrow/Enter selection, loading and disabled options.
- [x] 4.3 Wire the composer: engine pill only when `draft` and two or more engines, mode pill whenever modes exist, sibling pickers close each other, mode picker opening refreshes modes, and Send is held while `loadingEngine`; verify the composer spec covers all visibility rules and the `engine/set`/`mode/set` messages.
- [x] 4.4 Adapt the composer controls for narrow widths so four pills do not clip, and document the new pickers in `README.md`; verify the container-query behaviour in the dev UI at a narrow width and that the composer layout tests pass.
- [x] 4.5 Update the mock host in `packages/ui-runtime/src/transport/memory-transport.ts` with two engines and OpenCode-style modes, and handle `engine/set`, `mode/set` and `modes/refresh`; verify the dev UI shows the pickers and `npm run test -w @morse/ui-runtime` passes.

## 5. Integration verification

- [x] 5.1 Run `npm run build` and confirm every package and both hosts build.
- [x] 5.2 Run `npm run check-types` and `npm run lint` (including `scripts/check-agent-boundary.mjs`) and confirm both pass.
- [x] 5.3 Run `npm test` and confirm the existing suites plus the new tests pass across `@morse/system`, `@morse/integration-pi`, `@morse/integration-opencode`, `@morse/ui-runtime`, `@morse/server` and `@morse/ui-angular`.
- [x] 5.4 Smoke-test both engines on the browser host: a draft shows the engine picker, switching to OpenCode loads its models and modes, setting `default_agent` to `plan` makes plan the default, adding a custom primary agent makes it appear, a session opens in the chosen engine, the mode pill changes plan/build live, and a second new session keeps the chosen engine but returns to the configured default.
- [x] 5.5 Run `openspec validate add-engine-mode-picker --type change --strict` and confirm the change is valid.

## Workflow follow-up

- Sync the delta specs into `openspec/specs/` once the implementation is complete.
- Archive the change after review and confirm the archived directory and synced main specs are correct.
