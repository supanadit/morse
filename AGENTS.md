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
| `pi: No session found matching 'draft'`, agent exits code=1 | a draft tab was activated as a real session: never send `session/activate` for a tab whose `draft` flag is set (`packages/ui-angular/src/app/core/workspace-tabs.ts`); the host is already showing it |
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
| No hover, no squiggles, no jump in the file preview | either `capabilities.lsp` is off (VS Code: its own LSP owns those files) or no server resolved for that language — the header then shows `LSP —` rather than a clean file. Install `typescript-language-server` (or set `MORSE_LSP_TS`); the resolution order is env → the project's `node_modules/.bin` → `PATH` → `npx -y` |
| The first hover over a file does nothing | by design: the host answers only from a server that is already answering, and starts a cold one in the background instead of making the request wait on `npx` (the preview's own diagnostics request is what warms it). The second hover works |
| A problem is in the list but has no squiggle | `Range.getClientRects` is missing in that DOM (jsdom, older WebKit), so the overlay measures nothing; `measureMarks` degrades to the header list on purpose instead of throwing |
| A jump opens the file but not the line | `FileTab.line` is only set by a jump (`openFile(path, line)`) and consumed once; a plain Explorer click opens at the top, and a tab already open is moved with `revealLine` |
| The hover card vanishes when reaching for "Find references" | it pins itself after `HOVER_LOCK_MS` (900 ms, the ring counts that down), and is then taken over by a hover that *settles* on another symbol, or ended by its ✕, Escape, or a press anywhere *outside* it (a press on the card is its own controls: Copy, Find references, ✕). Everything the pointer does is decided after `HOVER_DEBOUNCE_MS` (140 ms): a cursor crossing a word or a bracket on its way elsewhere changes nothing — it neither dismisses a card nor asks for one — while resting on a new symbol replaces the card and restarts the countdown; resting on the *same* symbol keeps the card and its clock. Before the pin, a 260 ms grace (`HOVER_CLOSE_DELAY_MS`) covers the pointer crossing to the card. Clicking **Find references** closes the card and opens the panel at once (it reads `Reading references…`, then `The language server did not answer.` if nothing comes back), so the card never sits on top of the list it asked for |
| A highlighted range cannot be removed from the preview | it can, two ways: the band's own **Cancel** button (bottom right of every highlight, including the band of a drag in progress) or a click on a highlighted line number (the toggle the diff view's change blocks use). Either way the composer's chip goes with it — the bands are derived from the pins. A *drag* inside a highlight still redefines it, and Escape only abandons a drag in progress |
| `/` or `?` fires while typing a prompt | characters belong to the field: only specs marked `whileTyping` may run with the caret in an input/textarea |
| A character typed with AltGr triggers an action | Windows reports AltGr as Ctrl+Alt; `ShortcutService` skips `getModifierState('AltGraph')` |
| An overlay opens behind a dialog | specs marked `overlay` stand down while `ShellState.modalOpen()`; mark the new one or it will stack |
| The update notice never appears | the host must advertise `capabilities.updateCheck` (`MORSE_UPDATE_CHECK=0` disables it, and the VS Code webview CSP must list `https://registry.npmjs.org`); review it offline with `?mock=1&newer=0.3.0` |
| No pi update notice (the Morse one shows) | the host could not read the installed pi version, so it advertised no `capabilities.piVersion`; `readPiVersion` needs pi's own `package.json` (a symlinked `pi` is followed). Review it offline with `?mock=1&newer-pi=9.9.9` |
| A prompt template disappeared from the palette, with a warning row above the chat | intended: Morse now parses frontmatter with the same YAML parser pi uses, so a template pi refuses is dropped and named instead of offered as a dead `/command` — fix the file's frontmatter |
| `/prompts` is missing, or the editor says it cannot load | the entry is the Morse command **Edit prompt templates** (`view.prompts`, `Ctrl+Alt+E`) in the command palette, not a pi slash command; it is hidden when `capabilities.promptEditor` is off (the host could not reach pi's prompt directories) |
| A saved template does not appear in the palette | `promptTemplateSave` already asks the host to re-read (`commands/refresh`); if it still does not, the project is untrusted, so pi ignores `.pi/prompts` until **Trust this project** |
| A template written with `vim`/`nano` is not in the palette | it should be: every hot agent polls its own prompt dirs (`packages/adapter-pi-rpc/src/internal/prompt-watch.ts`, 1.5 s) and calls `refreshCommands` on a change, and the editor re-reads `promptTemplates` every 3 s while open. If it is still missing, the file may be in a project pi has not trusted |
| The argument tester lags a keystroke behind the body | intended: the body/hint parse is debounced 200 ms (RxJS `debounceTime` in `prompt-editor.ts`), so the field list does not flicker on a half-typed `$`. Selecting a template and saving read the signals directly, not the debounced copy |
| No notification when a run finishes | it is **off by default**: turn it on from the one-time `.notify-prompt` nudge or the palette (`Turn on completion notifications`). `core/notification-prefs.ts` also picks the mode (`away` by default, so it stays quiet while the panel is focused; `always` speaks every time). VS Code raises it through `capabilities.notify` → the `notify` host command; the browser host uses the `Notification` API and needs the permission granted. If the permission is revoked later, `RunNotifier.permission` re-reads it on focus / `navigator.permissions` and the banner returns as **blocked** — the stored preference alone must not claim it works |
| A prompt costs ~1 s of host CPU, or the sidebar takes a second to refresh | `session/list` is scanning every session file again: keep the size+mtime cache and the row scan in `pi-rpc-session-catalog.ts` (measured 624 ms → 2 ms; see `docs/DEVELOPMENT.md`) |
| A model added to `models.json` does not appear without `morse stop`/`start` | pi caches its catalog per warm session, and the draft probe is cached for the host's lifetime. The model picker sends `models/refresh` when it opens: `PiRpcAgent.refreshModels` re-requests `get_available_models`, a draft clears `SessionRegistry.refreshDraftDefaults()` and re-probes. A reload also re-reads the warm session. Never re-probe on every draft reload — it spawns a `pi` process |
| A model row shows no modality icon | pi did not report `input` for it: the badge is absent rather than claiming text-only (`input` is optional end to end, and an unknown modality is dropped at the adapter). pi ships `["text"]` / `["text","image"]` today; `morse-model-inputs` renders an icon per known modality |
| Streamed prose lags the model by a beat | intended: `Markdown` re-renders at most every 90 ms instead of per delta; measure `docs/DEVELOPMENT.md` before removing it |
| `pgrep -f "pi --mode rpc"` finds nothing | pi renames `process.title`; use `pgrep -P <server-pid>` |
| `morse start`/`status` claims a daemon is running that is gone | stale `~/.morse/server.json` after a force-kill and a recycled pid; the pid alone is not proof, so `/api/health` must echo the state's `instance` token (`packages/morse-web/src/cli.ts` → `isServerRunning`) |
| "Open in editor tab" is missing from a session's menu, or the command opens nothing | the host does not advertise `capabilities.sessionTabs`. Only VS Code has an editor surface; the browser host's tab strip is a different feature (`filePreview`). The row is hidden on purpose rather than offered and ignored |
| A session tab shows a different conversation after a while | it is pinned: a pinned controller ignores another surface's `session/activate` and returns to the empty draft when its session is closed or deleted, instead of adopting a hot one. If a tab follows the sidebar, the controller was built without `pinnedSessionId` |
| A session tab (or the prompt-template editor) is completely blank | the webview CSP is `script-src 'nonce-…'` without `'strict-dynamic'`, so a code-split chunk — a runtime `import()` that carries none of the nonces VS Code injects into `index.html` — is blocked. `renderWebviewHtml` must keep `'strict-dynamic'` (plus `cspSource` as the fallback for an engine that ignores it). The MCP editor is eager (`component:`, not `load:`) and so never showed this |
| A session tab is one empty column | `.shell.embedded` must outrank `.shell.collapsed`: the fold is persisted (`morse.navigation.collapsed`), so a reader who once folded the sidebar would otherwise collapse the tab's only column to zero. The embedded rule carries both classes (`.shell.embedded.collapsed`) because the fold rule sits later in the file |
| A restored session tab does not come back, or comes back empty | the session id rides in the webview state (`morse.view.sessionTab`, written by `chat/session-page/session-page.ts`, read by `readSessionTabState`). A tab restored without it is closed on purpose — a tab cannot be re-pinned to a conversation it does not know. All tabs share one view type (`morse.sessionTab`), so `registerWebviewPanelSerializer` needs exactly one entry for it |
| `morse start` hangs ~25 s then fails; `morse logs` shows `Dynamic require of "process" is not supported` | a CommonJS dependency was inlined into the ESM bundle (`yaml` → `require('process')`). Add it to `runtimeExternals` **and** `dependencies` in `packages/morse-web`; `build.mjs` now refuses to emit such a bundle |
| No Explorer in VS Code | intended: the Explorer and tab strip exist only where `capabilities.filePreview` is set (the browser host); VS Code keeps its native explorer, editor and tabs |
| No git panel in VS Code | intended: `capabilities.gitPanel` is the browser host's; VS Code has its own Source Control view |
| The MCP editor opens as a blank VS Code tab | the panel serves the same bundle routed `#/mcp`; `ui-angular/src/app/routes.ts` maps a hash to a root component and `main.ts` bootstraps it into an element it creates (never a selector match, which caused NG05104). `chat-view-provider.openMcpEditor` also starts a `HostSessionController` for the panel |
| An MCP entry (or its tab) is lost on reload | the form is kept by `ui-angular/src/app/core/view-state.ts` (VS Code webview `setState`, browser `localStorage`); the VS Code panel is restored by `registerWebviewPanelSerializer` (`chat-view-provider.registerSerializers`, activated by `onWebviewPanel:morse.mcpEditor`), and the browser tab by `WorkspaceTabs.snapshot/restore`. A dropped draft means a host that cannot persist the webview state and a storage that refused |
| The panel says the project is not trusted | that is pi's gate on project `.pi/` resources. The panel's **Trust this project** writes `<agentDir>/trust.json` through `internal/project-trust.ts` and refreshes; `pi mcp list` is a fresh process, so project servers appear immediately, while a warm session still needs a restart for prompts/skills |
| Setup screen says pi is not installed, but it works in the terminal | VS Code from the Dock/launcher does not source the login profile, so a `pi` installed by nvm/asdf/volta is missing from the extension host's PATH. The extension resolves the login shell PATH once when pi is not already visible (`internal/vscode/shell-path.ts` → `resolvePiEnv` in `app/main.ts`) and passes it to the adapter as `env`. Reload the window after changing `morse.pi.path` |
| Commit shows `Command failed: git commit -m …` | git puts `nothing to commit` on **stdout**, so `gitExec` keeps stdout/stderr and `commitGit` maps it to "Nothing is staged to commit."; `submitCommit` also guards an empty index so Enter never asks git (see `git-log.ts`, `git-panel.ts`) |
| A preview refuses a file, or opens nothing | `readFile` resolves the path against the viewing session's cwd and rejects an absolute or `..` path (`packages/server/src/internal/workspace/file-store.ts`); the Explorer only offers paths from `listFiles` |
| The chat shows the Morse hero with no tab in front | intended: the browser host renders `morse-empty-session` and does **not** mount the composer when `tabs.activeId()` is undefined (`app.html` `noSessionSelected`), so a prompt cannot silently open a session. Create one from the placeholder, the sidebar, or `Ctrl+Alt+N`; the lazy "type to start" path is only for a host without a tab strip (VS Code) |
| The header names the previous project when no session is open | intended: `WorkspaceTabs.noSessionInFront` (the same signal `App` uses) is true, so `ChatHeader` shows `Morse` and drops the workspace from its meta line instead of claiming `state.workspace.name`. The workspace is still whatever the host last had; only a session tab in front makes it the subject |
| A file opens as its own tab instead of a chip, or a pin lands in another session | the row follows the session in front: `WorkspaceTabs.openFile`/`openCommitFile` attach the file to `focusedOwner()` (a chip keyed by that session) when a session tab exists, and stand alone only when none does. `contextSessionId` uses the owner so the composer/preview pin stays with it; a chip is removed with its session |
| A file chip's context menu closes the session tab | a menu's scope is the clicked tab's own: `WorkspaceTabs.menuScope(id)` returns the whole strip for a session but only the chip's row for a file. `closeOthers`/`closeToTheRight`/`closeAll` must read that scope, never `items()` directly — a chip is context, and closing it must not take a session with it |
| Closing the last chip jumps to another session’s file | `WorkspaceTabs.remove` takes the closed chip's owner session and selects it (`chipOwner`), instead of the positional neighbour in `items` — a chip is context for its session, so closing the chip in front returns to that conversation |
| Two file chips look identical | intended: when any file name in the row is shared, the whole chip row goes two lines and every chip shows its directory, clipped at the front (`.dir` with `direction: rtl` and a `<bdi>` in `tab-strip`, so the folder nearest the file stays visible). With no shared name every chip is one row. If two still look identical, their names are not in the same row — `namesClash` counts chips per session row |
| A new file is missing from the Explorer | it polls `listFiles` (`fresh: true`) every 4 s plus `gitStatus`; a hidden tab pauses the poll. No host push — the tree changes on disk |
| File/session tabs vanish on reload | intended only in VS Code (its own editor restores tabs). The browser host persists the open/focused tabs, panel and terminals to `<MORSE_HOME>/workbench.json` — check `capabilities.workbench` and `core/workbench-persistence.ts`; a snapshot from another `version` is ignored on purpose |
| Terminal dies on a tab switch, a hidden panel, or after `morse stop`/`start` | the shell must outlive the view: a `Terminal` never sends `terminal/close` on destroy — only an explicit reader close does (`TerminalView.close`/`closePane`, `WorkspaceTabs.closeOwnerTerminals`), and the bottom panel is hidden with a class rather than `@if`-unmounted (`app.ts` `bottomPanelEnabled` mounts, `bottomPanelVisible` hides). A draft holding a terminal is not discarded as "untouched" (`TerminalStore.hasOwner`) |
| Restored terminal shows a fresh prompt | the shell is gone: the PTY lives in the host's registry and is reclaimed after `MORSE_TERMINAL_IDLE_MS` (default 30 min, `0` disables) or when the host restarts. A page reload reattaches to the live shell and replays what it missed; the scrollback is also written under `<MORSE_HOME>/terminals/`, so after a host restart you get the old output plus a new prompt. The fresh shell opens in the directory the pane last reported (OSC 7), not the session root, so a `cd` survives the restart too. `terminal/close` ends it for good. |
| A long prompt or its attachments vanish on reload / `morse stop` / a closed laptop | intended only in VS Code. The browser host saves every tab's draft — text, pins, mentions and inline images — to `<MORSE_HOME>/drafts.json` (`core/composer-drafts.ts`, `core/attachments.ts` via `WorkbenchPersistence`); the tab itself, a "New session" draft included, lives in `workbench.json` |
| Terminal pane stays blank and no shell is ever spawned | the xterm packages are CommonJS: a production bundle's lazy chunk exports only `default`, so `core.Terminal` is `undefined` and the pane silently never calls `terminal/open` — go through `importCjs` in `chat/terminal/terminal.ts`. A unit mock with named exports hides this, so the specs mirror the `default`-only shape |
| Running Morse from inside Morse fails with `EADDRINUSE`, or picks up the host's settings | the PTY used to inherit the server's environment. `terminal.service.ts` now spawns the shell with `terminalShellEnv()`, which strips `MORSE_*` (and the `fork` IPC vars), so the terminal has only the user's environment — a nested `npm run dev` uses its own defaults instead of the host's `MORSE_PORT`/`MORSE_WORKSPACE` |
| A custom button paints the theme accent on hover | the global `button:hover:not(:disabled)` (specificity 0,2,1) beats a plain `.row:hover` (0,2,0); write the override as `.row:hover:not(:disabled)` (same for `.group-title`, `.context-menu-item`, …) |
| The Explorer cannot be resized | it can: drag its top edge (`.resize`); the height persists in `morse.explorer.height` via `ShellState` |

## Pointers

| Need | File |
|---|---|
| pi event mapping | `packages/adapter-pi-rpc/src/event-mapping.ts` |
| the preview's language server (hover, jump, squiggles, references) | `packages/server/src/internal/lsp/` (`lsp.service.ts` registry, `lsp-client.ts` stdio JSON-RPC, `language-servers.ts` resolution, `lsp-mapping.ts` translation) ← `capabilities.lsp`, the `lsp*` host commands, and `chat/file-preview/` (`preview-positions.ts` maps a pointer to a zero-based position and back) |
| a model's input modalities (text/vision/audio/…) | `packages/ui-angular/src/app/chat/model-picker/model-inputs.ts` ← pi's `input` on `ModelOption.input` |
| session registry (hot sessions, LRU, projects) | `packages/core/src/session/service.ts` |
| which directories may run an agent | `packages/server/src/internal/projects/project-policy.ts` |
| client message routing | `packages/host-runtime/src/session-controller.ts` |
| a session as its own VS Code editor tab (pinned controller, restore) | `packages/ui-angular/src/app/chat/session-page/session-page.ts` ← `HostSessionController` option `pinnedSessionId`, `capabilities.sessionTabs`, `openSessionTab`/`closeSessionTab`, the `morse.openSessionTab` command; the sidebar row is `nav/session-nav` |
| transport choice (webview / WS / mock) | `packages/ui-runtime/src/transport/resolve-transport.ts` |
| VS Code wiring, commands, settings | `packages/extension/src/app/main.ts`, `packages/extension/src/internal/vscode/` |
| NestJS wiring and env | `packages/server/src/app.module.ts`, `packages/server/src/app/config.ts` |
| protocol version | `packages/protocol/src/version.ts` |
| keyboard shortcuts + the `?` help list | `packages/ui-angular/src/app/core/shortcuts.ts` ← `shortcuts/shortcuts-dialog.ts` |
| "a newer release is out" notice (Morse or pi) | `packages/ui-angular/src/app/core/update.ts` ← `capabilities.updateCheck`/`piVersion`, `docs/CONFIGURATION.md` |
| a prompt template pi refuses (its "Prompt conflicts") | `packages/adapter-pi-rpc/src/internal/prompt-frontmatter.ts` ← `buildCommandList` in `pi-rpc-agent.ts`, reported via `AgentSessionState.diagnostics` |
| "a run finished" notice while the window is elsewhere | `packages/ui-angular/src/app/core/notifications.ts` + `notification-prefs.ts` ← `capabilities.notify` |
| measured performance baseline | `docs/DEVELOPMENT.md` ← session catalog cache, markdown render cadence |
| git history + graph panel (browser host) | `packages/ui-angular/src/app/git/git-panel.ts` ← `core/git-graph.ts`, `packages/server/src/internal/workspace/git-log.ts` |
| MCP servers list/enable/disable + indicator | `packages/ui-angular/src/app/chat/mcp-panel/` ← `core/mcp-state.ts`, `packages/adapter-pi-rpc/src/pi-mcp.ts` (reads `~/.pi/agent/mcp.json` + `.pi/mcp.json`, status from `pi mcp list --json`) |
| MCP add editor + connect-before-add probe | `packages/ui-angular/src/app/chat/mcp-editor/` ← `core/mcp-state.ts` (`mcpInspect`), `packages/adapter-pi-rpc/src/internal/mcp-client.ts`; VS Code opens it as a `WebviewPanel` routed `#/mcp` (`chat-view-provider.ts` → `openMcpEditor`) |
| prompt-template editor + argument tester | `packages/ui-angular/src/app/chat/prompt-editor/` ← `core/prompt-templates-state.ts`, `packages/ui-runtime/src/prompt-template.ts` (the same expansion the composer uses); host file I/O in `packages/adapter-pi-rpc/src/pi-prompts.ts` (`promptTemplates`/`promptTemplateSave`/`promptTemplateDelete`); a new/edited file is picked up automatically by `PiRpcAgent`’s `PromptWatcher` (`internal/prompt-watch.ts`). A Morse command (`view.prompts`, `Ctrl+Alt+E`), opened like the MCP editor as a tab (browser) or a `#/prompts` `WebviewPanel` (VS Code, `openPromptEditor`); code-split — the browser mounts it with a lazy `import()`, the route row carries a `load`. Scope follows the session: global user prompts, plus the project's `.pi/prompts` when one is in front |
| a second surface from the same bundle (hash route) | `packages/ui-angular/src/app/routes.ts` ← `main.ts` (`createApplication` + explicit host element, so no selector match), `packages/extension/src/internal/vscode/webview-html.ts` (`route` option) |
| frontend state that must survive a reload | `packages/ui-angular/src/app/core/view-state.ts` ← `HostTransport.readState/writeState` (VS Code webview state, mock memory), `localStorage` fallback; VS Code panels also need `registerWebviewPanelSerializer` |
| project trust (pi's `trust.json`) | `packages/adapter-pi-rpc/src/internal/project-trust.ts` ← `PiMcp.trustProject`, host command `trustProject`, the panel's “Trust this project” button |
| bottom panel + terminal (browser host) | `packages/ui-angular/src/app/chat/bottom-panel/`, `chat/terminal/` ← `core/panel-state.ts`, `packages/host-runtime/src/terminal.ts`, `packages/server/src/internal/terminal/terminal.service.ts`; clickable URLs are `chat/terminal/terminal-links.ts` |
| who is credited, and where | `packages/ui-angular/src/app/about/credits.ts` (guarded by `credits.spec.ts`) |
| pi is not installed (setup screen) | `packages/ui-angular/src/app/agent/agent-screen.ts` ← `state.agentFailure` |
| open tabs / focused tab / terminals / per-tab drafts across a reload (browser host) | `packages/ui-angular/src/app/core/workbench-persistence.ts` ← `readWorkbench`/`saveWorkbench` + `readDrafts`/`saveDrafts`, `packages/server/src/internal/workspace/workbench-store.ts` |
| npm package (`morse start`) | `packages/morse-web/build.mjs`, `packages/morse-web/src/cli.ts`, `docs/PACKAGING.md` |
| installing (VSIX + CLI) | `docs/INSTALL.md` |
| releasing (VSIX + npm) | `docs/RELEASING.md`, `.github/workflows/release.yml` |
| cold-start splash → empty-state handoff | `packages/ui-angular/src/app/boot/boot-splash.ts`, `packages/ui-angular/src/app/core/boot-handoff.ts` |
| offline / no-host screen | `packages/ui-angular/src/app/connection/connection-screen.ts` |
