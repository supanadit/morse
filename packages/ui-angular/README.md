# @morse/ui-angular

The Angular frontend of Morse. It renders the wire protocol from `@morse/protocol` using the
framework-free client in `@morse/ui-runtime`, and it runs unchanged in both hosts:

- inside the VS Code webview (postMessage transport, provided by the extension),
- in a plain browser served by the NestJS host (WebSocket transport).

`Angular` knows nothing about either host: `src/app/core/transport.token.ts` resolves the transport at
startup, and `src/app/core/morse.service.ts` is the only file that binds Angular signals to the protocol.

Part of the [Morse](../../README.md) monorepo; this is the package the published frontend is built from.

## Development

```bash
npm run build -w @morse/ui-angular     # -> dist/ (+ webview.manifest.json)
npm run start -w @morse/ui-angular     # dev server

# http://localhost:4200/?mock=1                        in-memory mock host (no pi, no server)
# http://localhost:4200/?server=ws://127.0.0.1:4399/ws against the NestJS host
# http://localhost:4200/                               WebSocket on the same origin
```

The build output is what hosts serve. For the VS Code host, sync it into the extension:

```bash
npm run sync-webview
```

## Tests

```bash
npm run test -w @morse/ui-angular      # vitest + jsdom, using the in-memory transport
```

## Structure

```text
src/app/host/            transport token, MorseService (Angular <-> protocol), app-local state
src/app/features/        one folder per surface: transcript, composer, session nav, git, MCP,
                         terminal, pickers, bot mode, and the setup screen
src/app/shell/           the app shell, activity rail, toolbar and status bar
src/app/state/           tabs, workbench, MCP, git and other stores
src/app/services/        shortcuts, updates, workspace files
src/app/ui/              shared DOM primitives: panes, splitter, markdown, tree list, icons
src/styles.css           VS Code theme variables with browser fallbacks
scripts/write-manifest.mjs  writes the frontend manifest hosts validate against
```

See [`docs/FRONTEND.md`](../../docs/FRONTEND.md) for the wire contract this frontend implements.
