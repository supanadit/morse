# @morse/host-runtime

The **host glue** both hosts share: the application service that owns the wire conversation for one
client and projects agent events back onto it. VS Code and the NestJS server both mount this same
controller; only the delivery (webview vs WebSocket) differs.

Part of the [Morse](../../README.md) monorepo. Technology-agnostic — it depends on `@morse/protocol`
and the `@morse/core` types, never on `vscode` or NestJS.

## What is in here

| File | Contents |
|---|---|
| `src/session-controller.ts` | `HostSessionController` — routes client messages into the core use cases, owns per-session transcript projectors, the draft state, interactions, host commands and terminals |
| `src/view-state.ts` | `AgentSessionState` → `SessionViewState` (and the empty/draft states) |
| `src/transcript-projector.ts` | Maps agent events to transcript items/updates |
| `src/transcript-store.ts` | Keeps each session's transcript warm across client reconnects |
| `src/native-dialogs.ts` | The `NativeDialogs` port (VS Code implements it; the browser renders in the UI) and `HostCommandHandler`/`HostCommandContext` |
| `src/terminal.ts`, `src/terminal-buffer.ts` | The `TerminalBackend` port and the scrollback buffer |

`HostSessionControllerOptions` is the seam: `capabilities`, `scope` (global vs workspace), `dialogs`,
`onHostCommand`, `terminal`, `policy`. A host wires what it can do; the frontend reads
`capabilities` instead of guessing.

```bash
npm run test -w @morse/host-runtime
npm run build -w @morse/host-runtime
```

See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for where this sits between a host and the core.
