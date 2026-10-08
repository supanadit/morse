<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-10-07 | Last verified: 2026-10-07 -->

# packages/extension — AGENTS.md

**Precedence:** the closest `AGENTS.md` wins. This file overrides the root for files under `packages/extension/`.

## Overview

The VS Code host: a workbench-side composition root that spawns the same adapter and serves the same frontend bundle, plus everything only a workbench can do (editor commands, the native explorer, its own LSP).

| Path | Holds |
| --- | --- |
| `src/app/main.ts` | activation, command registration, `resolvePiEnv` |
| `src/internal/vscode/` | hosts: `chat-view-provider.ts` (the webview and its panels), `config.ts` (settings), `webview-html.ts` (CSP + nonces), `shell-path.ts`, `project-policy.ts`, `workspace-index.ts` |
| `esbuild.js` | the extension bundle (CJS, `vscode` external) |
| `scripts/sync-webview.mjs`, `scripts/verify-webview.mjs` | copying the UI build in, and refusing a development one |
| `src/test/extension.test.ts` | the integration test (`vscode-test`, needs a display) |
| `media/`, `out/`, `dist/` | generated — never edit |

## Setup

`npm install` at the root, then `npm run build` (the extension needs the built libraries and a synced webview). Press F5 for the Extension Development Host; `npm run dev:extension` watches extension + UI + webview.

## Build / tests

| Task | Command |
| --- | --- |
| Build | `npm run build:extension` (esbuild, no type-check) |
| Type-check | `npm run check-types -w morse` |
| Lint | `npm run lint -w morse` |
| Integration test | `npm test` at the root, or `xvfb-run -a npm test -w morse` in CI |
| Package | `npm run package` (root) → `dist/morse.vsix`, refuses a development webview bundle |

## Code style

- This is the one CommonJS bundle in the repo (esbuild → CJS) and the one place `vscode` may be imported; every library it consumes is ESM.
- A new capability the workbench must advertise goes in `HostCapabilities` (`packages/protocol/src/wire.ts`) and is set here — a frontend hides a feature when the capability is off rather than trying it.
- A new panel: register it in `activationEvents` (`onWebviewPanel:<viewType>`) and add exactly one `registerWebviewPanelSerializer` entry per view type, or a reload loses it.
- Generated output is off limits: `media/webview`, `out/`, `dist/`, `.vscode-test`.

## Security

The webview CSP is the boundary: `renderWebviewHtml` must keep `script-src 'nonce-…' 'strict-dynamic'` (with `cspSource` as the fallback for an engine that ignores it), and the registry allow-list must include any new origin a panel talks to. The extension never passes a secret into the webview, and it resolves the user's login-shell `PATH` rather than guessing at a `pi` location. `verify-webview.mjs` is what stops a development bundle reaching a VSIX.

## Commit / PR

- Conventional commits, one logical change per commit; `feat(vscode): …` for host work.
- A UI change needs `npm run sync-webview` before packaging; say in the message if you rebuilt the webview.

## Examples

- `src/internal/vscode/webview-html.ts` — HTML + CSP + nonces in one function; the comments explain why `'strict-dynamic'` is load-bearing.
- `src/internal/vscode/shell-path.ts` — resolving the login shell once, for the Dock-launch case.
- `src/internal/vscode/chat-view-provider.ts` — the provider that creates controllers, panels and serializers for both surfaces.

## Gotchas

| Symptom | Cause / fix |
| --- | --- |
| VSIX contains unminified `main.js` and no manifest | a dev webview was packaged; `verify-webview.mjs` blocks it |
| "Open in editor tab" is missing from a session's menu, or the command opens nothing | the host does not advertise `capabilities.sessionTabs`. Only VS Code has an editor surface; the browser host's tab strip is a different feature (`filePreview`). The row is hidden on purpose rather than offered and ignored |
| A session tab (or the prompt-template editor) is completely blank | the webview CSP is `script-src 'nonce-…'` without `'strict-dynamic'`, so a code-split chunk — a runtime `import()` that carries none of the nonces VS Code injects into `index.html` — is blocked. `renderWebviewHtml` must keep `'strict-dynamic'` (plus `cspSource` as the fallback for an engine that ignores it). The MCP editor is eager (`component:`, not `load:`) and so never showed this |
| A restored session tab does not come back, or comes back empty | the session id rides in the webview state (`morse.view.sessionTab`, written by `routing/session-page/session-page.ts`, read by `readSessionTabState`). A tab restored without it is closed on purpose — a tab cannot be re-pinned to a conversation it does not know. All tabs share one view type (`morse.sessionTab`), so `registerWebviewPanelSerializer` needs exactly one entry for it |
| No Explorer in VS Code | intended: the Explorer and tab strip exist only where `capabilities.filePreview` is set (the browser host); VS Code keeps its native explorer, editor and tabs |
| No git panel in VS Code | intended: `capabilities.gitPanel` is the browser host's; VS Code has its own Source Control view |
| The MCP editor opens as a blank VS Code tab | the panel serves the same bundle routed `#/mcp`; `ui-angular/src/app/routing/routes.ts` maps a hash to a root component and `main.ts` bootstraps it into an element it creates (never a selector match, which caused NG05104). `chat-view-provider.openMcpEditor` also starts a `HostSessionController` for the panel |
| An MCP entry (or its tab) is lost on reload | the form is kept by `ui-angular/src/app/host/view-state.ts` (VS Code webview `setState`, browser `localStorage`); the VS Code panel is restored by `registerWebviewPanelSerializer` (`chat-view-provider.registerSerializers`, activated by `onWebviewPanel:morse.mcpEditor`), and the browser tab by `WorkspaceTabs.snapshot/restore`. A dropped draft means a host that cannot persist the webview state and a storage that refused |
| Setup screen says pi is not installed, but it works in the terminal | VS Code from the Dock/launcher does not source the login profile, so a `pi` installed by nvm/asdf/volta is missing from the extension host's PATH. The extension resolves the login shell PATH once when pi is not already visible (`internal/vscode/shell-path.ts` → `resolvePiEnv` in `app/main.ts`) and passes it to the adapter as `env`. Reload the window after changing `morse.pi.path` |

## When stuck

| Need | File |
| --- | --- |
| VS Code wiring, commands, settings | `packages/extension/src/app/main.ts`, `packages/extension/src/internal/vscode/` |
| a second surface from the same bundle (hash route) | `packages/ui-angular/src/app/routing/routes.ts` ← `main.ts` (`createApplication` + explicit host element, so no selector match), `packages/extension/src/internal/vscode/webview-html.ts` (`route` option) |
| a session as its own VS Code editor tab (pinned controller, restore) | `packages/ui-angular/src/app/routing/session-page/session-page.ts` ← `HostSessionController` option `pinnedSessionId`, `capabilities.sessionTabs`, `openSessionTab`/`closeSessionTab`, the `morse.openSessionTab` command; the sidebar row is `features/nav/session-nav` |
| what `verify-webview.mjs` protects | `docs/INSTALL.md` §1.3 |
| settings the user can change | `docs/CONFIGURATION.md` §VS Code settings |
| building and publishing the VSIX | `docs/INSTALL.md`, `docs/RELEASING.md` |
