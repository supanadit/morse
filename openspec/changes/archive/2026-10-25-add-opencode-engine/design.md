# Design

## Context

The `@morse/agent` contract (port, engine, shapes) is already engine-free and checked by
`scripts/check-agent-boundary.mjs`. `@morse/system` holds the sessions use cases, the record
that already knows how to translate an engine report into its own record, and a reconcile policy
that is scoped per engine kind — but the index is not written anywhere, the registry key is
still the engine's own session id, and both hosts import `PiRpcAdapter` concretely.

OpenCode (v2, installed here as 2.1.4) is a server: Basic auth, one global SSE stream carrying
every session's events, history read through a cursor-paged messages endpoint, models with
reasoning-effort variants, session-scoped permission requests and forms. Its sessions persist in
storage shared across server processes, so a Morse-owned server still lists sessions the user
started elsewhere. The published `@opencode-ai/sdk` (dev tag) already disagrees with the
installed server (`properties` vs `data`, `session.next.*` prefixes), so the adapter will not
depend on it.

See proposal.md for motivation and specs/ for the behavior contract.

## Goals / Non-Goals

**Goals:**

- One router that every host uses, so "which engine owns this session" is decided in one place.
- Registry keys equal Morse ids, so the registry, transcripts and UI tabs stop caring about
  engine id schemes.
- The OpenCode adapter is an ordinary `SessionEngine` — no host code names it beyond
  composition and configuration.
- Engine-specific features (MCP admin, prompt templates, version/CLI) become optional ports.

**Non-Goals:**

- Routing OpenCode sessions through pi or vice versa — resume always returns to the owning
  engine.
- Live cross-process views: a session another OpenCode client is currently streaming is
  reconciled into the listing, but Morse does not stream it while it is cold.
- Any UI beyond the interaction panel gaining a form body.
- A store with fast queries beyond "load all records"; the JSONL index optimizes for the
  existing access pattern (everything, on demand).

## Decisions

**Morse id becomes the registry key via a wrapping gateway.**
`RoutedGateway` delegates to an engine gateway and rewrites `state.sessionId` on the state it
returns and in `agent/ready` / `agent/state` events; `SessionRegistry` keeps keying by
`state.sessionId` unchanged. The router derives the id from the engine kind and id at create,
write the record, and re-derives after `fork()` so `forkActive`'s existing re-key path works.
Alternative considered: add a session-key parameter through the port — rejected, it redefines a
port every engine must honor to satisfy one adapter.

**The store is a port implementation in `@morse/system`, not in each host.**
`@morse/system` already contains host glue that uses `node:*` (`workbench-store.ts`), so the
file store lives there as `FileSessionStore`: sharded one-file-per-record plus a JSONL index of
`{token, record}` lines, last-wins on load, compacted on startup when the index is oversized.
Tokens must survive restarts so reconcile skips unchanged sessions, which is why the token
travels beside the record in the index. Alternative: a per-host store — two implementations of
the same policy.

**The router catalog reads the index, not engine catalogs.**
Listing from records makes ids consistent by construction (a merged engine-catalog listing
would have to re-key every row) and makes cross-engine paging/search/count trivial. Engine
catalogs are used for `scan()` (reconcile) and `remove()`. Freshness: `ensureFresh()` runs
reconcile for every engine behind a debounce and an in-flight guard; each engine's scan is
token-gated, so unchanged sessions cost no reads. A failed scan is swallowed so an engine being
down can never report its own rows deleted.

**Event name normalization instead of a pinned version.**
The mapping accepts both `session.*` and `session.next.*`, and both `data` and `properties`
payloads, keyed off the live stream rather than a generated SDK. Unknown types are ignored
except for a recorded fixture test so silent misses surface in tests, not in the transcript.

**Permissions map to a `select`; forms get a new kind.**
`AgentSelectRequest` with `once / always / reject` preserves "always", which a confirm cannot.
Forms map OpenCode's `Form.Info` (string/number/integer/boolean/multiselect/external, with
`when` visibility) to `AgentFormRequest`; answers come back as `{ [key]: value }`. Native-dialog
hosts queue forms for the webview instead of routing them to QuickPick. Alternative: fold forms
into `select` — rejected, OpenCode forms are genuinely multi-field.

**Server ownership: attach first, spawn as fallback.**
Attach implies never owning the process; spawn implies owning it, with the two startup lines
(address, password) parsed with a timeout and a clear failure when they do not appear. Attach
auth failure surfaces as a configuration problem, not a crash. The connection owns reconnect
logic; a private server's death surfaces as `agent/fatal` on every open OpenCode session, and no
auto-restart in this change.

**Engine registration by auto-detect.**
An engine registers when its binary can be found (pi resolves today; OpenCode when the binary is
on PATH or a URL is configured) and the configured new-session default picks among registered
ones, falling back to the first registered. Unregistered engines do not connect, so a
pi-only user pays nothing.

## Risks / Trade-offs

- [One-time id change for existing sessions] → Transcripts and registry keys are per-host and
  rebuild from history; VS Code tabs already drop unknown ids through their reconcile. Engine
  storage is untouched, so no conversation is lost.
- [Fork appends a record that overlays the parent's history] → The fork record is written with
  `parentId`; the sidebar already nests under it. Forked sessions reuse the parent's title when
  the engine reports none.
- [Forms are underspecified on the installed server (no typed events)] → Discovery is SSE-first
  with a polls fallback (`GET /session/{id}/form` on connect and at execution start/end), and
  unsupported conditional logic degrades to "field always visible".
- [Reconcile freshness vs. latency] → The debounce keeps `list()` from scanning on every call,
  and both engines' scans are cheap; a slow OpenCode server degrades to a slightly stale list.
- [Version drift] → The adapter validates responses defensively and maps unknown tool input
  shapes to a rendered title instead of dropping the call.
- [Symbol collision of engine ids is impossible but ids are hashed] → `deriveSessionId` is
  64-bit FNV with two seeds; at realistic session counts collisions are negligible and failures
  are visible.

## Migration Plan

1. Land the router and store with pi only; ids change once, behavior does not. Gate: pi
   regression suite and a manual open/resume/fork pass.
2. Add the OpenCode adapter behind auto-detect; a host that finds no OpenCode binary behaves
   exactly as before.
3. Land forms last so the contract change and the UI change ship together.
Rollback: the router catalog falls back to a single-engine list if the store is unusable, and
engine registration is config-driven, so removing OpenCode config returns to pi-only with no
schema change.
