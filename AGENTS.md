# AGENTS.md — Morse

Morse is a **Comfortable Pi Interface**: one chat frontend for the Pi coding agent, running either in a VS Code
webview or in a browser served by NestJS. Two hosts, one core, one swappable frontend.
Reasoning: `docs/ARCHITECTURE.md` · UI contract: `docs/FRONTENDS.md`.

## Hard rules

1. Never commit or push unless the user asks in the current turn.
2. Never send a real prompt to a model in tests — stop at `host/ready` / `get_state`.
3. Never edit generated output: `packages/*/dist`, `packages/*/out`, `packages/extension/media/webview`,
   `packages/extension/.vscode-test`, `dist/*.vsix`.
4. `@morse/core` and `@morse/protocol` stay dependency-free: no `vscode`, no NestJS, no `node:*`.
5. Never import `pi` at runtime (~436 MB) — always spawn `pi --mode rpc`.

## Layout (imports point inward only)

```
core, protocol      pure                ports live in core/src/*/service.ts, never in domain.ts
host-runtime        host glue           -> protocol + core types
adapter-pi-rpc      pi subprocess       -> core
ui-runtime          transports + client -> protocol
ui-angular          Angular views       -> protocol, ui-runtime
extension, server   composition roots   -> everything
morse-web           npm delivery        bundles server + ui-angular; ships the `morse` CLI
```

Adapters never import each other; only the composition roots wire them.

## Commands

```bash
npm run build          # libs -> UI -> sync webview -> extension + servernpm run check-types    # tsc --noEmit everywhere
npm run lint           # eslint (extension)
npm run test:fast      # vitest (no display needed)
npm test               # + VS Code integration test (downloads VS Code, needs a display)

npm run dev:extension  # F5 prelaunch: build once, then watch extension + UI + webview
npm run dev:server     # NestJS: tsc --watch + node --watch
npm run dev:ui         # ng serve (:4200 may be taken -> --port 4321)
npm run package        # dist/morse.vsix (refuses a development webview bundle)
npm run build:web      # libs -> ui -> packages/morse-web/dist (npm artifact)
npm run publish:web    # build:web, then npm publish -w @supanadit/morse-web

node packages/server/scripts/ws-smoke.mjs ws://127.0.0.1:4399/ws   # pipeline check, no model call
```

Done = `build` + `check-types` + `test:fast` (+ `npm run sync-webview` when the UI changed).

## Conventions

- **ESM everywhere except the extension bundle** (esbuild -> CJS). Libraries and the server need explicit `.js`
  in relative imports.
- **Frontend = static bundle + `webview.manifest.json`.** Hosts only compare `protocolVersion`. Changing a wire
  message means bumping `protocol/src/version.ts` and rebuilding the UI.
- **UI state comes only from `reduceSessionView`**, and frontends read `capabilities` instead of guessing.
- **NestJS: explicit `@Inject(...)` on every constructor parameter.**
- **Capabilities, not assumptions**: the frontend shape follows `capabilities.scope` — `global` (browser host:
  projects → sessions) vs `workspace` (VS Code: one group). The controller filters
  projects and sessions to the workspace roots and refuses agents outside them.
- **pi framing**: split on LF only, strip CR, no `readline`, `StringDecoder`, stderr is logs only.
- **Keyboard**: a shortcut is one entry in `core/shortcuts.ts` plus a `bind()` by whoever owns the state it
  acts on (the composer binds the model chooser, the thinking picker its own panel), so the `?` help dialog
  prints the same list the service matches, and an owner that is not mounted is shown as unavailable rather
  than promised. Never a second key handler per component.
- **Where new code goes**: use case -> `core/src/<module>/service.ts`; port -> the consumer; pi command ->
  `adapter-pi-rpc`; new UI data -> protocol + `host-runtime/src/session-controller.ts`; new frontend/host ->
  see `docs/FRONTENDS.md`.

## Gotchas

