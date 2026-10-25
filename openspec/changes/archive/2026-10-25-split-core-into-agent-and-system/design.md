# Design

## Context

See `proposal.md` — Why. The facts that constrain the approach:

- `@morse/core` exports **96 public symbols** today. Both halves live in one barrel, so any
  consumer can reach either.
- Measured consumers: `adapter-pi-rpc` imports **40** symbols from `@morse/core` (nearly all
  harness vocabulary), `host-runtime` 23, `extension` 7, `server` 5 (none harness vocabulary).
  `protocol`, `ui-runtime`, `ui-angular` import **zero**.
- `SessionEngine.reconcile()` currently calls `reconcileSessions()` with a `SessionStore`. No
  caller invokes it yet — it landed as foundation in `8073fe9` and is not wired to a host.
- Build order in root `package.json`: `protocol → core → host-runtime → adapter-pi-rpc →
  ui-runtime`. Every package is `private: true`, so a rename breaks no external consumer.
- `openspec/specs/` is empty; both capabilities are new.

## Goals / Non-Goals

**Goals:**

- One import direction that the compiler enforces: `agent` ← `system` ← adapters and hosts.
- A package whose name states its scope, so a reviewer can tell from an import line whether
  they are looking at harness vocabulary or Morse's application logic.
- Zero behavior change. The test count before and after must be identical, and no test body
  should need editing.

**Non-Goals:**

- Implementing the session index on disk, or wiring a host to it. That is `docs/ROADMAP.md` 1.1
  and 1.6; this change only moves code.
- Splitting `session-controller.ts` (2142 lines).
- Any frontend change. All three frontend packages are untouched.

The package renames that were previously going to be a separate change are **folded into this
one** at the user's request: `adapter-pi-rpc` → `integration-pi`, and `host-runtime` → folded into
`@morse/system`. Both add no requirements and no spec delta, only file moves.

`host-runtime` does **not** become its own package (`@morse/host` was considered and rejected: it
reads as a near-duplicate of the two hosts, `extension` and `server`). It becomes
`packages/system/src/host/` instead, so `@morse/system` is the whole of Morse below delivery:

```
agent  ←  system  ←  { integration-pi , extension , server }
             ↘  protocol
```

Consequence, accepted deliberately: `@morse/system` now depends on `@morse/protocol` and grows by
~3 120 lines (controller 2 125, projector 312, transcript store 220, view-state 215, workbench 124,
terminal ports 86, dialogs 30). It is no longer only "domain + use cases"; it is Morse itself. The
`agent` / `system` boundary is unaffected — that is the one this change exists to establish, and
`agent` still has zero dependencies.

## Decisions

### D1 — Two packages, named `@morse/agent` and `@morse/system`

`@morse/agent` is the harness contract; `@morse/system` is Morse itself.

The user proposed `core-agent`/`core-morse`. Rejected because `core-agent` puts "core" on the
thing that is not Morse's core — the harness contract is an outer boundary, not the centre. And
`core-morse` is redundant inside an `@morse/` scope. `morse` is chosen over `app` because this
package will hold domain shapes and use cases, not delivery.

Alternative considered: keep one `@morse/core` and add only path-level split internally
(`core/src/agent/`, `core/src/app/`). Rejected — package boundaries are what the compiler and
`package.json` enforce; directory boundaries are a convention anyone can import across, which is
the exact problem being fixed.

### D2 — `reconcile()` moves off `SessionEngine`; the engine keeps `scan?()`

This is the decision the split forces. Chosen: **C — the engine reports its own terms, `morse`
translates.** Rejected: A (the engine knows the index) and B (the engine lives in `morse`).

`scan()` is the harness's own question — "what sessions do I hold?" — so it stays on the engine.
What it must **not** return is a Morse type. `SessionScanEntry` today carries
`MorseSessionRecord`, and the pi adapter computes `deriveSessionId(engineRef)` itself
(`create-pi-rpc-adapter.ts:130`); both facts are the coupling this change exists to remove. With
`SessionEngine` in `agent` and `SessionScanEntry` in `morse`, `agent` would import `morse`
while `morse` imports `agent` — a package cycle.

