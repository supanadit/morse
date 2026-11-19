# Status

This page describes **v0.29.0**.

Morse **v0.28.0**. This page is the honest inventory of what ships. Everything else points here:
[`README.md`](../README.md) for the pitch, [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it is built,
[`CONFIGURATION.md`](CONFIGURATION.md) for the knobs, [`FRONTENDS.md`](FRONTENDS.md) for the frontend contract.

## Shipped

### The conversation

- Markdown transcript with highlighted, copyable code blocks.
- Tool calls as a **compact tree** by default: one summary line per turn with its steps and the files they
  touched nested under it. The always-open timeline is a per-user toggle (`morse.chat.toolDisplay=timeline`).
- Thinking streams as it arrives, and a resumed session is seeded from the agent — never from a blank panel.
- Every message is stamped with its wall-clock time (`HH:MM`, the full date on hover) in both code mode and
  bot mode, so a line can be placed in the day.
- Each answer names the model that produced it — the model the session was on when that row was written, not
  whichever is selected now. The catalog's display name is used, falling back to the engine's own id for a
  model it no longer lists.
- Paged history for long sessions.

### While the agent works

- `steer`, follow-up and abort. Steering lands in the running turn; a prompt sent mid-run with no mode is
  **queued** as a follow-up rather than refused, and shown above the composer (`Queued messages`: edit, send
  now, remove) until it runs as the current turn settles.
- Compaction behind an explicit confirmation, optionally with custom instructions (`session/compact`). While
  a run is in flight the same question also offers **Schedule Compact**: pi compacts by aborting whatever is
  running, so the compaction is armed instead and fires the moment that conversation settles — queued
  follow-ups included (`session/compact` with `schedule`).
- Interaction requests: native QuickPick/InputBox in VS Code for the single-value kinds, rendered inline in the
  browser everywhere — and **forms** (several typed fields, constraints, conditional visibility) always rendered
  in the panel, because no native dialog can express them.
- Failures surface as notices (`error` message) instead of a dead panel.

### Model and thinking level

- Pickers for both, applied to the running session through pi's `set_model` / `set_thinking_level`.
- The thinking picker **mirrors what pi supports for the current model**, not a fixed list: pi scopes the
  levels to the model, so switching models re-reads them (and the level pi settled on — a model without
  reasoning resets it to `off`). The same re-probe runs for a model picked on a draft, before any session
  exists.
- The picker **says so while it waits** (`loadingThinkingLevels` on the view state): the trigger spins and the
  list shows a `Reading this model's levels…` row, with the previous model's rows on screen but not pickable —
  they may name a level this model does not have. A model the host has already probed applies in the same frame
  as the pick, with no loading row at all.
- This **is** the per-session model override. A session records its own model and thinking-level changes, and
  resuming it restores them, so the choice follows that session across eviction, resume and host restart
  without touching pi's defaults for new sessions.
- A brand-new, empty panel probes the selected engine without creating a session (pi `--no-session`, OpenCode's
  catalog reads) for the real model, mode and command catalog, so the first picker is populated before any
  session exists. On OpenCode the model it names is the **effective agent's**: the mode the draft has picked
  (`build`, `plan`, or any primary agent you defined), else the agent `default_agent` resolves to. Morse reads
  that model from `/api/agent`, so the server's own merging of the global and project `opencode.json[c]` is what
  decides it — a project override needs no separate handling. The model is checked against `/api/model`; an
  agent model the catalog does not list falls back to `/api/model/default`, the server's own fallback, and, with
  no explicit pick, `no model` remains only when neither resolves. An explicit pick always wins; without one,
  switching the mode on a draft makes the pill follow that mode's agent, because that is the agent the first
  prompt will run.
- A config edit reaches the next new session without restarting Morse or the OpenCode server. OpenCode already
  re-reads an edited `opencode.json[c]` on its own, so Morse does not depend on when: it fingerprints the
  app-level and project candidates (existence, mtime and size, so creating the first file counts), and the empty
  panel's probe asks the server to reload (`POST /api/location/reload`) before it reads the catalogs when that
  fingerprint moved. Two rules keep the automatic reload where it belongs: it runs only on a server Morse
  started itself (an attached `opencode serve` is left to OpenCode's own watcher), and only while no session of
  that engine is streaming — a deferred change keeps its old fingerprint, so the next idle probe retries instead
  of forgetting it. A warm session is left alone by that reload, and its next turn is served by the refreshed
  config.
- The composer's **⟳** control — **Reload agent configuration** — is the manual path: it asks the server to
  reload now, for every loaded location, and every warm session re-reads its own model, mode, command and skill
  catalogs. It works for an attached server too, since this is the explicit request — the automatic path is the
  one that never posts to it. Sessions running at that moment make it warn first — it counts them and says
  pending permission and form prompts are cancelled. pi has no reload control, because it has no engine-level
  config to reload: its model and prompt pickers already re-read what pi owns on demand, so no restart is
  involved.

### Modes

- A harness that offers named ways of working (OpenCode's primary agents: `build`, `plan`, and any the user
  defines) gets a mode pill next to the model. It is part of the session state, not a Morse enum.
- OpenCode's list is read from its own configuration. The default is the last `default_agent` the configuration
  documents set, otherwise the first primary agent the server orders first — never a hardcoded `build`. Opening
  the picker re-reads the list, so a mode added, renamed, disabled or removed in `opencode.json` appears without
  restarting Morse.
- The mode can be changed while the conversation runs (`mode/set` → OpenCode's `/session/{id}/agent`), which is
  the same thing OpenCode's Tab key does. A session created without an explicit choice omits the agent field and
  lets OpenCode apply its own default.
- pi has no modes; the pill is absent rather than empty.

### Engines

- **pi and OpenCode** drive the same sessions, sidebar and transcript. pi is the default new-session engine; set
  `MORSE_ENGINE=opencode` (browser) or `morse.engine` (VS Code) to start there. A host registers only the engines
  it can run, so one engine means no picker: the composer shows that engine's name in the session facts and every
  new session starts there. When both are installed, the empty composer offers an engine picker: choosing one
  re-reads that engine's model/mode catalogs, and the first prompt creates the session there. The choice is sticky
  for later new sessions in the same host; the configured default is still what starts a host.
- OpenCode registers itself when its binary is on `PATH` or `MORSE_OPENCODE_URL` / `morse.opencode.url` is set —
  attaching to a running `opencode serve`, or spawning a private one (which stops with the host). pi registers
  when its binary resolves (or `MORSE_PI_PATH` / `morse.pi.path` names it), so an OpenCode-only machine offers
  OpenCode alone. When neither resolves, the host registers nothing and reports an empty engine list —
  the panel then shows the full-screen setup card, which offers both installs (`engineSetup`).
- Each engine's sessions are listed, opened, forked and deleted through the same commands. Engine-only extras
  (MCP administration, prompt templates, version notice) come from the selected engine: both engines have the
  MCP manager and the prompt editor, and the version notice is pi's alone.

### Sessions and projects

- A session id is **Morse's**, derived from the engine's own id (`deriveSessionId`), and is what the registry,
  the transcript, the tabs and the wire use. Morse's index (`<data dir>/sessions/`) is the sidebar's source of
  truth, so it keeps listing sessions when an engine's storage is unreadable, and reconciles what each engine
  reports so a session started outside Morse still appears.
- One gateway per session, kept warm LRU-style (`MORSE_HOT_SESSIONS`, default 4), so switching projects or
  reloading the page reattaches instead of respawning. A pi session is a whole process (275–450 MB); an OpenCode
  session is a view onto the shared server. The cap is the number to size a box by.
- An **In progress** section lifts the sessions working right now, so several active sessions are visible at
  once instead of only the selected one (`session/activity`).
- The session list **remembers what was folded**: a project's header and the list itself survive a reload, and
  a reader with no folds on record meets one project unfolded — the one they are in, or else the last one they
  used — so a catalog of hundreds of projects arrives as a list to scan (`state/session-nav-prefs.ts`).
- Project browser with a searchable filter, session search, activate, close (retire the process) and delete
  (remove the session file, behind the host's own confirmation).
- **Rename a session** from its context menu. The title is Morse's own, stored in `sessions/records/`: the
  engine's conversation is never touched, and the name wins over every later title the engine reports.
- **Delete a project** from its context menu: every session it holds is closed and removed through its own
  engine's storage, the count is reported, and the directory itself stays on disk.
- The browser host allows any directory; the VS Code host advertises `capabilities.scope: 'workspace'` and
  filters projects and sessions to the workspace roots.

### Context you attach

- VS Code: a live chip follows the editor — words on one line read as `L18:45-79`, a whole-line selection
  as `L18-20`, and a merely focused file as a whole-file chip with no line number — until the user clicks
  it to lock. A column pin carries its selected words as a bounded excerpt; the chip's tooltip names the
  path, range and character count.
- Everywhere: drag/drop/paste images; browser uploads land next to the session (`<cwd>/.morse/uploads/`) and
  ride as `@mentions`.
- The `@mention` picker lists files **and** directories (`@docs/` drills in) and honours `.gitignore`.

### Editing what was sent

Editing is whatever the engine's own edit is, and the host never pretends otherwise:

- **Edit and resend** (`chat/edit`) **rewrites in place on OpenCode**: the same session reverts to that
  prompt, so the conversation and the working tree roll back together. The tail is gone for good when the
  rewrite commits — before the replacement prompt is sent — and a send that fails afterwards cannot bring
  it back. On pi, which has no edit primitive, the same action branches before the prompt (a new session,
  files untouched) and sends the edited text there. Attachment chips on the original ride along either way.
- **Fork** (`chat/fork`): a branch before a past user prompt without sending anything. The old branch
  stays resumable, the transcript re-homes onto the new (shorter) branch, and the forked prompt goes back
  to the composer.
- **Branch from here** (`chat/branch`): offered on a turn's finished answer, it keeps that answer and
  starts a new branch behind it — forking before the next prompt, or copying the conversation at the tail.
  The old branch stays resumable and nothing is seeded: you type what comes next.
- **Copy** stays what it was: clipboard only — no new session, no trip to the composer.

A prompt with no text — an image-only or pin-only message — is a normal branch point on both engines: edit
and fork count every user message instead of the engine picker's text-only list. (A prompt older than a
`branch_summary` row pi wrote in its own TUI can still map one entry early; that known limitation is
recorded in the design doc.)

A branch is a new session, so it cannot page back into conversation that lived exclusively before the
branch point: those older pages stay on the old session and are not reachable from this one's sidebar.

The session list paints the three kinds apart: an original keeps the purple chat, a branch takes a green
fork and a subagent a red bot. Edit and fork are advertised as `capabilities.editMessage` /
`capabilities.forkMessage`, and branch rides `forkMessage`, so a backend without fork support never shows
any of the three.

### Git and files (browser host)

VS Code has an Explorer, editor and Source Control and leaves `filePreview` / `gitPanel` off; the browser host
turns them on so the panel stands on its own:

- **Git panel** (`Ctrl+Alt+G`): the repositories under the active project — its own plus any nested
  ones (a submodule, a separate checkout) — with their repository headers pinned at the top and one
  open repository's recent commits, branch graph, sync bar and uncommitted changes below it. Every
  action targets the open repository. Resizable from its edge; the header list scrolls when a parent
  directory holds more repositories than fit, the open detail keeps a floor (and drags taller from
  its own handle) so Changes and History stay readable; long refs fold.
- **Explorer**: the session project's files with git status badges, resizable, refreshed by polling
  `listFiles` (`fresh: true`) and `gitStatus`, with a filter box that narrows it to a flat, ranked list of
  matching files. The tree draws in levels: every top-level entry up front, then one folder's level
  (`listDir`) as it opens — so a parent directory past the file index's cap still lists all of it.
- **Preview tabs**: a file opens read-only as a chip of the session in front (its own tab when no session is
  open); over 512 kB is truncated and a binary
  is named rather than decoded. Drag the line numbers to pin a `path:start-end` range into your next message;
  touching ranges merge and can be edited by their handles.
- **Tab strip**: sessions and files open side by side, quoted files get their own row, and right-click offers
  Close / Close Others / Close to the Right / Close All. A session's menu spans the whole strip; a file chip's
  menu spans only its row, so closing a chip never closes the session tab that owns it, and closing the chip in
  front returns to that session rather than the file beside it. When any file name in
  the row is shared, the whole chip row goes two lines — every chip spells out its directory, clipped at the
  front so the folder nearest the file stays visible, and all chips share one height (two `postgresql.yaml`
  are told apart without a tooltip); with no shared name, every chip keeps its single row.
- **Bottom panel**: a chip row below the composer that opens a tool and drags taller from its top edge. Its
  first tool is a **terminal** — one or more real PTYs (`node-pty`) per session, each in its own tab, in the
  viewing project, rendered with xterm.js (ANSI, colours, cursor, resize, full-screen programs). Terminals
  are never shared across sessions and close with their session tab; the shell itself lives in the host, not
  the page, so a reload reattaches and replays the scrollback, and the output survives a host restart from
  `<MORSE_HOME>/terminals/` (an idle shell is reclaimed after `MORSE_TERMINAL_IDLE_MS`, default 30 min). The
  emulator is lazy-loaded. The shell starts with the user's own environment, `MORSE_*` stripped, so running Morse
  from inside Morse does not inherit the host's port or workspace. URLs in the output are clickable (a small
  link provider, `features/terminal/terminal-links.ts`, opens them in a new tab), so a dev-server banner is one
  click, not a copy. VS Code leaves `terminal` off and keeps its own.

### MCP servers

pi already connects MCP servers from `~/.pi/agent/mcp.json` and a project's `.pi/mcp.json`, and OpenCode from
the `mcp` key of `opencode.json[c]`. The browser host adds a manager for both (`Ctrl+Alt+S`, or the indicator
dot in the chat toolbar, gated on `capabilities.mcp`); the VS Code window wires the MCP administration from its
default engine only, and gates it on an engine CLI — which OpenCode has none of, so an OpenCode-default window
shows no MCP manager:

- **Indicator**: a dot whose colour is the active directory's MCP health — green when every enabled server
  connected, amber while one is connecting or needs sign-in, red when one failed or the config is malformed.
  The list comes from the configured files; pi then probes each enabled server in the background for its live
  state, and OpenCode reports configured state only (a server connects when a session starts). The answer is
  cached for a minute per directory. Servers a pi extension registers have no file entry, so they are not
  listed — the panel says the list is configured files only.
- **Manage**: remove a server and enable or disable it. One scope control — **This project** (default) or
  **Global** — decides which file every action writes. "This project" writes pi's `.pi/mcp.json` or
  OpenCode's project `opencode.json[c]`; disabling a pi user-level server there writes a **project override**
  (like pi's "Disable in this project"), so other projects are unaffected. Enable/disable edits the same file
  that defines the server; every other key and entry is preserved. The manager is the list; adding a server is
  a separate editor view.
- **Read JSONC, fix it explicitly**: both engines' files are read as JSON or JSONC, so a file with comments
  or trailing commas still lists. A write to a user's JSONC file is refused instead of silently dropping the
  comments; a malformed file or entry is shown with its file, JSON pointer and a bounded snippet, and
  **Fix** rewrites the named file as strict JSON in the browser host — never an arbitrary path.
- **Add + inspect**: **Add server** opens the MCP editor — a tab in the browser host, a VS Code editor panel
  (`WebviewPanel`, routed `#/mcp`) in the extension — one at a time, and a second click just re-focuses it.
  The editor builds the entry and **Test connection** probes it with Morse's own MCP client (no Inspector
  package): `initialize` + `tools/list` / `resources/list` / `prompts/list` over stdio or Streamable HTTP, so
  the tools (or the exact failure: `auth`, `unreachable`, `timeout`, `protocol`, `spawn`) are visible before
  anything is written to the engine's config. A half-filled entry survives a reload: the form is kept in the host's
  own store (VS Code's webview state, restored by a panel serializer; `localStorage` in the browser), and the
  browser host also restores the MCP tab itself.
- Project config is trust-gated by pi. When the project is not trusted the panel shows pi's note and a
  **Trust this project** button; that writes pi's own decision (`<agentDir>/trust.json`, the same "Trust" its
  prompt records) and refreshes, so the project's `.pi/mcp.json` loads without leaving Morse. A folder trusted
  as a parent covers its children, exactly as pi resolves it.
- The editor does not sign in: an OAuth server is reported as **needs sign-in** with its protected-resource
  metadata URL, and pi's own `/mcp` (or the reference Inspector) completes the flow.

### Keyboard, templates, updates, install

- One shortcut catalog (`packages/ui-angular/src/app/services/shortcut.service.ts`) with a `?` list that prints exactly
  what is bound; an owner that is not mounted is shown as unavailable rather than promised.
- Prompt templates run from a generated form with a live preview; a template file added or edited shows up
  without restarting pi (`commands/refresh`). A template pi refuses — bad YAML frontmatter, its own "Prompt
  conflicts" — is dropped from the palette and shown as one warning row above the conversation (never inside
  it), with the files and pi's message behind a **Details** click. In the browser host the same editor edits
  OpenCode's `commands/*.md` files and the user config's `command` entries, and lists a config file it cannot
  write yet as an issue with its **Fix**; the VS Code window's editor is wired to its default engine's
  templates only.
- A model added to `models.json` shows up without restarting the host or the session: opening the model
  picker asks for a fresh catalog (`models/refresh`), and a reload re-reads the warm session's catalog.
  On a draft the session-less probe is re-run; on a warm session it is a plain RPC re-read.
- A newer released Morse **and a newer pi** are read once from the npm registry when the host advertises
  `capabilities.updateCheck` (`MORSE_UPDATE_CHECK=0` turns both off). The pi notice appears when the host could
  read the installed version (`capabilities.piVersion`) and says the one command pi itself prints, `pi update`.
- The `@supanadit/morse-web` npm package ships the browser host as a daemon CLI
  (`morse start|status|logs|stop|restart`).

### Bot mode (beta)

Bot mode is shipped and **still beta**: it works, and its edges are still being cut. A host that advertises
`capabilities.bot` (the browser host does; the VS Code window does not yet) draws a `Bot` tab next to `Code`.

- **Bots of their own.** Each bot is an agent with its own directory, engine (`pi` or OpenCode), model, keys,
  persona, tools and subagents — written into that engine's own config files, not into a Morse copy of them.
  `engine.json` is an index entry: handle, name, description, engine, env names.
- **The reader's machine, not a sandbox.** A bot runs as you, so its file tools reach your home directory and
  its shell runs any command you can — rootless Podman, `systemctl --user`, `~/.ssh`. Morse keeps the engine's
  own state in the bot's tree — config in `<bot>/config`, auth, database, sessions and logs in
  `<bot>/sessions` — and gives each bot its own workspace; that is placement, not a boundary between bots.
  There is no OS-level sandbox behind it ([CONFIGURATION.md](CONFIGURATION.md)).
- **Talking.** Direct messages and groups, with `@mentions`, `@all`, and a lead that answers an unaddressed
  message; a room with no lead fans the line out to every member. Each bot runs its own lane, so one bot's
  turn never holds another's and a room can have two bots answering at once; a line sent while they work
  queues per bot and the presence row says who is still waiting.
- **A roster bots can read.** A bot's description is its capability signal: `bot_list` returns every bot this
  Morse runs with its state and whether it is in the same room, and `bot_send` hands work to one of them. The
  habit is Morse's own instruction, written into the slot each engine already reads (pi's
  `APPEND_SYSTEM.md`, OpenCode's `instructions[]`), so a persona or `AGENTS.md` edit cannot break it. Sending
  to a bot outside the room opens a private thread instead of dropping work into someone else's conversation.
- **Threads.** A bot-to-bot conversation is a row under *Threads*, between the bots and the groups: readable,
  openable, and stoppable per bot like any room. It has no group record behind it, so the room dialog does not
  manage it.
- **Stopping one bot.** A turn belongs to a bot in a conversation, not to the room: the menu's stop cancels
  that bot's turn and its queued deliveries there, leaving its teammates and its other rooms untouched.
  Without a handle the whole room stops; either way the engine sessions stay warm.
- **Editable rooms.** A group can be renamed, re-membered and re-led. Removing a member clears only that bot's
  pointer to the room's session, so adding it back starts fresh; deleting a group removes its transcript and
  each member's session for it. A private thread two bots opened can be deleted too — its transcript, its
  asks, its turn history and both bots' sessions go with it, and the next ask between the pair opens a fresh
  one. Deleting a bot removes everything of its own and leaves every group it shared otherwise intact — a
  group is deleted only when that bot was its last member.
- **Presence, not a trace.** While a bot works, one line per running bot says what it is doing (`Wait, let me
  think…`, `Reading launch-brief.md…`, `Running npm test…`) where its answer will land, and the answer appears
  under it as it is written rather than in one block when the turn ends. Tool activity never enters the
  transcript. A lane belongs to a bot in a conversation, so reading another room never hides one still
  working — each keeps its row until its own turn ends, and the sidebar's dot breathes on the rows that are
  answering, in front or not.
- **The work behind the words.** A working bot's row opens to the steps it has taken — the newest three, with
  the count of the rest — and carries one chip per bot it asked: `asked @loom`, `loom is working`,
  `loom answered`, `loom failed`, each opening that thread. Past five seconds the row says how long the turn
  has run (`42s`, `2m 05s`). A row with no new step and nothing running for twenty seconds stops shimmering and
  says it is waiting on the model, so a hard think is not mistaken for a stall.
- **A finished turn stays as one line.** Above the answer it produced: the bot's name, how long it took, how
  many steps and who it asked; opening it shows the steps the turn kept (up to eight) and every ask, each with
  how far it had got when the turn settled — a peer can answer after the asker's turn is over. A turn that
  failed or was cancelled keeps its line too. A room keeps its newest hundred turns for seven days, so
  scrolling back finds the work behind an answer without the transcript ever growing a tool log.
- **A delegated answer comes home.** A bot that asks a peer in a private thread is woken in the room the person
  spoke in, with the peer's answer in hand, and answers the person itself: the person sees their own bot's
  words, never another bot joining the chat. The room still shows the delegation: a folded `Messaged <bot>`
  line above the answer it produced opens to the peer's own message, and while the peer works the composer
  carries a *Waiting for replies* block, one row per peer, which opens its thread. If the bot that asked can no
  longer be woken there, Morse says what came back instead of dropping it. A delegated turn that failed or was
  cancelled is said in that room too, naming the bot and how it ended.
- **A budget you can see.** Usage and context are per bot per conversation: while a bot runs, its presence row
  carries that bot's own ring, and a room with nobody running shows none. The composer keeps one ring, for the
  bot that reported most recently, named so a group's ring says whose window it is. Clicking a ring opens the
  same popup in its bot form: spent and remaining tokens, because a bot's message counts, cache, speed and
  cost belong to one engine session and are not a run of the reader's work.
- **Shrinking and forgetting.** *Compact* asks the members that have answered to summarise what they hold — the
  transcript keeps every line, since compaction is about the engine's context, not the reader's history; a
  conversation where nobody has answered yet says so rather than starting a session to compact nothing.
  *Clear messages* is the gesture that forgets: it asks first, then deletes the conversation's transcript file
  and each member's engine session, leaving the bot or group itself in place.
- **Copying.** Any line — the reader's or a bot's — copies verbatim from `morse-copy-button`, the same control
  code mode's transcript draws, so the glyph and the confirmation cannot drift apart between modes.
- **Attachments.** Images go to the model as prompt content (gated by the model's own modality); other files are
  written into that bot's `workspace/uploads/` and named as a path it opens with its own tools.
- **Model limits by hand.** Context window, output cap and image support are editable per model on create and
  edit, because discovery cannot always know them — absent means the engine's default.
- **Transcripts that survive.** One append-only JSONL per conversation, paged from the end, with "new
  discussion" as a divider rather than a lost history.
- **Coming back to where you were.** The `Code`/`Bot` tab and the conversation that was in front are the
  reader's, so they survive a reload: bot mode reopens the last DM, group or thread, and forgets one the host
  no longer lists (`state/mode-prefs.ts`).
- **Data upgrades.** `.morse/` carries a layout version; migrations and an additive reconcile run on `morse start`
  (see [DATA-COMPATIBILITY.md](DATA-COMPATIBILITY.md)).

## Not built yet

- **OpenCode-only gaps, by design** — no Morse-side mode editor (modes are OpenCode's own agents), no custom
  compaction instructions, no version notice, and no automatic restart of a crashed owned server. Each is
  reported rather than simulated: a compaction with instructions warns and compacts without them; the browser
  host's OpenCode MCP manager reports configured state rather than a live probe.
- **Editing files in the browser** — the file tab is a read-only editor by design. It reads, folds, searches,
  quotes and diffs, but nothing writes: there is no save path, no dirty state and no language server.
- **Staging, approving or rejecting changes as a set** — diffs are shown (tool-call diffs in the transcript,
  a file's diff in the preview), but there is no review surface that acts on them as a whole.
- **Authentication on the browser host** — there is none. `--lan` is for trusted networks only, or put an
  authenticating proxy in front.
