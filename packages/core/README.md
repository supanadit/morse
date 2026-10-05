# @morse/core

The **domain and use cases**: what a Morse session is, the ports the hosts and adapters implement,
and the services that orchestrate them.

Part of the [Morse](../../README.md) monorepo. **Dependency-free** (no `vscode`, no NestJS, no
`node:*`) — it is the innermost layer, so imports point inward and never out.

## What is in here

| Path | Contents |
|---|---|
| `src/domain.ts` | Anemic value shapes: `WorkspaceRef`, `ModelRef`, `ThinkingLevel`, `AgentSessionState`, transcript entries, … |
| `src/errors.ts` | `MorseError`, `AgentUnavailableError`, `AgentProtocolError`, `UnsupportedByHostError` |
| `src/logger.ts` | The `MorseLogger` port and a console implementation |
| `src/session/service.ts` | The `AgentGateway`/`AgentGatewayFactory`/`SessionCatalog` ports and the `SessionRegistry` use case (hot sessions, LRU, projects, draft probe) |
| `src/chat/service.ts` | The `ChatService` use case (prompt/steer/follow-up, edit/fork, compact) |
| `src/context/service.ts` | The `EditorContextProvider` port |

Ports are declared in the module that **consumes** them (for example, the directory policy lives
with the host glue), so an adapter can be swapped without touching a use case.

```bash
npm run build -w @morse/core
npm run check-types -w @morse/core
```

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for the layering rules.
