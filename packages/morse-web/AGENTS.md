<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-10-07 | Last verified: 2026-10-07 -->

# packages/morse-web — AGENTS.md

**Precedence:** the closest `AGENTS.md` wins. This file overrides the root for files under `packages/morse-web/`.

## Overview

The npm delivery of the browser host: one package that bundles the NestJS server, the CLI and the UI build, so `morse start` is the whole install.

| Path | Holds |
| --- | --- |
| `build.mjs` | bundles server + CLI (`--server --cli`) and the UI (`--ui`); refuses a bundle with an inlined CommonJS require |
| `src/cli.ts` | `morse start`/`stop`/`status`/`logs`, the daemon, and the state file |
| `dist/` | generated — never edit |

## Setup

`npm install` at the root; `build.mjs` needs the libraries and the UI built first (`npm run build:web` does that).

## Build / tests

| Task | Command |
| --- | --- |
| Build the artifact | `npm run build:web` → `packages/morse-web/dist` |
| Server + CLI only | `npm run build:server -w @supanadit/morse-web` |
| Type-check | `npm run check-types -w @supanadit/morse-web` |
| Inspect without publishing | `npm pack -w @supanadit/morse-web --dry-run` (what CI runs) |
| Publish | `npm run publish:web` |

## Code style

- A dependency that is imported but must stay a real `node_modules` entry belongs in **both** `runtimeExternals` in `build.mjs` and `dependencies` in `package.json` — one without the other is the bug the build now refuses.
- `build.mjs` is the only place the bundle shape is decided; keep the assertions (`assertServerLoads`) rather than deleting them.
- The CLI's user-visible output is a contract: it is what `morse start` prints, what `--help` lists, and what `docs/PACKAGING.md` documents.

## Security

The state file is the trust anchor for `start`/`status`: a pid alone is not proof that a daemon is still ours, so a random `instance` token is minted per start, passed to the server as `MORSE_INSTANCE`, and required back from `/api/health`. Never weaken that check to "the pid exists", and never write a secret into `~/.morse/server.json` — it is plain text in the user's home.

## Commit / PR

- Conventional commits, one logical change per commit.
- A new runtime dependency needs the `runtimeExternals` + `dependencies` pair in one commit, plus a note in `docs/PACKAGING.md` if it changes what ships.

## Examples

- `build.mjs` — the two builds, the externals list and the load assertion that catches a broken artifact before npm does.
- `src/cli.ts` — daemon lifecycle: mint the instance, write the state, wait for health, and treat a mismatch as "not running".
- `docs/PACKAGING.md` §The decorator-metadata trap — why the server needs `reflect-metadata` at runtime.

## Gotchas

| Symptom | Cause / fix |
| --- | --- |
| `morse start`/`status` claims a daemon is running that is gone | stale `~/.morse/server.json` after a force-kill and a recycled pid; the pid alone is not proof, so `/api/health` must echo the state's `instance` token (`packages/morse-web/src/cli.ts` → `isServerRunning`) |
| `morse start` hangs ~25 s then fails; `morse logs` shows `Dynamic require of "process" is not supported` | a CommonJS dependency was inlined into the ESM bundle (`yaml` → `require('process')`). Add it to `runtimeExternals` **and** `dependencies` in `packages/morse-web`; `build.mjs` now refuses to emit such a bundle |

## When stuck

| Need | File |
| --- | --- |
| npm package (`morse start`) | `packages/morse-web/build.mjs`, `packages/morse-web/src/cli.ts`, `docs/PACKAGING.md` |
| what the published package contains | `docs/PACKAGING.md` §What the package contains, §Runtime layout and why it resolves |
| installing from npm or a local tarball | `docs/INSTALL.md` §2 |
| releasing | `docs/RELEASING.md`, `.github/workflows/release.yml` |
