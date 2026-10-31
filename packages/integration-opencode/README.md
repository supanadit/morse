# @morse/integration-opencode

The **driven adapter** that drives [OpenCode](https://opencode.ai) as a Morse engine. OpenCode is a
long-lived local server speaking a v2 HTTP API; this package owns the connection (attach or spawn),
the engine-wide event stream, and the projection of OpenCode sessions into the `@morse/agent`
contract.

Part of the [Morse](../../README.md) monorepo. It speaks the installed server's HTTP API directly —
not the pre-release `@opencode-ai/sdk`, whose generated types already disagree with the server this
package targets.

## What is in here

| File | Contents |
|---|---|
| `src/engine.ts` | `OpenCodeEngine` — the engine: kind, factory, `scan()`, and its owned server's lifetime |
| `src/agent.ts` | One session: prompt/follow-up, abort, history, fork, model & variant selection, forms |
| `src/session-catalog.ts` | Lists/pages/searches/counts/removes sessions against the server |
| `src/internal/connection.ts` | Attach with Basic auth, or spawn `opencode serve` and read its announced address/password |
| `src/internal/event-stream.ts` | The one SSE subscription per engine, its reconnect, and death reporting |
| `src/internal/event-mapping.ts` | OpenCode `session.*` / `session.next.*` events → `AgentEvent` |
| `src/internal/message-mapping.ts` | OpenCode messages → `AgentHistoryEntry` |
| `src/internal/model-mapping.ts` | Model variants → `ThinkingLevel` |
