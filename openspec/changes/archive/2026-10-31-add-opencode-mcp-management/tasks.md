# Tasks

## 1. OpenCode MCP config module

- [x] 1.1 Add `packages/integration-opencode/src/internal/opencode-mcp-config.ts`: read both scope files (`~/.config/opencode/opencode.json` XDG-aware, `<cwd>/opencode.json`), parse the `mcp` key (`local`/`remote` entries), project-wins merge, strict validation with file-path errors. Verify: unit tests for read, merge, malformed-file errors (`opencode-mcp-config.spec.ts`).
- [x] 1.2 Add mutations: `upsert` (local: command array + optional environment/cwd; remote: url + optional headers), `remove`, `setEnabled`, name validation, refusing invalid edits without writing. Verify: unit tests asserting `mcp` changes and every other key of a realistic `opencode.json` (agents, provider, models) survives byte-for-byte.
- [x] 1.3 Add `configSignature(cwd)` over both scopes' `mcp` sections. Verify: unit test — unchanged file keeps the signature, any `mcp` edit moves it.

## 2. Engine-scoped MCP commands (the contamination fix)

- [x] 2.1 Add optional engine kind to the mcp* host command payloads (`packages/protocol`) and resolve extras per request in `packages/system/src/host/session-controller.ts` via the router, falling back to `defaultExtras()` when absent. Verify: unit tests — a command naming `opencode` reaches opencode's extras and never pi's, and vice versa; an omitted kind behaves as before.
- [x] 2.2 Relax the capability gate in `packages/server/src/internal/ws/session-factory.service.ts` to per-engine `extras?.mcp !== undefined` (drop the `extras.cli` conjunction) and report which engine the affordance speaks for. Verify: existing host tests pass; pi capability flags unchanged; opencode reports mcp available.
- [x] 2.3 Frontend: `packages/ui-angular/src/app/state/mcp-state.ts` sends the draft's/session's engine kind on every mcp command and refetches status when the engine dropdown changes, so the modal switches immediately. Verify: state test — switching kind triggers a status read for the new kind and mutations carry it.
- [x] 2.4 Panel note that MCP edits affect new sessions only; warm sessions keep their servers until reopened. Verify: component test asserts the note renders.

## 3. OpenCode extras

- [x] 3.1 Implement `AgentMcpExtras` in the OpenCode integration and return `extras` from `openOpenCodeEngine`; pass it to `router.register` in `packages/server/src/internal/registry.ts` (statuses mapped per design: `disabled` vs `disconnected`, `trusted: true`, degraded-mode `note`). Verify: unit tests on the mapping and the registry registration; `trustProject` resolves `{ ok: true }`.
- [x] 3.2 Refresh path: make an external `opencode.json` edit reach the panel (per-engine watcher or fingerprint-compare on status reads). Verify: test or manual check that the next status reflects an out-of-band edit.
- [x] 3.3 Update the stale comment in `packages/system/src/session/integration.ts` that says OpenCode has no MCP config to manage. Verify: comment reads correctly; no behavior change.

## 4. Panel fit and end-to-end

- [x] 4.1 Check `packages/ui-angular` MCP state/panel renders the OpenCode shape (no tools, no exposure, `disconnected` + note) and adjust copy only if something reads as broken. Verify: component test with an OpenCode status payload, or a noted manual check.
- [x] 4.2 End-to-end, both engines: register pi and opencode on one host; confirm the pi modal shows only pi servers and the opencode modal only opencode servers; switch the draft's engine and watch the modal switch; add, disable, re-enable and remove an opencode server from the panel; confirm `opencode.json` stays valid and OpenCode still starts; confirm a warm session keeps its servers across an edit. Verify: manual checklist recorded in the task notes.

  > E2E executed 2026-10-31 against a live host (pi + OpenCode engines registered, isolated
  > PI_CODING_AGENT_DIR / XDG_CONFIG_HOME), driven over the WebSocket client: 14/14 checks —
  > each engine lists only its own servers; mcpAdd/disable/re-enable/remove land in
  > `opencode.json` only (other keys like `$schema` survive); the added server never appears
  > in pi's status; an unknown engine kind is refused, never cross-read; trustProject is a
  > no-op success.
- [x] 4.3 Full test suite and lint for touched packages. Verify: `npm test`/repo equivalent green.
