# @morse/protocol

The **wire contract** between a Morse host and a frontend: the DTOs, the client/host message
unions, the pure session-view reducer, and the protocol version.

Part of the [Morse](../../README.md) monorepo. Dependency-free on purpose — no `vscode`, no NestJS,
no `node:*` — so the same shapes can be imported by a host, a frontend, or a test.

## What is in here

| File | Contents |
|---|---|
| `src/dto.ts` | Serializable view/message DTOs (`SessionViewState`, `TranscriptItem`, `HostCapabilities`, git and MCP shapes, …) |
| `src/wire.ts` | `HostCommand`, `HostToClientMessage`, `ClientToHostMessage`, the type lists, encode/decode/parse helpers |
| `src/view.ts` | `SessionView` plus `reduceSessionView`, the pure reducer every frontend renders from |
| `src/version.ts` | `PROTOCOL_VERSION` and the frontend manifest filename |
| `src/frontend-manifest.ts` | Parse/identify `webview.manifest.json` |

## Changing the wire

A host refuses a frontend built for a different `PROTOCOL_VERSION`. When a message shape changes
in a breaking way **bump `src/version.ts` and rebuild the frontend** (`npm run build:ui` then
`npm run sync-webview`). Additive fields are safe; removing or renaming one is not.

```bash
npm run build -w @morse/protocol
npm run check-types -w @morse/protocol
```

See [`docs/FRONTENDS.md`](../../docs/FRONTENDS.md) for the frontend contract and
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for where this sits.
