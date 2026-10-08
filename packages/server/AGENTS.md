<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-10-07 | Last verified: 2026-10-07 -->

# packages/server — AGENTS.md

**Precedence:** the closest `AGENTS.md` wins. This file overrides the root for files under `packages/server/`.

## Overview

The browser host: NestJS serves the static frontend, exposes `/ws` for the protocol, and owns the things a browser cannot — the filesystem, a PTY, a language server, git.

| Path | Holds |
| --- | --- |
| `src/main.ts`, `src/app.module.ts` | bootstrap and wiring (`enableShutdownHooks()`) |
| `src/app/config.ts` | every `MORSE_*` env var and the frontend manifest it serves |
| `src/internal/ws/` | the gateway and the session factory |
| `src/internal/workspace/` | `file-store.ts` (read/list), `git-log.ts`, `workbench-store.ts`, `workspace-index.ts`, `directory-browser.ts` |
| `src/internal/terminal/terminal.service.ts` | the PTY registry, idle reaper and scrollback |
| `src/internal/lsp/` | `lsp.service.ts` registry, `lsp-client.ts` stdio JSON-RPC, `language-servers.ts` resolution, `lsp-mapping.ts` translation |
| `src/internal/projects/project-policy.ts` | which directories may run an agent |
| `src/internal/uploads/upload-store.ts` | dragged-file bytes → a path a prompt can `@mention` |
| `src/internal/http/health.controller.ts` | `/api/health` and its `instance` token |

## Setup

`npm install` at the root (node-pty compiles — g++/make/python3 required), then `npm run build` so the libraries exist. `npm run dev:server` is tsc `--watch` + `node --watch`.

## Build / tests

| Task | Command |
| --- | --- |
| Build | `npm run build -w @morse/server` |
| Type-check | `npm run check-types -w @morse/server` |
| Tests | `npm run test -w @morse/server` (vitest) — part of `npm run test:fast` |
| Pipeline check, no model call | `node packages/server/scripts/ws-smoke.mjs ws://127.0.0.1:4399/ws` |

## Code style

- **Explicit `@Inject(...)` on every constructor parameter** — esbuild/`tsx` cannot emit decorator metadata, so a bare type-only parameter fails at runtime with `Nest can't resolve dependencies`.
- ESM: relative imports carry the extension (`from './internal/registry.js'`).
- Shutdown must be explicit: `enableShutdownHooks()` plus `onModuleDestroy` disposing sessions, or a restart leaks `pi` processes and the port.
- Anything a browser asks for arrives as a relative, session-scoped path — resolve it in `file-store.ts`, do not accept what a frontend sends.
- `terminal.service.ts` spawns the user's shell through `terminalShellEnv()`: the PTY gets the user's environment, not the server's.

## Security

Three boundaries live in this package and none of them is optional: `ProjectPolicy` decides which directories may run an agent, `file-store.ts` resolves a path against the viewing session's cwd and rejects absolute or `..` paths, and `upload-store.ts` caps an upload at `MAX_UPLOAD_BYTES` (10 MiB) under the session's own directory. The host listens on `127.0.0.1` by default and has no user authentication — the only secret is the per-start `MORSE_INSTANCE` token that `/api/health` echoes — so changing `MORSE_HOST` is a deliberate exposure. Never log an env value or a token.

## Commit / PR

- Conventional commits, one logical change per commit.
- A new env var means: parse it in `src/app/config.ts`, document it in `docs/CONFIGURATION.md` and in the CLI's `--help`, and add it to the scoped list here if it changes behaviour a reader must know.

## Examples

- `src/app/config.ts` — the one place env is read; every value has a default and is parsed, not trusted.
- `src/internal/terminal/terminal.service.ts` — service lifecycle, `onModuleDestroy`, and the idle reaper in one file.
- `src/internal/workspace/git-log.ts` — `gitExec` keeps stdout *and* stderr, because git reports "nothing to commit" on stdout.
- `packages/server/src/internal/projects/project-policy.ts` — a deny-by-default policy object, not a scattered `if`.

