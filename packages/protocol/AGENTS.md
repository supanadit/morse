<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-10-07 | Last verified: 2026-10-07 -->

# packages/protocol — AGENTS.md

**Precedence:** the closest `AGENTS.md` wins. This file overrides the root for files under `packages/protocol/`.

## Overview

The wire contract that both hosts and every frontend agree on. Types, constants and pure helpers only.

| File | Holds |
| --- | --- |
| `src/wire.ts` | client → host and host → client messages (`HostCapabilities` lives here) |
| `src/view.ts` | `SessionView` and `reduceSessionView` — the single reducer all frontends read |
| `src/dto.ts` | payload shapes: sessions, models, git, files, MCP, uploads |
| `src/lsp.ts` | file-preview language-server shapes |
| `src/frontend-manifest.ts` | `webview.manifest.json` — how a host identifies and validates a frontend |
| `src/version.ts` | `PROTOCOL_VERSION`, `FRONTEND_MANIFEST_FILE`, `DEFAULT_WS_PATH` |

## Setup

`npm install` at the root. No prerequisites of its own — but every workspace resolves `@morse/*` through `dist/`, so this library must be built before any type-check that imports it.

## Build / tests

| Task | Command |
| --- | --- |
| Build | `npm run build -w @morse/protocol` |
| Type-check | `npm run check-types -w @morse/protocol` |
| Tests | none — no `test` script in this workspace, and root `npm run test:fast` does not include it |

## Code style

- `type` / `interface` / `const` and pure functions only — no I/O, no behaviour-bearing classes.
- Relative imports carry the extension: `from './dto.js'`.
- Zero dependencies (root rule 4): no `vscode`, no NestJS, no `node:*`.
- `reduceSessionView` is the only reducer of view state: a host relays messages, it never post-processes the view.

## Security

Nothing in this package executes, which is the point — a browser bundle must be able to load the wire types without pulling a runtime surface, and the mock host in `@morse/ui-runtime` exists so a UI can be developed with no host at all. A `node:*` import here would be a boundary break, not a style choice.

## Commit / PR

- **A wire shape change is a breaking change**: bump `PROTOCOL_VERSION` in `src/version.ts` and rebuild the UI in the same change — a host refuses a frontend whose manifest disagrees.
- Conventional commits; `feat(protocol)!: …` when the version moves.

## Examples

- `src/version.ts` — the constants plus the doc comment that states the bump rule; copy that shape.
- `src/frontend-manifest.ts` — `createFrontendManifest()` / `isFrontendManifest()`: the pattern for a pure helper that both the UI build and a host call.

## Gotchas

| Symptom | Cause / fix |
| --- | --- |
| A host serves a stale UI, or ignores a freshly built one | the UI build writes `webview.manifest.json` next to `index.html` (`packages/ui-angular/scripts/write-manifest.mjs`); without it the host has no `protocolVersion` to compare and cannot identify the bundle |

## When stuck

| Need | File |
| --- | --- |
| protocol version | `packages/protocol/src/version.ts` |
| reasoning, layers and the rule map (R2/R8/R10) | `docs/ARCHITECTURE.md` (§Layers and dependency direction, §Rule mapping, §Protocol versioning and the frontend manifest) |
- What a frontend may rely on: `docs/FRONTENDS.md` (§The contract, §Rules a frontend must follow).
- A second frontend from the same contract: `docs/FRONTENDS.md` §Adding `ui-react`.
