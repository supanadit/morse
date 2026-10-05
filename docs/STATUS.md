# Status

Morse **v0.9.2**. This page is the honest inventory of what ships. Everything else points here:
[`README.md`](../README.md) for the pitch, [`ARCHITECTURE.md`](ARCHITECTURE.md) for how it is built,
[`CONFIGURATION.md`](CONFIGURATION.md) for the knobs, [`FRONTENDS.md`](FRONTENDS.md) for the frontend contract.

## Shipped

### The conversation

- Markdown transcript with highlighted, copyable code blocks.
- Tool calls as a **compact tree** by default: one summary line per turn with its steps and the files they
  touched nested under it. The always-open timeline is a per-user toggle (`morse.chat.toolDisplay=timeline`).
- Thinking streams as it arrives, and a resumed session is seeded from the agent — never from a blank panel.
- Paged history for long sessions.

### While the agent works

- `steer`, follow-up and abort. Steering lands in the running turn; a prompt sent mid-run with no mode is
  **queued** as a follow-up rather than refused, and shown above the composer (`Queued messages`: edit, send
  now, remove) until it runs as the current turn settles.
- Compaction behind an explicit confirmation, optionally with custom instructions (`session/compact`).
- pi's interaction requests: native QuickPick/InputBox in VS Code, rendered inline in the browser.
- Failures surface as notices (`error` message) instead of a dead panel.

### Model and thinking level

- Pickers for both, applied to the running session through pi's `set_model` / `set_thinking_level`.
- The thinking picker **mirrors what pi supports for the current model**, not a fixed list: pi scopes the
  levels to the model, so switching models re-reads them (and the level pi settled on — a model without
  reasoning resets it to `off`). The same re-probe runs for a model picked on a draft, before any session
  exists.
- This **is** the per-session model override. A session records its own model and thinking-level changes, and
  resuming it restores them, so the choice follows that session across eviction, resume and host restart
  without touching pi's defaults for new sessions.
- A brand-new, empty panel probes an untouched pi spawn (pi `--no-session`) for the real model and command
  catalog, so the first picker is populated before any session exists.

### Sessions and projects

- One `pi` process per session, kept warm LRU-style (`MORSE_HOT_SESSIONS`, default 4), so switching projects or
  reloading the page reattaches instead of respawning. A live session is a whole pi process (275–450 MB);
  the cap is the number to size a box by.
- An **In progress** section lifts the sessions working right now, so several active sessions are visible at
  once instead of only the selected one (`session/activity`).
