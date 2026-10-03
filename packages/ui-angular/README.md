# @morse/ui-angular

The Angular frontend of Morse. It renders the wire protocol from `@morse/protocol` using the
framework-free client in `@morse/ui-runtime`, and it runs unchanged in both hosts:

- inside the VS Code webview (postMessage transport, provided by the extension),
- in a plain browser served by the NestJS host (WebSocket transport).

`Angular` knows nothing about either host: `src/app/core/transport.token.ts` resolves the transport at
startup, and `src/app/core/morse.service.ts` is the only file that binds Angular signals to the protocol.

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
npm run sync-webview -- --frontend=<folder>     # or --frontend=ui-angular
```

## Tests

```bash
npm run test -w @morse/ui-angular      # vitest + jsdom, using the in-memory transport
```

## Structure

```
src/app/core/            transport token + MorseService (Angular <-> protocol binding)
src/app/chat/            project-browser, session-bar, chat-transcript, tool-card, chat-composer, interaction-panel
src/styles.css           VS Code theme variables with browser fallbacks
scripts/write-manifest.mjs  writes the frontend manifest hosts validate against
```

See `docs/FRONTENDS.md` in the repository root for what a frontend must implement, and how to add a
React or Svelte alternative without touching any host.
