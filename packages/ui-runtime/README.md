# @morse/ui-runtime

The **framework-free frontend runtime**: the transport abstraction and the client that turns wire
messages into a single `SessionView`. A frontend (Angular today, React/Svelte tomorrow) only renders
that view and calls the actions — all the protocol logic lives here.

Part of the [Morse](../../README.md) monorepo. It depends on `@morse/protocol` only.

## What is in here

| File | Contents |
|---|---|
| `src/client.ts` | `createMorseClient()` — subscribes to a transport, reduces messages into a view, exposes `MorseActions` (prompt, steer, sessions, model/thinking, host commands, terminals) |
| `src/transport/host-transport.ts` | `BaseHostTransport` and the `HostTransport` contract |
| `src/transport/vscode-transport.ts` | The VS Code webview `postMessage` transport |
| `src/transport/websocket-transport.ts` | The browser WebSocket transport (reconnect included) |
| `src/transport/memory-transport.ts` | The in-memory mock host (`?mock=1`): scripted sessions, git, terminals, MCP — no backend needed |
| `src/transport/resolve-transport.ts` | Picks the transport from the environment (`acquireVsCodeApi`, `?server=`, `?mock=1`, same origin) |
| `src/prompt-template.ts` | Renders a prompt template into a form + text |

```bash
npm run test -w @morse/ui-runtime
npm run build -w @morse/ui-runtime
```

See [`docs/FRONTENDS.md`](../../docs/FRONTENDS.md) for what a frontend must implement.
