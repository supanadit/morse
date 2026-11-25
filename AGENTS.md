# Morse — agent instructions

## What this is

Morse is an **agent-agnostic GUI for coding agents** (Pi and OpenCode). It is a chat panel in VS Code or a
browser UI served by a small NestJS host. Morse does **not** embed an agent — it talks to each engine through
its own RPC/API. One session list, one transcript, one set of shortcuts regardless of engine. Node 20+,
npm 10+; VS Code 1.138+ for the extension host.

## Commands

```bash
npm install
npm run build            # libraries -> Angular bundle -> webview sync -> extension + server
npm run dev:extension    # build once, then watch extension + UI + webview sync
npm run dev:server       # NestJS host with tsc --watch + node --watch
npm run dev:ui           # ng serve on :4200 (proxies /ws and /api to :4399)
npm run build:web        # npm artifact -> packages/morse-web/dist
npm run package          # build + write dist/morse.vsix
npm run check-types      # tsc --noEmit across all workspaces
npm run lint             # agent-boundary check + ESLint (extension)
npm run test:fast        # Vitest suites, no display needed
npm test                 # everything, incl. VS Code integration test (needs display / xvfb-run)
npm run clean
```

`test:fast` is the quick gate. The extension test downloads VS Code and needs a graphical session. Press
F5 in VS Code for the `morse: dev (build + watch)` prelaunch task; add `?mock=1` to the dev UI for an
in-memory host with no `pi` and no server.

## Layout (npm workspaces, `packages/*`)

| Package | Role |
|---|---|
| `agent` | Harness contract. Pure TS, **zero dependencies**, no project imports. Never imports `@morse/system`. |
| `protocol` | Versioned wire contract + view reducer. No project imports. |
| `engine-config` | Engine-generic config files/stores/Fix. Imports `protocol` only. |
| `system` | Domain, session index, use cases, host glue (`HostSessionController`). No `vscode`, NestJS or `child_process`. Imports `agent`, `protocol`. |
| `integration-pi` | Driven adapter: spawns `pi --mode rpc` (JSONL). Imports `agent`, `system`, `engine-config`. |
| `integration-opencode` | Driven adapter: HTTP + one SSE stream per engine. Same inward imports. |
| `ui-runtime` | Framework-free frontend core + transports. Imports `protocol`. |
| `ui-angular` | The only frontend. Angular; emits static bundle + `webview.manifest.json`. Imports `protocol`, `ui-runtime`. |
| `extension` | VS Code host, composition root #1. |
| `server` | NestJS host, composition root #2. |
| `morse-web` | npm delivery (`morse` CLI): bundles server + frontend. |

Dependency arrows point inward: `extension/server -> integrations -> system -> agent`, and
`protocol <- ui-runtime <- ui-angular`. Only integrations spawn processes or hold server connections; the
VS Code API appears only under `extension/src/internal/vscode/`; Angular only in `ui-angular`. Adapters
never import each other. `npm run lint` runs `scripts/check-agent-boundary.mjs`, which is the real guard
that `@morse/agent` stays dependency-free (npm hoisting makes `dependencies: {}` insufficient).

### Frontend layers (`ui-angular`), inner -> outer

`routing -> shell -> features -> ui -> services -> state -> host`. An import may point only to the right.
`ui/` imports nothing from `features/`, `shell/`, `routing/`; `services/` nothing from `ui/`; `state/`
nothing from `services/`; `host/` imports no other layer and only `@morse/protocol` + `@morse/ui-runtime`.
Any layer may import `protocol`/`ui-runtime`. `conventions.spec.ts` enforces these rules.

## Invariants — do not regress

- **Two hosts, one behaviour.** Both mount `HostSessionController` from `@morse/system`; a host supplies only
  a transport, capabilities, optional adapters (`NativeDialogs`, `EditorContextProvider`) and a command
  handler. Adding a capability row, host command or client message means updating **both** hosts — the
  exhaustive switches/derived types turn forgetting a host into a build failure.
- **Handshake.** Host answers `client/ready` immediately with truthful state (`agentStarting: true` while the
  engine spawns). The healthy path shows **no banner** — the badge carries `connecting -> starting -> ready`.
  Banners are only for real failures or a handshake pending >6 s.
- **Engine id space.** Sessions are keyed by Morse-derived ids from `(engine, engine session id)`; an
  `AgentRouter` resolves the owning engine so resume never guesses. The session index is the single shared
  truth under `<MORSE_HOME>/sessions` and both hosts refresh external changes.
- **NestJS host:** always use explicit `@Inject(...)` on constructor params (esbuild runners lack
  `emitDecoratorMetadata`; `dev:server` therefore uses `tsc --watch` + `node --watch`). Call
  `app.enableShutdownHooks()` and dispose sessions in `onModuleDestroy` or restarts leak `pi` processes and
  hit `EADDRINUSE`.
- **RPC framing (pi):** split on LF only, strip leading CR, never `readline` (splits on U+2028/U+2029),
  decode with `StringDecoder`, correlate by id, treat stderr as diagnostics only.
- **Performance:** `pi-rpc-session-catalog.ts` caches per-file summaries keyed by size+mtime and resumes from
  a byte offset; `ui/markdown/markdown.ts` re-renders streamed prose at most every 90 ms. Idle is genuinely
  idle — no polling/heartbeat. Keep these when editing those paths.
- **Protocol version:** `packages/protocol/src/version.ts`; each UI build writes `webview.manifest.json`,
  hosts refuse mismatched builds. Wire frames are validated by `parseClientMessage`/`parseHostMessage`.
- **Data compatibility:** `.morse/` carries a layout version; `morse start` migrates before any reader runs
  (stamped, resumable, backups). See `docs/DATA-COMPATIBILITY.md`.

## Where the details live

Read the relevant doc before changing that area — they are authoritative and more detailed than this file:

- `docs/ARCHITECTURE.md` — packages, layering, ports, two hosts, engine routing, bot mode, testing.
- `docs/DEVELOPMENT.md` — commands, F5/mock, build config, performance baselines.
- `docs/FRONTEND.md` — Angular frontend and wire contract.
- `docs/RELEASING.md` — release procedure (see mandatory checklist below).
- `docs/STATUS.md`, `docs/ROADMAP.md`, `docs/DATA-COMPATIBILITY.md`, `docs/CONFIGURATION.md`,
  `docs/PACKAGING.md`, `docs/INSTALL.md`.

## Releases — mandatory checklist

When the user asks to release, cut a version, or "create a tag and push so CI/CD picks it up", you MUST
follow [docs/RELEASING.md](docs/RELEASING.md) in full, every time. A release is never just `npm version` + tag.
Minimum checklist, in order:

1. Bump **every** manifest (root + all workspaces + lockfile) with an explicit version:
   `npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version`
2. Bump the `FRONTEND_IDENTITY` literal in
   `packages/ui-angular/src/app/host/morse.service.ts` — nothing auto-syncs it; `test:fast` fails if forgotten.
3. Bump the version in the first line of `docs/STATUS.md`.
4. Add a `## X.Y.Z` section to `packages/extension/CHANGELOG.md` (it becomes the GitHub Release body).
5. Run `npm run test:fast` locally and confirm green.
6. Commit, create an **annotated** tag (`git tag -a vX.Y.Z` — `--follow-tags` skips lightweight tags), then
   push with `git push origin master --follow-tags`.

Never force-move a tag that CI has already run against; if the release failed and you fixed code, ask or
explain, and prefer fixing forward. Verify the workflow started: `gh run list --limit 1`.
