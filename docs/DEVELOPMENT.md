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

## Performance notes

Measured on a Linux box against a real `pi` (Node 24, 155 session files / 199 MB) with the host running from
`packages/server/dist`. Useful as a baseline: two paths dominated everything, and both are load-bearing in the
code, so changing them without measuring is how this gets slow again.

| Path | Before | After |
|---|---|---|
| `session/list` (50 session files rescanned) | **624 ms CPU**, ~200 ms+ latency per call | **280 ms** cold, **2 ms** when nothing changed |
| `session/list` while the active 18 MB session grows | 65 ms per call | **0.3–0.6 ms** (tail read) |
| Server CPU for one prompt in a warm session | **49%** of one core (1.53 CPU-s) | **2.3%** (0.07 CPU-s) |
| Client render of a streamed 1 kB answer (77 deltas) | **156 ms** (jsdom) | **34 ms**, one render per 90 ms |

What keeps them cheap:

- `packages/adapter-pi-rpc/src/pi-rpc-session-catalog.ts` caches a summary per file, keyed by size + mtime, shares
  one build between concurrent callers, reads a line's `type` with a string search instead of `JSON.parse` on
  every one of tens of thousands of lines, and resumes a file that only grew from the byte offset the last scan
  stopped at. Re-reading files per list, or parsing every line again, brings the 600 ms back.
- `packages/ui-angular/src/app/shared/markdown/markdown.ts` re-renders streamed prose at most every 90 ms. Every
  delta used to mean a full `marked` + DOMPurify + highlight.js pass over the whole growing answer.

Idle is genuinely idle: no polling anywhere (no `setInterval` in the host, no heartbeat), and the whole tree
sits at 0.000% CPU with a live session. Memory is dominated by `pi`, not by Morse: one hot session measured
**275–450 MB** on the machine we tested — a ~150 MB `pi` process plus whatever that machine's own pi
configuration loads beside it — against **108 MB** for the server with no session. `MORSE_HOT_SESSIONS`
(default 4) multiplies the first number.
