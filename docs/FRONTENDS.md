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
   When the agent is streaming, a prompt uses `steer` for an immediate course-correction; a **follow-up**
   is queued in the frontend (`core/queued-prompts.ts`), shown above the composer as `Queued messages`
   with edit / send / remove, and dispatched one prompt per settled run — the reader's queue, not pi's
   invisible one. The core also downgrades a `new` prompt while streaming and tells the user via a notice.
4. **Interactions** — if `capabilities.nativeDialogs` is `false`, render `pendingInteraction` yourself and
   answer with `interaction/respond`. If it is `true`, the host is already showing QuickPick/InputBox and the
   request never reaches you.
5. **Capabilities, not assumptions** — `scope` decides the navigation shape (`global` = projects →
   sessions like the browser host, `workspace` = one group like VS Code), `editorContext` decides whether
   "attach selection" makes sense, `filePicker` whether the host can answer `listFiles` for an `@mention`
   picker, `fileUpload` whether it can store a file the browser read (see below),
   `directoryPicker` whether "New session" has to ask which folder the agent runs in (browser host) or
   already knows (VS Code), `filePreview` whether the host can read a file's contents (`readFile`) for the
   frontend's own Explorer and preview tabs (the browser host; VS Code keeps its native explorer and editor
   and leaves it off), `editMessage` whether editing a past prompt (a fork) is possible,
   `forkMessage` whether a fork can branch a new session and hand the prompt back instead, and
   `insertIntoEditor`/`revealFile` decide whether `host/command` is worth offering, `gitPanel`
   whether the host can read the active project's git history (`gitLog`) for the frontend's own
   git panel (the browser host; VS Code keeps its Source Control view and leaves it off), and `updateCheck`
   whether the frontend may ask the registry for the latest release (it is the only request a frontend ever
   makes off-machine; a host that leaves it off — or a webview whose CSP forbids the registry origin — never
   shows an update notice).
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

### Explorer and file preview (browser host only)

VS Code has an Explorer and a text editor, so its host leaves `filePreview` off and none of this renders.
The browser host has neither, so `filePreview: true` gives the frontend an Explorer in the sidebar and a tab
strip above the conversation, where sessions and files open side by side.

- The Explorer is built from the same flat `listFiles` listing the `@mention` picker uses (git-aware, the
  active session's directory), turned into a tree in `core/file-tree.ts`. Clicking a file opens a tab.
  `WorkspaceFiles` holds that listing for both surfaces and re-reads it on a timer (`fresh: true` bypasses
  the host's index cache), so a file added or deleted on disk appears without a restart. The same poll asks
  `gitStatus` (`{ isRepo, files: [{ path, status }] }`, porcelain codes), and a changed file shows the
  one-letter badge its status earns (`M`, `A`, `D`, `R`, `U`, `C`) with a dot on the folder that holds it.
- A file tab is filled by the `readFile` host command (`{ path }` → `{ path, content, size, truncated,
  binary }`). `path` is relative to the viewing session's cwd: `readWorkspaceFile` resolves it against that
  directory and refuses an absolute path or one that escapes it, so a browser cannot read outside the
  project `ProjectPolicy` already approved. Files over 512 KB are cut short, and a binary file is reported
  as such instead of being decoded. Dragging across the line numbers picks a range and pins it to the next
  prompt as `path:start-end` — the browser host's stand-in for VS Code's "add selection to chat". In the `@`
  picker, **Enter (or a row click) is a plain mention**; the file is opened only for the explicit quote intent
  — **Shift+Enter**, or the row's `⧉` — so a reference never steals the view from the conversation.
- A file the working tree reports as changed (the same `gitStatus` map) also gets a **File / Unified /
  Split** switch in the preview: `gitDiff` (`{ path }` → `{ path, diff }`) supplies the unified diff,
  `core/git-diff.ts` parses it into hunks and pairs the two sides for split view, and an untracked file
  has its content rendered as all-added. A change block in either diff layout is clickable: one click pins
  its new-file range to the next prompt, and clicking it again unpins — no drag needed. The chosen mode is
  remembered (`DisplayPrefs.diffView`).
- A session tab is navigation, not a second transcript: selecting it sends `session/activate` and the host
  replays that session, exactly as the sidebar does. Nothing is cached frontend-side, so there is still one
  source of truth for a conversation. `session/new` is only a draft with no session id, so the frontend opens
  a tab for it itself and promotes it to the real session on the first prompt; every "New session" is its
  own tab, and a tab can be closed to an empty strip, and a closed tab is never reopened by the host's state.
- The composer is **per tab**. A half-typed message and its attachments live in `core/composer-drafts.ts`
  (`core/attachments.ts` scopes its pending pieces the same way), keyed by the session or draft tab id in
  front, so switching tabs shows that tab's draft and never carries the words into another session. An
  untouched "New session" tab is dropped when a real session is picked; one with text in it stays until the
  reader closes it.

### Git history and graph (browser host only)

VS Code has a Source Control view, so its host leaves `gitPanel` off and none of this renders. The
browser host has none, so `gitPanel: true` gives the frontend a right-hand panel with the active
project's recent commits and their branch graph, toggled from the chat toolbar (`Ctrl+Alt+G`).

- The panel follows the viewing session's directory, exactly like the Explorer: it calls the
  `gitLog` host command (`{ max? }` → `{ isRepo, root?, branch?, commits }`) when it opens and
  whenever the active project changes. A directory that is not a repository is a normal answer
  (`isRepo: false`), not an error.
- A commit carries `hash`, `shortHash`, `parents`, `refs` (already split decorations), `author`,
  `date` and `subject`. `parents` is all the graph needs: `core/git-graph.ts` is a pure function
  that assigns each commit a lane and the edges across its row, and the panel turns that into one
  SVG per row. No graph algorithm lives in the host.
- The panel is two sections: an **uncommitted changes** list on top (the same `gitStatus` poll the
  Explorer uses, so it stays live; a click opens the file in a preview tab) and the **graph** below,
  which pages towards the root commit as it scrolls. Each section folds from its own header, and a
  drag handle between them sets the changes height (persisted in `ShellState`, like the Explorer's).
- The history is read with `git log --all --date-order` and capped (250 by default, 500 hard), so a
  long repository stays readable. VS Code never loads this — the capability, the shortcut row and
  the panel are all gated on `capabilities.gitPanel`.
- The panel has an expanded mode: its header button moves it out of the sidebar so it spans the
  conversation area (the chat steps aside), which is where a many-lane graph gets the room it needs.
  The layout is fluid either way — one line per commit, refs capped at two chips with a `+N`, and the
  lane transitions drawn as smooth cubic curves rather than right-angled segments.

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
# http://localhost:4200/?mock=1&newer=0.3.0   the update notice, offline and without a release
# http://localhost:4200/?mock=1&update=1     the notice the way it really runs: one request to the npm registry
# http://localhost:4200/            /ws + /api are proxied to 127.0.0.1:4399 by default
# http://localhost:4200/?server=ws://host:port   one-off override
# MORSE_SERVER_URL=http://host:port npm run dev:ui   change the proxy target
```

`MemoryHostTransport` (in `@morse/ui-runtime`) is the same trick that makes unit tests possible: inject a
transport instead of talking to a real host. `packages/ui-angular/src/app/app.spec.ts` does exactly that.
