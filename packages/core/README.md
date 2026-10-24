# @morse/core

The **domain and use cases**: what a Morse session is, the ports the hosts and adapters implement,
and the services that orchestrate them.

Part of the [Morse](../../README.md) monorepo. **Dependency-free** (no `vscode`, no NestJS, no
`node:*`) — it is the innermost layer, so imports point inward and never out.

## What is in here

Each module is one use case, and its ports live beside it in `ports.ts` — the use case never
declares a port and the port never carries behaviour.

| Path | Contents |
|---|---|
| `src/domain.ts` | Anemic value shapes: `WorkspaceRef`, `ModelRef`, `ThinkingLevel`, `AgentSessionState`, transcript entries, … |
| `src/errors.ts` | `MorseError`, `AgentUnavailableError`, `AgentProtocolError`, `UnsupportedByHostError` |
| `src/logger.ts` | The `MorseLogger` port and a console implementation |
| `src/session/ports.ts` | `AgentGateway`, `AgentGatewayFactory`, `SessionCatalog`, `SessionStore`, `SessionSource` and the paging constants |
| `src/session/service.ts` | The `SessionRegistry` use case (hot sessions, LRU, projects, draft probe) |
| `src/session/record.ts` | `MorseSessionRecord`, `AgentEngineRef`, `toSessionSummary` — the session Morse owns |
| `src/session/identity.ts` | `deriveSessionId` — Morse's id from an engine's session id |
| `src/session/reconcile.ts` | `planReconcile` (pure policy) and `reconcileSessions` (applies it) |
| `src/session/engine.ts` | `abstract class SessionEngine` — one per harness, with optional `scan()` |
| `src/session/session.ts` | `abstract class Session` — one per conversation, with the listener fan-out and state |
| `src/chat/ports.ts` | `ChatAgent`, `ChatAgentHolder`, `PromptOutcome` — satisfied structurally by `SessionRegistry` |
| `src/chat/service.ts` | The `ChatService` use case (prompt/steer/follow-up, edit/fork, compact) |
| `src/context/ports.ts` | The `EditorContextProvider` port |

Ports are declared in the module that **consumes** them (for example, the directory policy lives
with the host glue), so an adapter can be swapped without touching a use case.

```bash
npm run build -w @morse/core
npm run check-types -w @morse/core
```

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for the layering rules.
