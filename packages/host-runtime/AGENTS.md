<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-10-07 | Last verified: 2026-10-07 -->

# packages/host-runtime — AGENTS.md

**Precedence:** the closest `AGENTS.md` wins. This file overrides the root for files under `packages/host-runtime/`.

## Overview

Host glue shared by both hosts: it turns protocol messages into calls on the core use cases, and core state back into `SessionView`. No VS Code, no NestJS — only `@morse/protocol` and `@morse/core` types.

| Path | Holds |
| --- | --- |
| `src/session-controller.ts` | `HostSessionController` — routes every client message for one surface |
| `src/transcript-projector.ts` | agent events → transcript items |
| `src/transcript-store.ts` | the transcript items and their guards (`items()`) |
| `src/view-state.ts` | persisting/restoring surface state (webview state, mock memory) |
| `src/terminal.ts`, `src/terminal-buffer.ts` | the terminal port and its scrollback buffer |
| `src/native-dialogs.ts` | the dialog port a host fills |

## Setup

`npm install` at the root and build `@morse/protocol` + `@morse/core` first — this package imports their `dist/`.

## Build / tests

| Task | Command |
| --- | --- |
| Build | `npm run build -w @morse/host-runtime` |
| Type-check | `npm run check-types -w @morse/host-runtime` |
| Tests | `npm run test -w @morse/host-runtime` (vitest) — also part of `npm run test:fast` |

## Code style

- Relative imports carry the extension: `from './terminal.js'`.
- New UI data means: a protocol message in `packages/protocol/src/wire.ts`, then routing here in `session-controller.ts` — a host never invents view fields of its own.
- The controller is the only place that answers a client message; a host wires it and stays thin.
- A terminal is released by an explicit reader close, never by a view being destroyed: `Terminal` must not send `terminal/close` from `dispose`. The host reclaims an idle PTY on its own timer.

## Security

The controller is a policy boundary: it filters projects and sessions to the workspace roots the host allowed and refuses an agent outside them — a `project/open` or `session/activate` for a foreign path must be rejected here, not by hoping the host checked. Nothing in this package reads credentials or the filesystem; pass paths down as opaque refs and let the host resolve them.

## Commit / PR

- Conventional commits, one logical change per commit.
- A controller behaviour change is a behaviour change for *both* hosts: say so in the message and run `npm run test:fast`.

## Examples

- `src/session-controller.ts` — message → use case → view update; the routing table is the shape to extend.
- `src/transcript-projector.ts` — event → item mapping, with the store as its only sink.
- `src/terminal-buffer.ts` + `terminal-buffer.spec.ts` — a pure unit beside its spec.

## Gotchas

| Symptom | Cause / fix |
| --- | --- |
| Resumed session shows an empty panel | history is seeded from `get_messages`; check `AgentGateway.history()` and the store's `items()` guard |

## When stuck

| Need | File |
| --- | --- |
| client message routing | `packages/host-runtime/src/session-controller.ts` |
| a session as its own VS Code editor tab (pinned controller, restore) | `packages/ui-angular/src/app/features/surfaces/session-page/session-page.ts` ← `HostSessionController` option `pinnedSessionId`, `capabilities.sessionTabs`, `openSessionTab`/`closeSessionTab`, the `morse.openSessionTab` command; the sidebar row is `features/nav/session-nav` |
| bottom panel + terminal (browser host) | `packages/ui-angular/src/app/features/workbench/bottom-panel/`, `features/workbench/terminal/` ← `state/panel-state.ts`, `packages/host-runtime/src/terminal.ts`, `packages/server/src/internal/terminal/terminal.service.ts`; clickable URLs are `features/workbench/terminal/terminal-links.ts` |
| what each host must implement | `docs/ARCHITECTURE.md` §Two hosts, one behaviour |
