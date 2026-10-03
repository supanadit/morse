# Swapping the frontend

Morse is built so the UI framework is a leaf detail. Neither host imports Angular, and no host knows which
framework produced the bundle it serves.

## The contract

A frontend is a **static bundle** plus a manifest:

```
packages/<ui-package>/dist/
├─ index.html                 relative asset URLs (host rewrites <base>)
├─ main-<hash>.js
├─ styles-<hash>.css
└─ webview.manifest.json      { name, version, protocolVersion, entry, generatedAt }
```

Hosts read `webview.manifest.json`, compare `protocolVersion` with their own and serve the directory as-is:

- VS Code host: `npm run sync-webview [-- --frontend=<folder>]` copies the bundle into
  `packages/extension/media/webview`
  (the host then injects a CSP nonce and rewrites `<base>` to the webview resource root).
- NestJS host: serves the same directory (`MORSE_UI_DIR`, default `packages/ui-angular/dist`).

Because the manifest carries the protocol version, a stale bundle fails loudly instead of half-working. Hosts also
report the bundle's `{ name, version }` back in `host/ready` (`payload.frontend`), which is the only way a frontend
can learn its own version at runtime — the About dialog shows it verbatim, so both hosts must read the manifest from
the directory they actually serve (`frontendIdentity()` in `@morse/protocol`).

## Reusable pieces (write these once, per framework write only views)

| Piece | Package | What it gives you |
|---|---|---|
| Wire types, guards, view state + reducer | `@morse/protocol` | `SessionView` (transcript, sessions, projects), `HostCapabilities.scope`, `reduceSessionView`, `parseHostMessage`, `encodeWireMessage` |
| Transports | `@morse/ui-runtime` | `resolveTransport()`, `VsCodeHostTransport`, `WebSocketHostTransport`, `MemoryHostTransport` |
| Client facade | `@morse/ui-runtime` | `createMorseClient({ transport })` → `getView()`, `subscribe()`, `actions` |

Multi-project is host state, not frontend state: the host streams the transcript of the **active** session and
replays another one when the client activates it, so a frontend only renders `view.items` plus the
`view.projects` / `view.sessions` lists.

A framework binding is therefore thin: hold the `SessionView` in whatever reactivity primitive the framework
has (Angular signals, React state/SWR, Svelte stores) and call `client.actions.*` from events. In Angular that
is one file: `packages/ui-angular/src/app/core/morse.service.ts`.

## Rules a frontend must follow

1. **Handshake** — after connecting, send `client/ready` with `PROTOCOL_VERSION`. Hosts answer with
   `host/ready` (capabilities + initial state) and re-send it whenever a client reconnects.
2. **Render the reducer output only.** Never invent transcript state locally; `session/state`,
   `session/activity`, `transcript/*`, `session/list`, `notice` and `error` are the whole truth.
   `session/activity` lists every *hot* session, so a frontend can mark several as active at once —
   the transcript still belongs to the selected session only. `session/list` also folds those live
   sessions in, so a session shows up as soon as it opens, even before pi has persisted it.
3. **Drive the agent through actions** — `prompt(text, mode)`, `editMessage(itemId, text)` (forks the
   conversation before a past user message) and `forkMessage(itemId)` (branches there without sending;
   the host answers with `composer/seed`), `abort()`, `newSession(cwd?)`,
   `openProject(path)`, `activateSession(id, cwd?)`, `closeSession(id)`, `compactSession()`,
   `requestSessions()`, `requestProjects()`, `setModel(provider, id)`, `setThinkingLevel(level)`.
   When the agent is streaming, prompts use `steer` or `followUp` (the core also downgrades a `new` prompt
   while streaming and tells the user via a notice).
4. **Interactions** — if `capabilities.nativeDialogs` is `false`, render `pendingInteraction` yourself and
   answer with `interaction/respond`. If it is `true`, the host is already showing QuickPick/InputBox and the
   request never reaches you.
5. **Capabilities, not assumptions** — `scope` decides the navigation shape (`global` = projects →
   sessions like the browser host, `workspace` = one group like VS Code), `editorContext` decides whether
   "attach selection" makes sense, `filePicker` whether the host can answer `listFiles` for an `@mention`
   picker, `fileUpload` whether it can store a file the browser read (see below),
   `directoryPicker` whether "New session" has to ask which folder the agent runs in (browser host) or
   already knows (VS Code), `editMessage` whether editing a past prompt (a fork) is possible,
   `forkMessage` whether a fork can branch a new session and hand the prompt back instead, and
   `insertIntoEditor`/`revealFile` decide whether `host/command` is worth offering.
   Same rule for a dead backend: render `state.agentFailure` (`code`, `install`, `hint`) instead of paraphrasing
   `agentError` — the adapter knows pi's package name, the host knows which setting it reads, and a frontend
   that guessed would offer the wrong remedy. A host that could not classify the failure sends no `code`,
   which is the signal to fall back to generic wording.

### Attachments, by host

A browser cannot hand a dragged `File`'s path to pi, so hosts advertise what they can do and the frontend
picks the branch from capabilities:

