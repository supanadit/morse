# Proposal

## Why

`@morse/core` holds two unrelated things: the vocabulary for talking to an agent harness
(`AgentEvent`, `AgentSessionState`, `AgentGateway`, `ThinkingLevel`) and Morse's own
application logic (`SessionRegistry`, `ChatService`, `MorseSessionRecord`, `deriveSessionId`).
The names do not tell them apart, so the package reads as one "core" when it is two layers.

The cost is measurable today. The NestJS host imports **5** symbols from `@morse/core` and none
of them is agent vocabulary; the pi adapter imports **40** and nearly all of them are. Nothing
stops Morse's application code from leaking into the harness contract, and nothing stops a
future adapter from importing the session index it should not know about. Both are one careless
import away, on a package whose name suggests they are the same thing.

Splitting them is the prerequisite for the second engine: `@morse/agent` is the contract every
harness implements, `@morse/system` is Morse itself. A second adapter should be able to depend
on the contract alone.

## What Changes

- **New package `@morse/agent`** — the harness-agnostic vocabulary and ports: model and thinking
  vocabulary, session state and events, history and interaction shapes, `AgentGateway`,
  `AgentGatewayFactory`, `abstract class Session`, `abstract class SessionEngine`.
- **New package `@morse/system`** — Morse's own domain and use cases: `MorseSessionRecord`,
  `AgentEngineRef`, `deriveSessionId`, `SessionStore`, `SessionSource`, `SessionCatalog`,
  `planReconcile`, `reconcileSessions`, `SessionRegistry`, `ChatService`, `EditorContextProvider`,
  `MorseLogger` and the sentinel errors.
- **`@morse/core` is removed.** Its two halves move; nothing is left behind to keep the name
  meaning two things.
- **`reconcile()` leaves `SessionEngine`, and `scan()` stops returning a Morse type.** The engine
  keeps `scan?()`, which is the harness's own question ("what sessions do I hold?"), but it now
  reports `AgentSessionInfo` — the harness's own terms. Turning that into a Morse record, including
  deriving the id, becomes `@morse/system`'s job. This is what lets `@morse/agent` have no knowledge of the
  session index at all, and it removes the id scheme from the pi adapter.
- **`WorkspaceRef` moves to `@morse/agent`.** Any harness needs a working directory; OpenCode
  needs one too. It is not Morse-specific.
- **`SessionSummary` and `SessionPage` stay in `@morse/system`.** A sidebar page is Morse's shape,
  even though a harness's catalog supplies the data.
- **Dependency direction becomes enforceable**: `agent` imports nothing; `morse` imports
  `agent`; `host-runtime`, `adapter-*`, `extension`, `server` import both. `protocol`,
  `ui-runtime` and `ui-angular` are untouched (they import zero symbols from `core` today).
- **BREAKING for workspace consumers**: the package name `@morse/core` disappears. Every
  `from '@morse/core'` becomes `from '@morse/agent'` and/or `from '@morse/system'`. These are
  `private: true` workspace packages, so no external consumer is affected.

## Capabilities

### New Capabilities

- `agent/harness-contract`: what a coding-agent harness must expose so any harness can drive a
  Morse session — the event vocabulary, the session state, the gateway ports, and the abstract
  `Session`/`SessionEngine` that every adapter extends. Includes the rule that this capability
  depends on no application logic, and that a harness reports its own sessions in its own terms.
- `system/session-index`: Morse's ownership of a session record — the record shape, the derived
  id, the translation from a harness's report into that record, the store and source ports, and the
  reconcile policy that merges a harness's storage into Morse's index without deleting what it did
  not read.

### Modified Capabilities

None. No existing capability has a spec yet (`openspec/specs/` is empty), so both capabilities
are new.

## Impact

**Affected packages**

| Package | Change |
|---|---|
| `packages/core` | Removed; split into `packages/agent` and `packages/morse` |
| `packages/agent` | New |
| `packages/morse` | New |
| `packages/integration-pi` | Imports move to `agent` + `morse`; `PiRpcEngine` keeps `scan()`, loses `reconcile()` |
| `packages/host` | Imports move to `agent` + `morse` |
| `packages/extension` | 7 imports move (`ChatService`, `SessionRegistry`, `EditorContextProvider`, … → `morse`) |
| `packages/server` | 5 imports move (all → `morse`) |
| `packages/protocol`, `ui-runtime`, `ui-angular`, `morse-web` | Untouched — zero `core` imports |

**Build**: `build:libs` gains `@morse/agent` before `@morse/system`, and both before
`host-runtime`. `adapter-pi-rpc` builds after both.

**Docs**: `docs/ARCHITECTURE.md` (package table, layer diagram, port table, R1/R2/R6),
`packages/core/README.md` (becomes two READMEs), root `README.md` if it names `core`.

**Risk**: this is a move, not a rewrite. No behavior changes and no test should change. The one
place a wrong decision is possible is ownership of a shared type; the compiler catches that as a
missing export, not silently.

**Out of scope**: the pi index itself is not implemented here (that is 1.1 in `docs/ROADMAP.md`),
and no host is rewired to read from Morse's index. This change only moves code and its boundary.
