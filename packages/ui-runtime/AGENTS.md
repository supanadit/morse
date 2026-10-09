<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-10-07 | Last verified: 2026-10-07 -->

# packages/ui-runtime — AGENTS.md

**Precedence:** the closest `AGENTS.md` wins. This file overrides the root for files under `packages/ui-runtime/`.

## Overview

Everything a frontend needs that is not a view: the transport that reaches a host, the client that turns calls into protocol messages, and the prompt-template expansion. One implementation serves every frontend.

| Path | Holds |
| --- | --- |
| `src/client.ts` | `HostClient` — actions over a transport, plus the command list |
| `src/transport/host-transport.ts` | the transport port |
| `src/transport/resolve-transport.ts` | webview → mock → `?server=` → same-origin `/ws` |
| `src/transport/vscode-transport.ts` | the `postMessage` bridge |
| `src/transport/websocket-transport.ts` | the browser host |
| `src/transport/memory-transport.ts` | the in-memory mock host (scripted answers, no model) |
| `src/prompt-template.ts` | the one expansion of `$1`/`{{args}}`/frontmatter that the composer and the palette both call |
| `src/git/`, `src/files/`, `src/transcript/`, `src/palette/`, `src/lsp/`, `src/ui/` | framework-free helpers: git graph/status/diff, file tree and preview positions, transcript rows/tasks/tools/usage, command ranking, the `host/command` reply guards, popover placement |
| `src/render/` | the markdown render pipeline: `highlight.ts`, `markdown.ts` (DOMPurify-sanitized), `annotation-mirror.ts` |
| `src/prompt/render.ts` | the editor's inverse of `prompt-template.ts` — a draft back to a template file |
| `src/terminal/links.ts` | `findTerminalLinks` — URL detection for the bottom panel's terminal (the xterm binding stays in `ui-angular`) |

## Setup

`npm install` at the root, then build `@morse/protocol` before type-checking here.

## Build / tests

| Task | Command |
| --- | --- |
| Build | `npm run build -w @morse/ui-runtime` |
| Type-check | `npm run check-types -w @morse/ui-runtime` |
| Tests | `npm run test -w @morse/ui-runtime` (vitest) — part of `npm run test:fast` |

## Code style

- Relative imports carry the extension: `from './host-transport.js'`.
- A new transport implements `HostTransport`; a new frontend uses `resolveTransport()` and never branches on `hasVsCodeApi()` itself.
- The prompt-template expansion lives here for a reason: a second implementation in a view would drift from the one the composer sends. Views call it, never re-implement it.
- A framework-free, frontend-reusable helper lives here, not in a UI package: a second frontend must import it, never copy it. A moved module keeps its behaviour; only its relative import gains the `.js` extension.
- A spec that touches the DOM carries `// @vitest-environment jsdom` as its first line; every other spec runs under the node default. `package.json` sets `"sideEffects": false` so an unused re-export (for example a module only a lazily loaded view imports) is tree-shaken out of an eager bundle.

## Security

The transport decides which host a UI talks to: `?server=` (and the `?mock=1` bypass) come from the page URL, so a link can point a UI at another machine. Treat the transport as an untrusted-input boundary — validate what arrives, and never carry a credential or a token in the URL or in `localStorage`. The host is the side that must authorize; the frontend cannot.

## Commit / PR

- Conventional commits, one logical change per commit.
- Changing `HostTransport` means touching both host implementations in one change. `HostCommand` additions belong in `@morse/protocol` first.

## Examples

- `src/transport/resolve-transport.ts` — an ordered decision with each branch commented; extend it, do not parallel it.
- `src/transport/memory-transport.ts` — the mock host: how a UI is developed and reviewed with no `pi` process anywhere.
- `src/prompt-template.spec.ts` — the expansion's cases; add one with every syntax change.

## Gotchas

| Symptom | Cause / fix |
| --- | --- |
| A UI renders but every action silently does nothing | the mock host answers only what it scripts: `?mock=1` is for reviewing a view, not for exercising a new host command |

## When stuck

| Need | File |
| --- | --- |
| transport choice (webview / WS / mock) | `packages/ui-runtime/src/transport/resolve-transport.ts` |
| prompt-template editor + argument tester | `packages/ui-angular/src/app/features/prompt-editor/` ← `state/prompt-templates-state.ts`, `packages/ui-runtime/src/prompt-template.ts` (the same expansion the composer uses); host file I/O in `packages/adapter-pi-rpc/src/pi-prompts.ts` (`promptTemplates`/`promptTemplateSave`/`promptTemplateDelete`); a new/edited file is picked up automatically by `PiRpcAgent`’s `PromptWatcher` (`internal/prompt-watch.ts`). A Morse command (`view.prompts`, `Ctrl+Alt+E`), opened like the MCP editor as a tab (browser) or a `#/prompts` `WebviewPanel` (VS Code, `openPromptEditor`); code-split — the browser mounts it with a lazy `import()`, the route row carries a `load`. Scope follows the session: global user prompts, plus the project's `.pi/prompts` when one is in front |
| the contract a frontend must keep | `docs/FRONTENDS.md` §Rules a frontend must follow |
| developing a view with no host | `docs/FRONTENDS.md` §Developing a frontend without any host (`?mock=1&boot=1&empty=1`) |