So the engine reports harness terms only, and `morse` owns the translation:

```
agent:   interface AgentSessionInfo { sessionId; file?; title?; cwd; createdAt?;
                                      updatedAt; messageCount; parentSessionId?; token }
         abstract class SessionEngine { kind; factory; catalog; scan?(): AgentSessionInfo[];
                                        get hasScan }
morse:  toSessionRecord(kind, info): MorseSessionRecord      // deriveSessionId lives here
         planReconcile(kind, infos, records, tokens): ReconcilePlan
         reconcileSessions({ source, store, tokens, onProgress })
```

Why C over A: A leaves the adapter computing Morse's id and importing `MorseSessionRecord`, so a
second adapter would have to re-derive the same scheme — the exact duplication the split is meant
to prevent. A also keeps `reconcile()` on the engine, which needs `SessionStore`.

Why C over B: B moves `SessionEngine` into `morse`, so an adapter must extend a `morse` class
while implementing an `agent` port, and `agent` must still declare `scan?()` for it to override —
the cycle remains, just hidden behind an extends clause instead of an import.

What C buys: the pi adapter's `scan()` becomes six lines of plain mapping with no import from
`morse` except the engine base; its specs can use a literal `AgentSessionInfo` fixture instead of
building a `MorseSessionRecord`; a future OpenCode adapter never learns that Morse has ids,
tokens or an index.

Cost: `SessionEngine.reconcile()` and `SessionScanEntry` disappear. Nothing calls `reconcile()`
today (verified: no `.reconcile(` outside definitions), so this is free now and expensive later —
which is why it happens in this change.

### D3 — Ownership rules for the contested types

Each type is assigned by asking one question: *would this exist if Morse had no sidebar?*

| Type | Package | Why |
|---|---|---|
| `WorkspaceRef` | `agent` | Any harness needs a working directory; OpenCode too |
| `ThinkingLevel`, `ModelRef`, `ModelInput`, `THINKING_LEVELS`, `MODEL_INPUTS` | `agent` | What a model accepts is the harness's vocabulary |
| `AgentEvent` + 13 event interfaces + `AgentEventBase` | `agent` | What a harness emits |
| `AgentSessionState`, `AgentWidget`, `AgentStatus`, `AgentDiagnostic` | `agent` | What a harness reports about itself |
| `AgentHistoryEntry` + 3 entries, `AgentForkMessage`, `AgentInteractionRequest` + 4, `AgentInteractionResponse`, `SelectOption`, `JsonValue`, `ToolResultDetails` | `agent` | Conversation vocabulary, not Morse's |
| `AgentGateway`, `AgentGatewayFactory`, `AgentHistoryPage`, `PromptMode`, `PromptDisposition`, `AgentEventListener` | `agent` | Ports the harness implements |
| `abstract class Session`, `abstract class SessionEngine` (only `kind`, `scan?()`, `hasScan`) | `agent` | What an adapter extends |
| `AgentIntegration` (`engine` + `factory` + `catalog`) | `morse` | The composite a host wires; exists only because `catalog` is Morse's |
| `AgentSessionInfo`, `AgentSessionScan` | `agent` | What a harness knows about its own sessions, in its own terms |
| `SessionSummary`, `SessionPage`, `SessionCatalog` | `morse` | A sidebar page is Morse's shape |
| `SessionStore`, `SessionSource` | `morse` | The index is Morse's |
| `MorseSessionRecord`, `AgentEngineRef`, `deriveSessionId`, `toSessionSummary`, `UNTITLED_SESSION`, `toSessionRecord` | `morse` | Morse's record, and the only code that knows its id scheme |
| `planReconcile`, `ReconcilePlan`, `ReconcileResult`, `reconcileSessions` | `morse` | Morse's merge policy |
| `SessionRegistry`, `SessionRegistryDeps`, `TaggedAgentEvent`, `OpenedSession`, `ForkedSession` | `morse` | Use case |
| `ChatService`, `ChatServiceDeps`, `ChatAgent`, `ChatAgentHolder`, `PromptOutcome` | `morse` | Use case + its local ports |
| `EditorContextProvider`, `EditorContextSnapshot`, `EditorSelection` | `morse` | A Morse host's editor, not a harness concept |
| `MorseLogger`, `SessionLogger` | `morse` | Morse's logging port (harness receives it, does not own it) |
| `MorseError`, `AgentUnavailableError`, `AgentProtocolError`, `UnsupportedByHostError`, `AgentRemedy` | `morse` | Sentinel errors name Morse concepts |
| `NoticeLevel`, `SessionSpeed`, `TokenUsage`, `ContextUsage`, `SessionCounts` | `agent` | Reported by a harness about its own run |

