# Publishing Morse as one npm package

The goal: `npm install -g @supanadit/morse-web && morse start` gives a browser user the same product as the
VS Code extension — Angular frontend, NestJS host, pi agent — with no monorepo, no build step and no VS Code.

The package that does this is `packages/morse-web` (published as `@supanadit/morse-web`). It is a **delivery
package**: no source of its own beyond the CLI, only build glue.

## The problem a single package has to solve

The monorepo ships nine workspace packages, and eight of them are `private: true`:

```
protocol, core, host-runtime, adapter-pi-rpc, ui-runtime, ui-angular, extension, server
```

npm installs a package's dependency tree from the registry, so a published `@morse/server` could never
resolve `@morse/core` — those names are not on npm. There are only three honest options:

| Option | Why not |
|---|---|
| Publish every workspace package | Not "one package"; every version bump becomes eight coordinated publishes |
| `bundleDependencies` (vendor `node_modules/@morse/*`) | Workspace symlinks + `*` versions make `npm pack` output fragile and hard to reason about |
| **Bundle the workspace code, externalize the runtime** | Chosen: one tarball, one version, deterministic output |

All of `protocol`, `core`, `host-runtime`, `adapter-pi-rpc` are pure ESM libraries with no `vscode`, no
NestJS and (except the adapter) no I/O, so inlining them is free. The NestJS runtime is *not* workspace code,
so it stays a normal dependency and is installed by npm.

## What the package contains

```
packages/morse-web/
├─ package.json        name @supanadit/morse-web, bin.morse -> dist/cli.mjs
├─ build.mjs           esbuild (server + cli) and the frontend copy
├─ tsconfig.json       type-checks src/cli.ts
├─ README.md           the npm landing page
├─ src/cli.ts          daemon lifecycle: start/stop/restart/status/logs
└─ dist/               generated, and the only thing published
   ├─ server.mjs       bundles the NestJS composition root + every @morse/*
   ├─ cli.mjs          `morse` (shebang baked in by esbuild)
   └─ ui/              packages/ui-angular/dist, copied verbatim
```

`files: ["dist", "README.md"]` means nothing else is in the tarball.

## How the build works

`packages/morse-web/build.mjs` runs two esbuild bundles and one copy:

1. **server** — entry `packages/server/src/main.ts`, `bundle: true`, `platform: node`, `format: esm`,
   `target: node20`.
   - `external: ['@nestjs/*', 'reflect-metadata', 'rxjs', 'rxjs/*', 'ws']` — the runtime npm installs.
   - `node:*` builtins are external automatically under `platform: node`.
   - `@morse/*` are left to resolve through the root `node_modules` symlinks and get inlined.
   - `tsconfig` points at `packages/server/tsconfig.json` so `experimentalDecorators` and
     `useDefineForClassFields: false` match the normal `tsc` build.
2. **cli** — entry `src/cli.ts`, same target, with `banner: { js: '#!/usr/bin/env node' }`.
3. **ui** — copies `packages/ui-angular/dist` to `dist/ui` (fails loudly if the frontend was never built).

Then:

```bash
npm run build:web        # libs -> ui -> package  (workspace-aware; no publish)
npm run publish:web      # build:web, then `npm publish -w @supanadit/morse-web`
```

`npm publish` also triggers the package's `prepack`, which reruns `build.mjs` — safe and idempotent.

## Runtime layout and why it resolves

`dist/server.mjs` and `dist/ui/` sit side by side, and `dist/cli.mjs` sets the environment before spawning
the server:

```ts
MORSE_UI_DIR    = <pkg>/dist/ui
MORSE_WORKSPACE = --workspace or process.cwd()
MORSE_PORT/HOST = --port/--host (default 4399 / 127.0.0.1)
```

`loadConfig()` in `packages/server/src/app/config.ts` also learns the new layout: when `MORSE_UI_DIR` is
unset it prefers `<bundle>/ui` if that holds an `index.html`, and only otherwise falls back to the
monorepo's `packages/ui-angular/dist`. So `node dist/server.mjs` works without the CLI too.

### The decorator-metadata trap

Nest's DI normally reads `design:paramtypes`, which **esbuild cannot emit**. Every provider in this repo
already uses explicit `@Inject(...)` — except one: `MorseGateway` took `MorseSessionFactory` by type.
That dependency was made explicit (`@Inject(MorseSessionFactory)`) so the bundle resolves DI exactly like
the `tsc` build. Any *new* Nest-instantiated class must use `@Inject(...)` on every parameter; see the
gotcha table in `AGENTS.md`.

## The CLI

`morse start` is daemon-first:

- **daemon by default** — the server is spawned `detached: true` with `stdio: ['ignore', logFd, logFd]`,
  then `child.unref()`, so the new process group survives the shell exiting. Start returns as soon as
  `GET /api/health` answers (up to 25 s).
- **state** — `~/.morse/server.json` (`MORSE_HOME` overrides) records pid, port, host, url, workspace,
  startedAt and the per-start `instance` token; `~/.morse/logs/server.log` holds stdout+stderr.
- **liveness** — the pid is only a hint. A force-killed daemon leaves the state file behind and its pid can
  be recycled by an unrelated process, so `start`/`status`/`stop` also require `/api/health` to answer with
  the same `instance` (state written before this token existed falls back to a healthy payload, legacy
  state without it too). A stale state file is cleared instead of reported as "already running".
- **`--foreground`** — runs the same bundle as a child with inherited stdio for systemd or containers, and
  still writes the state file so `status`/`stop` keep working.
- **port** — defaults to 4399; if nobody asked for a specific port and it is taken, the CLI picks the next
  free one instead of failing.
- **`stop`** — `SIGTERM`, wait 5 s, `SIGKILL`, clear state. `logs` is a dependency-free tail that also
  supports `--follow`.

The CLI owns only the process lifecycle. It never reimplements wire messages, the agent adapter or routing.

## Verifying a release

```bash
npm run build:web
npm run check-types
npm run test:fast
node packages/morse-web/dist/cli.mjs --version
node packages/morse-web/dist/cli.mjs help

# Inspect the exact artifact, without publishing:
npm pack -w @supanadit/morse-web --dry-run
```

Then, on a machine with `pi` installed:

```bash
npm install -g ./supanadit-morse-web-0.1.0.tgz
morse start --open
morse status
morse logs
morse stop
```

## Gotchas

| Symptom | Cause / fix |
|---|---|
| `Cannot find package '@morse/core'` at runtime | bundling did not inline it — the libs were not built before `build.mjs`; run `npm run build:libs` |
| `Nest can't resolve dependencies of X (?, …)` in the bundle only | a constructor parameter lost its `@Inject(...)`; esbuild cannot emit `design:paramtypes` |
| `ERR_MODULE_NOT_FOUND: @nestjs/platform-express` | `main.ts` imports the platform only as a type; keep `@nestjs/platform-express` in `dependencies` — Nest loads it dynamically at runtime |
| `morse start` prints "failed to start" | read `morse logs`; most often `pi` is not on the `PATH` of the daemon (set `MORSE_PI_PATH`) |
| Blank page after install | `dist/ui/index.html` missing — `build.mjs --ui` needs `packages/ui-angular/dist` |
| Port busy after an unclean exit | `morse status` / `morse stop`; state lives in `~/.morse/server.json` |
| `morse (start\|status)` says "already running" but nothing answers | stale state after a force-kill and a recycled pid; the instance token now catches it — just run `morse start` again |