- `filePicker: true`: the host answers `listFiles`, so typing `@` opens the `@mention` picker and `+` opens
  it too. VS Code lists the open workspace folders; NestJS lists the directory the client is viewing —
  the active session's cwd, or the draft's when a project was just picked (host commands get that cwd from
  the controller, not from the registry's active session) — with git `ls-files`, then a capped walk.
- `fileUpload: true` (NestJS/browser): a dropped non-image `File` is sent to the host, which stores it next
  to the session and answers with a path. The `uploadFile` host command takes `{ name, mimeType, data }`
  (base64) and returns `{ path, name, bytes }`; the frontend turns `path` into an `@mention`. The server
  writes under `<cwd>/.morse/uploads/` (override with `MORSE_UPLOAD_DIR`) and never trusts a client-supplied
  directory. A host with both (NestJS today) opens the `@` picker from `+` and keeps uploads for drag/drop.
- neither: the `+` button falls back to pinning the editor selection.

### Choosing a project (browser host only)

VS Code opens a folder, so "New session" already knows the cwd. The browser host serves a machine with no
workspace folder: `directoryPicker: true` makes the sidebar's "New session" open `morse-project-picker`, an
overlay that asks which project the session belongs to. It browses with the
`listDirectories` host command (`{ path? }` → `{ path, parent, directories, isGitRepo, roots, canOpen }`) and
creates the session as a normal draft in the chosen folder (`session/new` with `cwd`). Browsing is read-only;
the host still applies `ProjectPolicy` — `canOpen: false` disables "New session here" and names
`MORSE_PROJECTS` as the fix. The per-project "+" in the sidebar skips the modal and targets that project
directly.
6. **Theme** — inside VS Code use the `--vscode-*` variables, with fallbacks so the same bundle looks right in
   a browser. See `packages/ui-angular/src/styles.css`. Fonts follow the same rule: VS Code supplies
   `--vscode-font-family` / `--vscode-editor-font-family`, so the panel inherits the user's editor font; a
   browser has neither and gets the self-hosted JetBrains Mono bundled in `public/fonts` (SIL OFL 1.1, which
   ships with it), with an installed Nerd Font build and then the platform stack behind it.
7. **CSP** — inside a webview there is no `eval`/`new Function` and scripts only run with the host-provided
   nonce. Keep the bundle relative (`<base href>` is rewritten) and avoid inline event handlers.
8. **Attribution travels with the frontend.** The About dialog is frontend data, not a host message:
   `packages/ui-angular/src/app/about/credits.ts` lists every technology the workspace depends on (its spec
   fails when one is missing, stale, or changes its licence), and the bundled font licence ships beside the
   bundle (`public/fonts/LICENSE.txt`). A replacement frontend reuses both instead of dropping them — no host
   work, no protocol change.
9. **Keys are the frontend's own.** No host message carries a shortcut: `packages/ui-angular/src/app/core/shortcuts.ts`
   is the catalog (matching, matching display, and the help dialog all read the one list), and owners bind the
   action they own through `ShortcutService`. A replacement frontend binds the same keys — the key a user learns
   is part of the product, not of the wire — and keeps the help honest about which ones this host can run.

## Adding `ui-react` (the same recipe for Svelte, Vue, Solid, ...)

```bash
# 1. create packages/ui-react with a Vite/React build that emits to ./dist
# 2. depend on @morse/protocol + @morse/ui-runtime
# 3. render the SessionView and call client.actions.*
# 4. copy the manifest step from packages/ui-angular/scripts/write-manifest.mjs
# 5. verify
npm run build -w @morse/ui-react
npm run sync-webview -- --frontend=ui-react     # VS Code host (no `--` = the flag is swallowed)
MORSE_UI_DIR=packages/ui-react/dist npm run start:server   # NestJS host
```

Nothing in `core`, `host-runtime`, `adapter-pi-rpc`, `extension` or `server` changes. If a new screen needs
data the protocol does not carry yet, add a wire message in `@morse/protocol`, map it in `host-runtime`, and
bump `PROTOCOL_VERSION` — that is the only place where "frontend work" can leak into hosts.

## Developing a frontend without any host

```bash
npm run dev:ui                 # ng serve (or the framework's dev server)
# http://localhost:4200/?mock=1     in-memory mock host: scripted streaming answer + tool card
# http://localhost:4200/?mock=1&boot=1   hold the cold-start splash to review its animation
# http://localhost:4200/?mock=1&boot=1&empty=1   blank transcript: the empty-state hero + handoff
# http://localhost:4200/            /ws + /api are proxied to 127.0.0.1:4399 by default
# http://localhost:4200/?server=ws://host:port   one-off override
# MORSE_SERVER_URL=http://host:port npm run dev:ui   change the proxy target
```

`MemoryHostTransport` (in `@morse/ui-runtime`) is the same trick that makes unit tests possible: inject a
transport instead of talking to a real host. `packages/ui-angular/src/app/app.spec.ts` does exactly that.
