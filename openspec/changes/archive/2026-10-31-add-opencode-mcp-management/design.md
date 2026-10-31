# Design

## Context

Morse gates its MCP affordances on `AgentExtras.mcp` (see `packages/system/src/session/integration.ts`).
Only pi supplies it (`PiMcp` in `packages/integration-pi`), wired in `create-pi-rpc-adapter.ts` as
small `unknown`-typed wrappers. The OpenCode engine is registered without extras
(`packages/server/src/internal/registry.ts`), so the panel hides for OpenCode sessions.

Two extra gates shape the design:

- `session-factory.service.ts` reports `mcp: extras?.mcp !== undefined && extras.cli !== undefined`.
  The `cli` half exists because pi's *connection status* shells out to `pi mcp list --json`. OpenCode
  has no such CLI, so this conjunction must not carry over.
- The `mcpWatch` service watches pi's `mcp.json` files and emits `mcp/changed`; OpenCode's config
  lives elsewhere and needs its own fingerprint for refresh.

OpenCode's config format (v2): a single JSON file, global at `~/.config/opencode/opencode.json`
(XDG-aware), project at `<cwd>/opencode.json`, with an `mcp` key:
`{ [name]: { type: 'local', command: [string, ...], environment?, cwd?, enabled } | { type: 'remote', url, headers?, enabled } }`.

## Goals / Non-Goals

**Goals:**
- One new module in `integration-opencode` that reads/writes the `mcp` key, mirroring
  `integration-pi/src/internal/mcp-config.ts` in shape and error style.
- `AgentMcpExtras` implemented and carried through `openOpenCodeEngine` → `router.register`.
- Capability flag per engine so OpenCode shows the panel without a CLI.

**Non-Goals:**
- Live MCP connection probing for OpenCode (no engine API to piggyback on).
- Editing any other `opencode.json` section from the MCP panel.
- Sharing pi's `mcp.json` editor for OpenCode or vice versa.

## Decisions

**Direct file editing, not the OpenCode server API.** Same rationale as pi (`mcp-config.ts`):
the file is the contract, OpenCode exposes no MCP admin endpoint, and OpenCode picks up config on
its next start. Alternative — an OpenCode server route — does not exist today.

**New `opencode-mcp-config.ts` module, not a shared one.** The two formats differ (`mcpServers` with
`command`/`args` vs `mcp` with `command` arrays and `local`/`remote` types; global paths differ), and
a shared module would need a format parameter for two call sites. Mirror pi's module instead:
`readServers(cwd)`, `upsert`, `remove`, `setEnabled`, name validation, JSON-preserving writes
(2-space indent, trailing newline), unknown fields preserved.

**Reuse the pi-shaped MCP panel DTO.** `McpServerStatus` fields map naturally: `type: 'local'` →
`transport: 'stdio: cmd args'`; `'remote'` → `http: url`. Honest mapping for state: `disabled` when
`enabled === false`, otherwise `disconnected` (configured, not verified) — the panel already renders
both without inventing tools. `exposure` is undefined (OpenCode has no exposure concept);
`trusted` is always true; `note` names the degraded mode. If the panel needs a cosmetic tweak for
the `disconnected`-without-tools case, it is a one-line follow-up in `mcp-state.ts`, not a protocol
change.

**Per-engine command resolution, not a default-engine singleton.** The host today resolves every
`mcp*` command against `router.defaultExtras()` — correct for a single engine, wrong the moment two
are registered: the modal would show the default engine's servers regardless of which engine the
session uses. So: the `mcpStatus`/`mcpAdd`/`mcpRemove`/`mcpSetEnabled`/`mcpInspect` payloads gain an
optional engine kind; the host resolves extras via the router per request (falling back to the
default engine when absent, keeping older clients working); the capability report gains a per-engine
statement of which engine its MCP affordance speaks for; and `mcp-state.ts` sends the draft's or
session's engine kind and refetches when it changes. Alternative considered — one modal per engine
keyed by cwd — rejected: the ambiguity lives in which extras the host picks, so that is where the
fix goes.

**Per-engine capability flag.** Change the `mcp` line in `session-factory.service.ts` from the
`extras.cli` conjunction to per-engine availability. Pi keeps working: its extras include `mcp`
regardless, and status failures already surface as `errors` in the payload.

**New-session semantics stated, not engineered.** Both engines read MCP config at session start, so
"edits affect new sessions only" is already true. It is documented in the panel note (and the spec)
so a warm session not picking up an edit is not reported as a bug. No hot-reload mechanism is added.

**Config fingerprint for refresh.** `configSignature(cwd)` hashes the `mcp` sections of both scope
files; the existing `mcp/changed` refresh path re-reads on change. Whether OpenCode joins pi's
`McpWatch` is an implementation detail — the cheap option is watching the two `opencode.json` paths
in the same watcher, falling back to fingerprint-compare on status reads if wiring the watcher is
disproportionate.

**`trustProject` succeeds without writing.** OpenCode reads project configs untrusted; returning
`{ ok: true }` keeps the panel's trust affordance a harmless no-op.

## Risks / Trade-offs

- [Writing the user's `opencode.json` corrupts agents/providers on a bug] → JSON round-trip that
  only touches the `mcp` key, unknown keys preserved verbatim, plus spec'd tests asserting other
  keys survive every mutation; malformed file refuses to write.
- [Same-named global and project servers] → project wins on read, matching OpenCode's own
  precedence; edits target the scope the caller names.
- [Config format drift (OpenCode pre-1.0)] → the module validates strictly and reports malformed
  shapes as `errors` with the file path, so drift shows up as an actionable message, not silence.
- [Writing to the wrong engine's config — the cross-contamination failure mode] → the engine kind
  rides every mcp command and resolves through the router at the host edge; the OpenCode module only
  ever touches `opencode.json` and pi's only `mcp.json`; spec scenarios pin pi-never-sees-opencode
  both directions, plus a draft-switch scenario for the immediate-refetch behavior.
- [`mcpWatch` watches pi's files only, so OpenCode edits elsewhere look stale] → the watcher is
  built from the *requesting* engine's `configSignature` per design below, or OpenCode falls back to
  fingerprint-compare on status reads.
- [`disconnected` for an enabled server may read as "broken" in the panel] → the `note` field and
  panel copy say OpenCode reports configured state only.
- [Older clients omit the engine kind] → the host falls back to the default engine's extras, the
  pre-change behavior, so nothing breaks during a staggered deploy.

## Migration Plan

Purely additive: new module, extras on an engine that had none, one gate line relaxed. Rollback is
reverting the registration; no data, protocol, or stored-state change.

## Open Questions

None.
