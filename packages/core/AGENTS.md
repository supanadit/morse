<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-10-07 | Last verified: 2026-10-07 -->

# packages/core — AGENTS.md

**Precedence:** the closest `AGENTS.md` wins. This file overrides the root for files under `packages/core/`.

## Overview

The use cases and the ports they own. Pure TypeScript: no framework, no I/O, no environment reads.

| Path | Holds |
| --- | --- |
| `src/domain.ts` | anemic shapes, value objects, sentinel errors — no I/O, no ports, no framework imports (R8) |
| `src/session/service.ts` | `SessionRegistry` (hot sessions, LRU, projects) and the `AgentGateway` driven port |
| `src/chat/service.ts` | the transcript/chat use case plus the local `ChatAgent` port (R10, satisfied structurally by `SessionRegistry`) |
| `src/context/service.ts` | the editor-context port (the VS Code host fills it) |
| `src/errors.ts`, `src/logger.ts` | sentinel errors and the `MorseLogger` port |

## Setup

`npm install` at the root, then build the libraries before type-checking anything that imports this one.

## Build / tests

| Task | Command |
| --- | --- |
| Build | `npm run build -w @morse/core` |
| Type-check | `npm run check-types -w @morse/core` |
| Tests | none — no `test` script here; root `npm run test:fast` starts at `host-runtime` |

## Code style

- Relative imports carry the extension: `from './domain.js'`.
- A port is declared in the module that owns its lifetime, next to the class that needs it (`src/<module>/service.ts`) — never in `domain.ts` (R2/R10).
- No `vscode`, no NestJS, no `node:*` (root rule 4). Log through `MorseLogger`, never `console`.
- `SessionRegistry` owns the hot-session LRU; the limit is the caller's (`hotLimit`), defaulting to 4.

## Security

This package reads no environment and touches no filesystem — every `process.env` and every path lives in a host (`packages/server/src/app/config.ts`, `packages/extension/src/internal/vscode/config.ts`, `packages/adapter-pi-rpc/src/internal/spawn-env.ts`). Adding either here is a boundary break: it would make the use case untestable without a host and would leak host policy into the domain.

## Commit / PR

- Conventional commits, one logical change per commit.
- A change to a port signature is an API change: update the implementer (`@morse/adapter-pi-rpc`, `@morse/host-runtime`) in the same commit.

## Examples

- `src/session/service.ts` — how a driven port is declared beside the registry that owns an agent's lifetime.
- `src/chat/service.ts` — a local port satisfied structurally, so the chat module never imports the session module's class.

## Gotchas

| Symptom | Cause / fix |
| --- | --- |
| Transcript lost on every refresh | the session was evicted — raise `MORSE_HOT_SESSIONS` (default 4) or `morse.sessions.hotLimit` |

## When stuck

| Need | File |
| --- | --- |
| session registry (hot sessions, LRU, projects) | `packages/core/src/session/service.ts` |
| the clean-architecture rules (R2 / R8 / R10) | `docs/ARCHITECTURE.md` §Ports and who owns them, §Rule mapping |
| who implements a port | `docs/ARCHITECTURE.md` §Two hosts, one behaviour |