Doubtful cases resolved this way: `NoticeLevel` goes to `agent` even though `AgentNoticeEvent`
is its only consumer, because a harness choosing a severity is harness behavior. `SessionSpeed`
goes to `agent` although Morse measures it — because it describes a harness run, and the
alternative is `AgentSessionState` in `agent` importing from `morse`, which inverts D1.

`SessionScanEntry` is **deleted**, not moved. Its two fields split along the boundary: `token`
becomes a field of `AgentSessionInfo` (the harness's own "unchanged" marker), and `record`
becomes the output of `toSessionRecord` (Morse's business). A type that carries both is the
coupling in one line.
`MorseLogger` stays in `morse` because its name says whose it is; `Session` in `agent` declares
a minimal structural `SessionLogger` instead of importing it.

### D4 — Split `session/ports.ts`, which currently mixes both

That file holds ten exports; five are harness vocabulary (`PromptMode`, `PromptDisposition`,
`AgentGateway`, `AgentGatewayFactory`, `AgentEventListener`, `AgentHistoryPage`) and five are
Morse's (`SessionCatalog`, `SessionPage`, `SessionStore`, `SessionSource`, `SessionScanEntry`,
the two page constants). It splits along that line: the agent half to `agent/ports.ts`, the rest
to `morse/ports.ts`. `SessionScanEntry` is replaced by `AgentSessionInfo` in the agent half and
does not reappear in `morse`.

### D7 — `factory` and `catalog` leave `SessionEngine`

`SessionEngine` currently declares both:

```ts
abstract readonly factory: AgentGatewayFactory;   // agent vocabulary
abstract readonly catalog: SessionCatalog;        // morse vocabulary
```

`SessionCatalog` belongs to `@morse/system`, so keeping `catalog` on an engine that lives in
`@morse/agent` means `agent` imports `morse` — the same cycle D2 removes for `scan()`. Declaring it
on the engine is also unnecessary: **neither member is ever read through the engine.** Verified —
`packages/extension/src/app/main.ts:92-93` and
`packages/server/src/internal/registry.ts:20-21` read `adapter.factory` and `adapter.catalog`
off the adapter object, and no `engine.factory` / `engine.catalog` access exists anywhere in the
repo.

So the engine keeps only what is its own — `kind`, `scan?()`, `hasScan` — and a Morse-side
composite states what a host actually needs:

```ts
// @morse/system
export interface AgentIntegration {
  readonly engine: SessionEngine;          // agent: kind + scan?()
  readonly factory: AgentGatewayFactory;   // agent: creates sessions
  readonly catalog: SessionCatalog;        // morse: the sidebar's source
}
```

`PiRpcEngine` implements `AgentIntegration`. Both composition roots are unchanged, because
`adapter.factory` and `adapter.catalog` still exist — only where they are *declared* moves. To let
reconcile reach the engine, `SessionRegistryDeps` gains an optional `engine?: SessionEngine`, used
solely by `reconcile()`.

Why not keep both on the engine and accept the cycle: a cycle between `agent` and `morse` makes
the two packages one package with two names. `agent` must compile only against itself, and that is
only true if it has no member whose type lives outside it.

Enforcement note: the boundary is **not** enforced by an empty `dependencies` — npm hoists workspace
packages, so such an import would still resolve and type-check. It is enforced by
`scripts/check-agent-boundary.mjs`, run by `npm run lint` (and so by CI). See Risks.

### D5 — Keep the barrel shape, so import churn is mechanical

Every package keeps a top-level `index.ts` re-exporting its subjects, as `@morse/core` does now.
A consumer that needs both halves writes two imports; a consumer that needs one writes one. No
deep imports (`@morse/agent/src/...`) — none exist today and none should be introduced.

### D6 — Move in one commit, verify with the existing suite

This is a pure move. The verification is that `check-types --workspaces`, `tsc ui-angular` and
`npm test` produce byte-identical results before and after, other than import lines. No new tests
are added for moved code; the specs in this change describe behavior that already exists and is
already covered (or not) exactly as before.

## Risks / Trade-offs

- **A type is assigned to the wrong package** → the compiler catches it as a missing export or an
  import cycle, not silently. The only genuinely lossy failure is putting a harness type in
  `morse`, which would compile fine and quietly re-create the coupling; D3's table exists to make
  that reviewable.
- **`agent` accidentally gains a dependency on `morse`** → this is the failure mode C is designed
  against, and it is silent: an import of `MorseSessionRecord` inside `agent` would compile until it
  met the cycle. **An empty `dependencies` does NOT prevent it** — npm workspaces hoist every package
  into the root `node_modules`, so TypeScript resolves `@morse/system` from `packages/agent` whether or
  not it is declared. Verified during implementation: a probe importing `@morse/system` in
  `packages/agent/src` type-checked clean. The real check is `scripts/check-agent-boundary.mjs`, run by
  `npm run lint` and therefore by CI — it reads source text, strips comments, and fails on a specifier
  naming `@morse/system`, an adapter/host package, a `node:` built-in or a host framework.
  `dependencies: {}` stays as a statement of intent, not as the mechanism.
- **`morse-web`'s `build.mjs`** bundles workspace packages by folder path
  (`join(packagesRoot, 'core', 'dist', 'index.js')`). Renaming the folder breaks `npm run build:web`
  in a way no `grep '@morse/core'` finds → tasks must include reading that file, not just grepping
  imports.
- **Docs drift** → `docs/ARCHITECTURE.md` has a package table, a layer diagram, a port table and
  rules R1/R2/R6 that all name `core`. Missing one leaves a doc that describes a package that no
  longer exists.
- **`@morse/host` keeps an imprecise name** → accepted for now; noted here so the next
  person knows it was a choice, not an oversight.
- **The 96-symbol move is one large diff** → mitigated by doing it as a move (no rewrites) and by
  the identical-test-count check.

## Migration Plan

1. Create the two packages with their `package.json`/`tsconfig.json`, and add them to
   `build:libs` in dependency order (`agent` before `morse`, both before `host-runtime`).
2. Move harness vocabulary into `packages/agent/src/`, preserving the existing subject split
   (`domain/`, `ports.ts`, `session.ts`, `engine.ts`); introduce `AgentSessionInfo`, drop
   `reconcile()` and `SessionScanEntry` from the engine, keep `scan?()`/`hasScan`.
3. Move the remainder into `packages/morse/src/` (`record.ts`, `ports.ts`, `identity.ts`,
   `reconcile.ts`, `session/service.ts`, `chat/`, `context/ports.ts`, `errors.ts`, `logger.ts`) and
   add `toSessionRecord(kind, info)` so the id scheme has exactly one home.
4. Rewrite imports in `adapter-pi-rpc`, `host-runtime`, `extension`, `server`.
5. Delete `packages/core` and its `README.md`; write two new READMEs.
6. Update `docs/ARCHITECTURE.md` (package table, layer diagram, port table, R1/R2/R6) and root
   `README.md` if it names `core`; fix `packages/morse-web/build.mjs`.
7. Verify: `check-types --workspaces`, `tsc -p packages/ui-angular/tsconfig.app.json --noEmit`,
   `npm run build`, `npm test` (expect 85 files / 765 tests, unchanged).

Rollback: the change is one commit on `refactor/agent-agnostic`; `git revert` restores
`@morse/core` intact. No data migration is involved, because no index exists yet.