## Gotchas

| Symptom | Cause / fix |
| --- | --- |
| `Nest can't resolve dependencies of X (?, …)` | add `@Inject(...)`; esbuild/`tsx` cannot emit decorator metadata |
| `EADDRINUSE` or leaked `pi` after restart | `enableShutdownHooks()` + `onModuleDestroy` disposing sessions |
| TS5107 about `moduleResolution: node10` | deprecated in TS 6 -> `Node16` / `NodeNext` |
| `require()` of an ESM-only package | NestJS 12 and all `@morse/*` are ESM |
| `node --watch` gives up after a crash | it restarts on file change only |
| Agent runs in the wrong project | sessions carry their own cwd; check `project/open`/`session/activate` payloads and the `ProjectPolicy` |
| Agent gets `packages/server` as its project | `MORSE_WORKSPACE` was unset inside a monorepo package; the host now defaults to the workspace root |
| Commit shows `Command failed: git commit -m …` | git puts `nothing to commit` on **stdout**, so `gitExec` keeps stdout/stderr and `commitGit` maps it to "Nothing is staged to commit."; `submitCommit` also guards an empty index so Enter never asks git (see `git-log.ts`, `git-panel.ts`) |
| A preview refuses a file, or opens nothing | `readFile` resolves the path against the viewing session's cwd and rejects an absolute or `..` path (`packages/server/src/internal/workspace/file-store.ts`); the Explorer only offers paths from `listFiles` |
| Restored terminal shows a fresh prompt | the shell is gone: the PTY lives in the host's registry and is reclaimed after `MORSE_TERMINAL_IDLE_MS` (default 30 min, `0` disables) or when the host restarts. A page reload reattaches to the live shell and replays what it missed; the scrollback is also written under `<MORSE_HOME>/terminals/`, so after a host restart you get the old output plus a new prompt. The fresh shell opens in the directory the pane last reported (OSC 7), not the session root, so a `cd` survives the restart too. `terminal/close` ends it for good. |
| Running Morse from inside Morse fails with `EADDRINUSE`, or picks up the host's settings | the PTY used to inherit the server's environment. `terminal.service.ts` now spawns the shell with `terminalShellEnv()`, which strips `MORSE_*` (and the `fork` IPC vars), so the terminal has only the user's environment — a nested `npm run dev` uses its own defaults instead of the host's `MORSE_PORT`/`MORSE_WORKSPACE` |

## When stuck

| Need | File |
| --- | --- |
| NestJS wiring and env | `packages/server/src/app.module.ts`, `packages/server/src/app/config.ts` |
| the preview's language server (hover, jump, squiggles, references) | `packages/server/src/internal/lsp/` (`lsp.service.ts` registry, `lsp-client.ts` stdio JSON-RPC, `language-servers.ts` resolution, `lsp-mapping.ts` translation) ← `capabilities.lsp`, the `lsp*` host commands, and `features/workbench/file-preview/` (`preview-positions.ts` maps a pointer to a zero-based position and back) |
| which directories may run an agent | `packages/server/src/internal/projects/project-policy.ts` |
| git history + graph panel (browser host) | `packages/ui-angular/src/app/features/git/git-panel/git-panel.ts` ← `@morse/ui-runtime` (`git/graph.ts`), `packages/server/src/internal/workspace/git-log.ts` |
| open tabs / focused tab / terminals / per-tab drafts across a reload (browser host) | `packages/ui-angular/src/app/services/workbench-persistence.ts` ← `readWorkbench`/`saveWorkbench` + `readDrafts`/`saveDrafts`, `packages/server/src/internal/workspace/workbench-store.ts` |
| env vars a user can set | `docs/CONFIGURATION.md` §Browser host environment |
| why the host is shaped this way | `docs/ARCHITECTURE.md` §NestJS host specifics, §UI shape follows the host scope |
