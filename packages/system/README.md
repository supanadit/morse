# @morse/system

**Morse itself**: its own domain, its session index, and the use cases that orchestrate a harness.

Part of the [Morse](../../README.md) monorepo. Pure TypeScript — no `vscode`, no NestJS, no
`node:*`.

## Why this package exists

`@morse/core` used to hold two unrelated layers: the vocabulary for talking to an agent harness,
and Morse's own application logic. This package is the second half.

The boundary is one arrow:

```
@morse/agent  ←  @morse/system  ←  @morse/integration-* , extension , server
```

`@morse/agent` may never import this package. It has no dependencies at all, which is what makes
that mechanical rather than a convention.

## What is in here

| Path | Contents |
|---|---|
| `src/domain/session.ts` | `SessionSummary`, `ProjectSummary` — a sidebar page is Morse's shape, even when a harness supplies the data |
| `src/session/record.ts` | `MorseSessionRecord`, `AgentEngineRef`, `UNTITLED_SESSION`, `toSessionSummary`, `toSessionRecord` |
| `src/session/identity.ts` | `deriveSessionId` — the only place that knows Morse's id scheme |
| `src/session/ports.ts` | `SessionCatalog`, `SessionPage`, `SessionStore` and the paging constants |
| `src/session/reconcile.ts` | `planReconcile` (pure policy) and `reconcileSessions` (applies it) |
| `src/session/service.ts` | `SessionRegistry` — hot sessions, LRU, projects, draft probe, `reconcile()` |
| `src/session/integration.ts` | `AgentIntegration` (`engine` + `factory` + `catalog`) — the composite a host wires |
| `src/chat/` | `ChatService` and its local ports (`ChatAgent`, `ChatAgentHolder`, `PromptOutcome`) |
| `src/context/ports.ts` | The `EditorContextProvider` port |
| `src/errors.ts` | `MorseError`, `AgentUnavailableError`, `AgentProtocolError`, `UnsupportedByHostError` |
| `src/logger.ts` | The `MorseLogger` port and a console implementation |

## What is *not* here yet

The session index on disk — one JSON per session, a sharded directory, an append-only index — is
`1.1` in [`docs/ROADMAP.md`](../../docs/ROADMAP.md). This package has the `SessionStore` port, the
record shape and the reconcile policy; the host-side implementation lands there.

Also not built: wiring a host to read from the index instead of the harness's own catalog
(`1.6`), and moving `sessionKey` from the harness's session-file path to `record.id` (`1.4`).

## How a host uses it

```ts
// composition root, unchanged in shape from before the split
const adapter = createPiRpcAdapter(config, logger);   // returns an AgentIntegration
const registry = new SessionRegistry({
  factory: adapter.factory,
  catalog: adapter.catalog,
  engine: adapter.engine,        // optional; enables reconcile()
  defaultWorkspace,
  logger,
});
```

```bash
npm run build -w @morse/system
npm run check-types -w @morse/system
```

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for the full layer diagram.
