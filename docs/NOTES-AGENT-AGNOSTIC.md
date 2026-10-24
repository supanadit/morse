# Agent-agnostic sessions — working notes

Scratchpad for the in-progress work that makes a Morse session independent of the pi
harness. Not user documentation: it records what was decided, what landed, what is left,
and the traps found along the way. The order of work and the definition of done live in
[`ROADMAP.md`](ROADMAP.md); this file is the detail behind it. Delete this file when the work
ships and fold the surviving facts into [`ARCHITECTURE.md`](ARCHITECTURE.md) and
[`STATUS.md`](STATUS.md).

## The problem

Morse is ~85% dependent on pi:

| Area | Owner today |
|---|---|
| Conversation content | **pi** — `~/.pi/agent/sessions/*.jsonl` |
| Session identity | **pi** — `sessionKey = state.sessionFile ?? state.sessionId` |
| Session title | **pi** — `session_info`/`session_name`, else Morse derives it from the first prompt |
| Agent execution | **pi** — RPC subprocess |

Already agnostic: `SessionRegistry`, `ChatService`, `TranscriptProjector`,
`HostSessionController`, all of `protocol`, all of `ui-runtime`. Zero pi references.

Consequence: swapping pi for OpenCode today would lose every existing conversation, because
Morse has no id or history of its own.

## Decisions taken

1. **Morse owns the session record; the engine owns the conversation.**
   `~/.morse/sessions/<uuid>.json` holds metadata only. The transcript stays wherever the
   engine keeps it and is referenced by `engineRef.file`. Morse does not duplicate 600 MB
   of JSONL.
2. **One file per session**, sharded by the first two id characters (`ab/ab3f….json`), so a
   directory never holds more than ~1/1296 of a large catalog in one listing.
3. **Id is derived, not generated**: `deriveSessionId({engine, sessionId})`. Two hosts that
   discover the same pi session mint the same id with no lock and no coordination. This is
   what retired the "only one host may write" constraint.
4. **Index = append-only JSONL + snapshot**, the same fold-then-tail pattern pi itself uses
   for a session file. `list()` reads the snapshot and the tail, never the whole log.
5. **Reconcile, not crawl.** A `stat`-only scan is what keeps a session the reader started
   with `pi` in a terminal visible. Measured on this machine: 492 sessions, 58 buckets —
   `readdir`-only **12 ms**, full content read **416–878 ms**. So scanning is cheap; reading
   is what must be skipped by the token (`mtime:size`).
6. **Do not design for millions.** 10 000 sessions per host is the realistic ceiling; beyond
   that the bottleneck is the filesystem, which an index cannot fix.

## Landed (core + pi adapter)

| File | Contents |
|---|---|
| `core/src/session/record.ts` | `MorseSessionRecord`, `AgentEngineRef`, `toSessionSummary`, `UNTITLED…` |
| `core/src/session/ports.ts` | `SessionStore`, `SessionSource`, `SessionScanEntry` |
| `core/src/session/identity.ts` | `deriveSessionId` (FNV-1a ×2, 64-bit, no `crypto`) |
| `core/src/session/reconcile.ts` | `planReconcile` (pure), `reconcileSessions` (+ `onProgress`) |
| `core/src/session/engine.ts` | `abstract class SessionEngine` — `kind`, `factory`, `catalog`, `scan?()`, `reconcile()` |
| `core/src/session/session.ts` | `abstract class Session implements AgentGateway` — listener fan-out, `box`/`patch`/`emitState`/`emitReady`, copying `state()` |
| `adapter-pi-rpc/src/pi-rpc-agent.ts` | `PiRpcAgent extends Session` (−127 lines of duplicated fan-out/state) |
| `adapter-pi-rpc/src/create-pi-rpc-adapter.ts` | `PiRpcEngine extends SessionEngine`, `scan()` over the pi catalog |

`npm run check-types --workspaces` clean, `npm test` 85 files / 765 tests passing — the same
count as before the change, so nothing broke and nothing new is covered yet.

Behaviour change in the running app: **none**. `id` is not used as a key anywhere yet; the
registry and the frontend still key on pi's session file path.

## Left to do

The work items live in [`ROADMAP.md`](ROADMAP.md). This table only adds the per-item risk and
the sizes measured so far, which the roadmap deliberately leaves out.

| Work | Size | Risk |
|---|---|---|
| `SessionStore` on disk | ~350 | medium |
| Scan token `Math.trunc` | 1 line | none now, a full re-read later |
| One-off pi import | ~120 | medium |
| `sessionKey` = `record.id` | ~15 files | **high — PR on its own** |
| `workbench.json` tab migration | ~30 | high |
| `reconcile()` at startup | ~20 | low |
| Delete the duplicates | −60 | low |

`id` = `record.id` and the tab migration must ship together: changing what `id` means without
migrating the stored layout silently loses every restored tab.

## Traps found

- **The catalog pages its list.** `PiRpcSessionCatalog` caps at 10 sessions per project for
  the sidebar, so `scan()` over it saw **186 of 492** sessions — and a reconcile would have
  deleted the other 306. The engine now owns two catalogs: `catalog` (paged, for the UI) and
  `scanCatalog` (`maxSessionsPerProject: Number.MAX_SAFE_INTEGER`). Re-measured: 492 sessions,
  46 projects, max 172 per project, 1437 ms.
- **`token` uses float milliseconds.** pi's `updatedAt` is `1792828500631.625`, so tokens read
  `<float>:<count>`. Deterministic, so correctness holds, but `Math.trunc` belongs there
  before any index exists — after that, changing it forces a full re-read of every session.
- **`state()` must copy.** The first version returned the internal snapshot; a caller pushing
  into `availableModels` rewrote the session's state. `state()`, `emitState()` and `emitReady()`
  all clone now.
- **`factory` is not a session member.** It creates sessions, so it belongs on `SessionEngine`,
  not on `Session`.
- **Index location is not `dataDir`.** `extension/src/app/main.ts:169` resolves `dataDir` from
  `context.storageUri ?? globalStorageUri`, which is **per-workspace** in VS Code. An index
  there would be one index per workspace and would lose sessions on a folder switch. The
  index must live in a global location (`~/.morse` for both hosts).
- **`workbench-store.ts` has no version migration** — `asSnapshot` only rejects `version < 1`
  and returns whatever it got. Fine for a layout (losing it costs a tab position), not fine
  for a session index (losing it costs every conversation), so the index needs its own
  per-version readers plus an idempotent pi-import marker.

## Open questions

- `Session.kind` and `SessionEngine.kind` are both `'pi'`. One source would be better; the
  record needs to know the engine, so this stays until a second engine exists.
- `reconcileSessions` writes serially. A first migration of 10 000 sessions is 10 000
  sequential awaits — batch or windowed `Promise.all` when the store lands.
- `AgentSessionState` still carries pi-shaped optionals (`widgets`, `statuses`,
  `availableCommands.source: 'builtin' | …`). OpenCode has no TUI widgets; the frontend must
  degrade rather than render dead rows.
- `HostCapabilities` (20+ pi-derived booleans in `session-factory.service.ts`) has no
  per-provider story yet. That is frontend work, not plumbing.