| Symptom | Cause / fix |
|---|---|
| `Nest can't resolve dependencies of X (?, …)` | add `@Inject(...)`; esbuild/`tsx` cannot emit decorator metadata |
| `EADDRINUSE` or leaked `pi` after restart | `enableShutdownHooks()` + `onModuleDestroy` disposing sessions |
| TS5107 about `moduleResolution: node10` | deprecated in TS 6 -> `Node16` / `NodeNext` |
| `require()` of an ESM-only package | NestJS 12 and all `@morse/*` are ESM |
| `overrides` in a workspace package ignored | only the root `package.json` is honoured |
| `node --watch` gives up after a crash | it restarts on file change only |
| Browser UI stuck on `connecting` / `no model` | the dev server is not proxying `/ws` — check `packages/ui-angular/proxy.conf.mjs`, `MORSE_SERVER_URL` or the `?server=` override |
| UI shows `Starting the Pi agent…` | normal (cold start ~1.5 s): lifecycle is the badge (`connecting` → `starting` → `ready`), not a banner |
| UI shows one group and no project switcher | that host is `scope: 'workspace'` (VS Code) — intended, not a bug |
| Resumed session shows an empty panel | history is seeded from `get_messages`; check `AgentGateway.history()` and the store's `items()` guard |
| A banner flashes on every load | it must not: banners render only for a refused handshake, `error`/`closed`, or a handshake stalled > 6 s (`slowConnection`). The first such state after the cold start is the friendly `ConnectionScreen`, not a banner |
| Transcript lost on every refresh | the session was evicted — raise `MORSE_HOT_SESSIONS` (default 4) or `morse.sessions.hotLimit` |
| Agent runs in the wrong project | sessions carry their own cwd; check `project/open`/`session/activate` payloads and the `ProjectPolicy` |
| A setup screen instead of the chat | `pi` is not on the host's `PATH`; the screen names the command to install and the setting/env var that host reads (`state.agentFailure`) |
| Agent gets `packages/server` as its project | `MORSE_WORKSPACE` was unset inside a monorepo package; the host now defaults to the workspace root |
| VSIX contains unminified `main.js` and no manifest | a dev webview was packaged; `verify-webview.mjs` blocks it |
| Webview blank after a UI change | run `npm run sync-webview` |
| Panel has ~20px left/right margin in VS Code only | VS Code injects `@layer vscode-default { body { padding: 0 20px } }` into every webview; Morse must declare an unlayered `body { padding: 0 }` in `styles.css` to win |
| Sidebar comes back folded after a reload | intended: `ShellState` keeps the wide-layout fold in `localStorage` (`morse.navigation.collapsed`); clear that key to reset it |
| Compact (or `/compact`) seems to do nothing | it asks first: `ShellState.requestCompact()` opens `morse-confirm-dialog`, where Cancel is focused on purpose |
| Typing a project name in the sidebar finds no sessions | that box searches session titles only — the project button above it opens the searchable filter; the empty state offers the matching project as a jump |
| Sidebar and chat headers out of line | both rows read `--morse-head-height`; giving one of them its own padding/`min-height` is how they drift apart |
| `--frontend=x` silently ignored | npm drops flags on nested `npm run`; use `npm run sync-webview -- --frontend=x` |
| A shortcut does nothing | no owner bound it: the action is registered by the component that owns the state (the composer, the sidebar), so a `?` list row marked "not in this host" is the honest answer — bind it there, not in `App` |
| `/` or `?` fires while typing a prompt | characters belong to the field: only specs marked `whileTyping` may run with the caret in an input/textarea |
| A character typed with AltGr triggers an action | Windows reports AltGr as Ctrl+Alt; `ShortcutService` skips `getModifierState('AltGraph')` |
| An overlay opens behind a dialog | specs marked `overlay` stand down while `ShellState.modalOpen()`; mark the new one or it will stack |
| `pgrep -f "pi --mode rpc"` finds nothing | pi renames `process.title`; use `pgrep -P <server-pid>` |

## Pointers

| Need | File |
|---|---|
| pi event mapping | `packages/adapter-pi-rpc/src/event-mapping.ts` |
| session registry (hot sessions, LRU, projects) | `packages/core/src/session/service.ts` |
| which directories may run an agent | `packages/server/src/internal/projects/project-policy.ts` |
| client message routing | `packages/host-runtime/src/session-controller.ts` |
| transport choice (webview / WS / mock) | `packages/ui-runtime/src/transport/resolve-transport.ts` |
| VS Code wiring, commands, settings | `packages/extension/src/app/main.ts`, `packages/extension/src/internal/vscode/` |
| NestJS wiring and env | `packages/server/src/app.module.ts`, `packages/server/src/app/config.ts` |
| protocol version | `packages/protocol/src/version.ts` |
| keyboard shortcuts + the `?` help list | `packages/ui-angular/src/app/core/shortcuts.ts` ← `shortcuts/shortcuts-dialog.ts` |
| who is credited, and where | `packages/ui-angular/src/app/about/credits.ts` (guarded by `credits.spec.ts`) |
| pi is not installed (setup screen) | `packages/ui-angular/src/app/agent/agent-screen.ts` ← `state.agentFailure` |
| npm package (`morse start`) | `packages/morse-web/build.mjs`, `packages/morse-web/src/cli.ts`, `docs/PACKAGING.md` |
| installing (VSIX + CLI) | `docs/INSTALL.md` |
| releasing (VSIX + npm) | `docs/RELEASING.md`, `.github/workflows/release.yml` |
| cold-start splash → empty-state handoff | `packages/ui-angular/src/app/boot/boot-splash.ts`, `packages/ui-angular/src/app/core/boot-handoff.ts` |
| offline / no-host screen | `packages/ui-angular/src/app/connection/connection-screen.ts` |
