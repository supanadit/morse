# Proposal

## Why

Morse's MCP panel only works for pi sessions: pi supplies `AgentExtras.mcp`, while the OpenCode
integration supplies none, so a user running OpenCode cannot see or edit its MCP servers from Morse
even though OpenCode keeps them in a plain JSON config (`mcp` key in `opencode.json`). The host
already gates on extras presence, so implementing the extras port for OpenCode lights the panel up
with no protocol or UI changes.

## What Changes

- Add an MCP config module for OpenCode that reads and writes the `mcp` key of `opencode.json`
  (global `~/.config/opencode/opencode.json`, project `<cwd>/opencode.json`), covering OpenCode's
  `local` (command array, env, cwd) and `remote` (url, headers) server types and their `enabled` flag.
- Implement `AgentMcpExtras` in the OpenCode integration and expose it via the engine's `extras`,
  mapping OpenCode's config vocabulary onto Morse's MCP panel DTO (status, add, remove, setEnabled).
- Scope where it differs from pi: OpenCode has no `mcp list --json`-style CLI, so status is derived
  from the config files alone — every configured server reports its `enabled` state; live connection
  state, tool lists, and per-tool exposure are absent and the panel degrades gracefully.
- Preserve unknown fields in `opencode.json` on every write (agents, providers, models are in the
  same file); trust is not an OpenCode concept, so `trustProject` is a no-op success.
- Make the MCP modal engine-scoped. Today the host binds MCP to the *default* engine's extras
  (`router.defaultExtras()`), and the `mcpStatus`/`mcpAdd`/… commands carry no engine — so with two
  engines registered the modal always shows the default engine's servers, whichever engine the
  session or draft uses. Commands SHALL name their engine and the modal SHALL follow the selected
  engine immediately, so pi sessions never see opencode's servers or the reverse.
- State in the panel that MCP edits affect new sessions only: both engines read their MCP config
  when a session starts, so a warm session keeps its servers until reopened.
- Revisit the wiring assumption in `packages/system/src/session/integration.ts` that OpenCode has no
  MCP config to manage.

Non-goals: live MCP connection probing for OpenCode (no engine API for it); editing OpenCode
agents/providers from the MCP panel; hot-reloading MCP servers into already-running sessions.

## Capabilities

### New Capabilities
- `agent/opencode-mcp`: Managing OpenCode's MCP servers from Morse — reading their configured state
  from `opencode.json`, adding, removing, enabling and disabling them at global or project scope.

### Modified Capabilities
<!-- none: pi's MCP behavior is unchanged; the panel's hide-when-absent gating already covers
     engines without extras, so no existing requirement changes. -->

## Impact

- `packages/integration-opencode/src/internal/` — new `mcp-config` module (read/write/validate).
- `packages/integration-opencode/src/opencode-agent.ts` — build `extras` with `mcp` on the engine.
- `packages/system/src/session/integration.ts` — update the comment that says OpenCode supplies
  no MCP extras (documentation only).
- `packages/system/src/session/agent-router.ts` — extras lookup by engine kind (exists per engine;
  add a by-kind accessor if the host needs one).
- `packages/server/src/internal/ws/session-factory.service.ts` — resolve extras per requested
  engine in the mcp* host commands instead of the default-engine singleton; capability flag
  becomes per-engine.
- `packages/protocol/src` — the mcp* host command payloads gain an optional engine kind, and the
  capability report names which engine the MCP affordance speaks for.
- `packages/ui-angular/src/app/state/mcp-state.ts` — pass the draft/session's engine kind on every
  mcp command and refetch when it changes.
- `packages/ui-angular` MCP panel — no required change; verify it renders the OpenCode-shaped
  statuses (fields it cannot fill stay undefined).
- No protocol or wire changes: `mcpStatus`/`mcpAdd`/`mcpRemove`/`mcpSetEnabled` already relay
  `unknown` extras payloads per engine.