- Project browser with a searchable filter, session search, activate, close (retire the process) and delete
  (remove the session file, behind the host's own confirmation).
- The browser host allows any directory; the VS Code host advertises `capabilities.scope: 'workspace'` and
  filters projects and sessions to the workspace roots.

### Context you attach

- VS Code: editor selection plus a live selection chip that follows the caret while the user drags.
- Everywhere: drag/drop/paste images; browser uploads land next to the session (`<cwd>/.morse/uploads/`) and
  ride as `@mentions`.
- The `@mention` picker lists files **and** directories (`@docs/` drills in) and honours `.gitignore`.

### Editing what was sent

Forking — pi's `fork` primitive — is behind both:

- **Edit and resend** (`chat/edit`): fork before a past user message, discard that turn and everything after,
  then send the edited text as a fresh prompt. Attachment chips on the original ride along.
- **Fork** (`chat/fork`): the same fork without sending anything. The old branch stays resumable, the
  transcript re-homes onto the new (shorter) branch, and the forked prompt goes back to the composer.

Both are advertised as `capabilities.editMessage` / `capabilities.forkMessage`, so a backend without fork
support simply never shows the affordance.

### Git and files (browser host)

VS Code has an Explorer, editor and Source Control and leaves `filePreview` / `gitPanel` off; the browser host
turns them on so the panel stands on its own:

- **Git panel** (`Ctrl+Alt+G`): the active project's recent commits with their branch graph, plus the
  working tree's uncommitted changes with a per-file kind. Resizable from its edge; long refs fold.
- **Explorer**: the session project's files with git status badges, resizable, refreshed by polling
  `listFiles` (`fresh: true`) and `gitStatus`.
- **Preview tabs**: a file opens read-only as a chip of the session in front (its own tab when no session is
  open); over 512 kB is truncated and a binary
  is named rather than decoded. Drag the line numbers to pin a `path:start-end` range into your next message;
  touching ranges merge and can be edited by their handles.
- **Tab strip**: sessions and files open side by side, quoted files get their own row, and right-click offers
  Close / Close Others / Close to the Right / Close All. A session's menu spans the whole strip; a file chip's
  menu spans only its row, so closing a chip never closes the session tab that owns it.
- **Bottom panel**: a chip row below the composer that opens a tool and drags taller from its top edge. Its
  first tool is a **terminal** — one or more real PTYs (`node-pty`) per session, each in its own tab, in the
  viewing project, rendered with xterm.js (ANSI, colours, cursor, resize, full-screen programs). Terminals
  are never shared across sessions and close with their session tab; the shell itself lives in the host, not
  the page, so a reload reattaches and replays the scrollback, and the output survives a host restart from
  `<MORSE_HOME>/terminals/` (an idle shell is reclaimed after `MORSE_TERMINAL_IDLE_MS`, default 30 min). The
  emulator is lazy-loaded. VS Code leaves `terminal` off and keeps its own.

### MCP servers

pi already connects MCP servers from `~/.pi/agent/mcp.json` and a project's `.pi/mcp.json`. Morse adds a
manager for them (`Ctrl+Alt+S`, or the indicator dot in the chat toolbar, gated on `capabilities.mcp`):

- **Indicator**: a dot whose colour is the active directory's MCP health — green when every enabled server
  connected, amber while one is connecting or needs sign-in, red when one failed or the config is malformed.
  The state comes from `pi mcp list --json`, cached for a minute per directory.
- **Manage**: add a stdio or HTTP server, remove one, and enable or disable it. One scope control —
  **This project** (default) or **Global** — decides which file every action writes. "This project"
  writes `.pi/mcp.json`; disabling a user-level server there writes a **project override** (like pi's
  "Disable in this project"), so other projects are unaffected. Enable/disable edits the same `mcp.json`
  pi reads; every other key and entry is preserved.
- Project config is trust-gated by pi. When the project is not trusted the panel shows pi's own note, since
  a project server will not load until the folder is trusted.
- The panel does not sign in: an OAuth server is reported as “needs sign-in”, and `pi mcp login` / pi's own
  `/mcp` handle that.

### Keyboard, templates, updates, install

- One shortcut catalog (`packages/ui-angular/src/app/core/shortcuts.ts`) with a `?` list that prints exactly
  what is bound; an owner that is not mounted is shown as unavailable rather than promised.
- Prompt templates run from a generated form with a live preview; a template file added or edited shows up
  without restarting pi (`commands/refresh`).
- A model added to `models.json` shows up without restarting the host or the session: opening the model
  picker asks for a fresh catalog (`models/refresh`), and a reload re-reads the warm session's catalog.
  On a draft the session-less probe is re-run; on a warm session it is a plain RPC re-read.
- A newer released Morse is read once from the npm registry when the host advertises
  `capabilities.updateCheck` (`MORSE_UPDATE_CHECK=0` turns it off).
- The `@supanadit/morse-web` npm package ships the browser host as a daemon CLI
  (`morse start|status|logs|stop|restart`).

## Not built yet

- **Session rename** — sessions are named by pi and only by pi; Morse has no rename path on the wire.
- **Editing files in the browser** — the preview is read-only on purpose. VS Code is the host with an editor;
  the browser host reads, quotes and diffs, but does not write.
- **Staging, approving or rejecting changes as a set** — diffs are shown (tool-call diffs in the transcript,
  a file's diff in the preview), but there is no review surface that acts on them as a whole.
- **Authentication on the browser host** — there is none. `--lan` is for trusted networks only, or put an
  authenticating proxy in front.
