# Development

```bash
npm install
npm run build            # libraries -> Angular bundle -> webview sync -> extension + server
```

| Command | What it does |
|---|---|
| `npm run build` | Full build (libraries, UI, webview sync, extension, server) |
| `npm run dev:extension` | Build once, then watch extension + UI + webview sync |
| `npm run dev:server` | NestJS host with `tsc --watch` + `node --watch` |
| `npm run dev:ui` | `ng serve` on `:4200`; `/ws` and `/api` proxy to `127.0.0.1:4399` |
| `npm run build:web` | Build the npm artifact into `packages/morse-web/dist` |
| `npm run package` | Build and write `dist/morse.vsix` (verifies the webview bundle first) |
| `npm run check-types` | `tsc --noEmit` across every workspace |
| `npm run lint` | ESLint (extension) |
| `npm run test:fast` | Vitest suites (ui-runtime, ui-angular), no display needed |
| `npm test` | Everything, including the VS Code integration test (downloads VS Code; needs a display or `xvfb-run`) |
| `npm run clean` | Remove build output |

Press <kbd>F5</kbd> in VS Code to run the extension with the **morse: dev (build + watch)** prelaunch task.
Add `?mock=1` to the dev UI to work on it against an in-memory mock host, with no `pi` and no server.

Two host-level checks run against a live server without calling a model:

```bash
node packages/server/scripts/ws-smoke.mjs ws://127.0.0.1:4399/ws   # pipeline
node packages/server/scripts/ws-projects-check.mjs                 # two projects, two sessions
node packages/server/scripts/ws-lease-check.mjs                    # refresh reuses session + transcript
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the layout and layering rules, and
[`PACKAGING.md`](PACKAGING.md) for how the browser host becomes one npm package.
