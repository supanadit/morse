# @morse/server

The **browser host**: a NestJS application that serves the built Angular frontend and drives the
same pi agent over WebSocket. It is one of the two composition roots (the VS Code extension is the
other) — the only layer that knows the concrete adapter, the core services and the delivery at once.

Part of the [Morse](../../README.md) monorepo. The published `@supanadit/morse-web` package bundles
this server together with the inlined `@morse/*` libraries and the frontend.

## What is in here

| Path | Contents |
|---|---|
| `src/app.module.ts` | The NestJS composition root: config, logger, adapter, registry, transcripts, policy, gateway |
| `src/app/config.ts` | Env-driven config (`MORSE_*`): port, workspace, pi path, hot sessions, data dir, … |
| `src/app/tokens.ts` | DI tokens (`MORSE_CONFIG`, `MORSE_LOGGER`, `MORSE_PI_ADAPTER`, …) |
| `src/internal/ws/morse.gateway.ts` | One `HostSessionController` per WebSocket; a shared registry so sessions outlive a connection |
| `src/internal/ws/session-factory.service.ts` | Per-connection wiring, capabilities, and the host commands (files, git, uploads, MCP) |
| `src/internal/workspace/` | `file-store`, `git-log`, `directory-browser`, `workbench-store`, `workspace-index` |
| `src/internal/terminal/` | The `node-pty` terminal backend for the bottom panel |
| `src/internal/uploads/`, `internal/http/`, `internal/projects/`, `internal/logging/` | Upload inbox, `/api/health`, the project allow-list, the Nest logger |

## Run it

```bash
npm run dev:server     # tsc --watch + node --watch
npm run build -w @morse/server
node packages/server/dist/main.js
```

NestJS DI cannot emit decorator metadata under esbuild, so **every constructor parameter needs an
explicit `@Inject(...)`**. The agent runs wherever `MORSE_WORKSPACE` (or the workspace root) points;
`MORSE_PROJECTS` narrows what it may open.

```bash
node packages/server/scripts/ws-smoke.mjs ws://127.0.0.1:4399/ws   # pipeline check, no model call
```

See [`docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md) for every `MORSE_*` variable, and
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for the host's place in the layers.
