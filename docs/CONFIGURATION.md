# Configuration

## VS Code settings

Settings live under `morse.*`:

| Setting | Meaning |
|---|---|
| `morse.pi.path` | Path to the `pi` executable. Empty = `pi` from `PATH` |
| `morse.pi.entry` | Run a pi RPC entry (`dist/bundle/rpc-entry.js`) with node instead of the binary |
| `morse.pi.sessionDir` | Override the session directory (`pi --session-dir`) |
| `morse.pi.noSession` | Run without persisting a session (`pi --no-session`) |
| `morse.pi.extraArgs` | Extra arguments for the pi process |
| `morse.pi.requestTimeoutMs` | Per-request RPC timeout |
| `morse.sessions.hotLimit` | How many `pi` processes stay warm (LRU, default 4) |

## Browser host environment

The NestJS host and the `morse` CLI are configured through the environment:

| Variable | Default | Meaning |
|---|---|---|
| `MORSE_HOST` | `127.0.0.1` | Bind address |
| `MORSE_PORT` | `4399` | Port (the CLI picks the next free one if this is taken and unset) |
| `MORSE_HOME` | `~/.morse` | Data directory: CLI state, pidfile, logs, the saved shell layout (`workbench.json`), the per-tab composer drafts (`drafts.json`) and the terminal scrollback (`terminals/`) |
| `MORSE_WORKSPACE` | current directory | Directory the agent works in |
| `MORSE_PROJECTS` | unset | Roots the agent may open, e.g. `/a:/b` |
| `MORSE_HOT_SESSIONS` | `4` | How many `pi` processes stay alive at once |
| `MORSE_PI_PATH` / `MORSE_PI_ENTRY` | unset | Path to the `pi` binary, or a pi RPC entry run with node |
| `MORSE_SESSION_DIR` / `MORSE_NO_SESSION` | unset | pi session persistence |
| `MORSE_REQUEST_TIMEOUT_MS` | `30000` | Per-request RPC timeout |
| `MORSE_UI_DIR` | bundled frontend | Override the served frontend directory |
| `MORSE_UPLOAD_DIR` | `.morse/uploads` | Where browser uploads land (relative to a session cwd, or absolute) |
| `MORSE_UPDATE_CHECK` | enabled | Whether the panel may read the published Morse and pi versions from the npm registry (`0`/`false`/`off` disables both) |
| `MORSE_SELF_UPDATE` | disabled | Whether the browser footer's update notice may install the latest release and restart the host (`1`/`true`/`on`/`yes` enables). Off by default; see below |
| `MORSE_TERMINAL_IDLE_MS` | `1800000` | How long a terminal's shell keeps running with no page attached before the host reclaims it (`0` disables the timeout) |
| `MORSE_LSP_IDLE_MS` | `600000` | How long a language server keeps running after the last request that used it (`0` disables the timeout) |
| `MORSE_LSP_TS`, `MORSE_LSP_JSON`, `MORSE_LSP_YAML`, `MORSE_LSP_SH`, `MORSE_LSP_GO`, `MORSE_LSP_PY` | unset | Path to the server for that language, overriding the lookup order below |

`MORSE_PROJECTS` is the security boundary: when set, the agent may only work inside those roots. When unset,
any absolute path is accepted — fine for a host bound to `127.0.0.1`, not for one you expose.

`MORSE_HOT_SESSIONS` is the memory dial, and `pi` is what it multiplies: a hot session is a `pi` process plus
whatever else your own pi configuration loads beside it (measured: 275–450 MB per session on the machine we
tested, against ~110 MB for the host itself). On a small box, set it to 1 or 2.

`MORSE_UPDATE_CHECK` controls the only requests Morse makes to the internet: reading
`registry.npmjs.org/@supanadit/morse-web/latest` and `.../@earendil-works/pi-coding-agent/latest` once per
page load, so the sidebar can say when a newer Morse or a newer pi is out. They carry nothing about you or
your sessions, and an air-gapped host can turn the check off — the panel then simply never mentions updates.
The pi check only runs when the host could read the installed pi version (`capabilities.piVersion`), so a
host that could not is quiet on its own.

`MORSE_SELF_UPDATE=1` turns the sidebar's "Update available" row into a button that installs the latest
`@supanadit/morse-web` and restarts the host. It is off by default, and the server refuses the request unless
all of these hold: the variable was set, the caller is on this machine (`127.0.0.1`/`::1` — never a `--lan`
visitor, because the browser UI has no auth), and the running copy is an npm-global install this user can write
to. When any of them fails the button reports why and the hint still carries the command to run by hand. The
install itself runs in a detached helper that waits for the old process to exit, runs
`npm install -g @supanadit/morse-web@latest`, and starts the CLI again — the daemon never overwrites the files
it is running from. `morse update` does the same sequence from a terminal.

Files the browser uploads (drag-and-drop, paste, or the `+` button) land in `<session-cwd>/.morse/uploads/` and
ride as `@mentions`; `MORSE_UPLOAD_DIR` moves that inbox. Consider adding it to the project's `.gitignore`.

Terminals are the browser host's, and they outlive the page: the shell runs in the host, so a reload reattaches
to the same process and replays what it missed, and the output is written under `<MORSE_HOME>/terminals/` so it
survives a host restart too. `MORSE_TERMINAL_IDLE_MS` is the dial for how long a shell nobody is watching keeps
running before it is reclaimed — the scrollback stays either way. A shell only ends sooner when its pane is
closed.

## Interface preferences

Some display choices belong to whoever is reading, not to the host, so they live in the panel
(`localStorage`) and behave the same in both hosts:

| Key | Values | Meaning |
|---|---|---|
| `morse.navigation.collapsed` | `1` / `0` | Wide layouts only: the sidebar column folded away |
| `morse.chat.toolDisplay` | `compact` / `timeline` | `compact` (default): one summary line per turn, a tree of steps with their files; `timeline`: the legacy always-open cards |

The tool-call toggle sits in the chat header, next to the conversation compactor; the compact tree is the
default, and `timeline` is the opt-in legacy view. Storage is a nicety: with `localStorage` unavailable the
choice still holds for the session.

### Explorer and tabs (browser host)

When the host advertises `filePreview` — the NestJS/browser host does, VS Code does not — the sidebar grows
an **Explorer** for the session's project and the chat grows a **tab strip**. Clicking a file opens it in a
new preview tab; selecting a session opens or reveals its tab and activates that session. A **filter box**
above the tree narrows the project to the files whose path matches — the tree gives way to a flat, ranked
list with each file's folder beside it — and the title bar counts the matches (`3 of 41`), so finding a file
whose folder the reader would otherwise have to open by hand is one box instead of a walk. The strip is
frontend state, and the browser host persists it (with the bottom panel and its terminals) to
`<MORSE_HOME>/workbench.json`, so opening the page again lands on the tab the reader left; the drafts of
those tabs — text, pins, mentions and inline images — are persisted per tab to
`<MORSE_HOME>/drafts.json`, so a long prompt survives a reload or a `morse stop`. VS Code keeps its own tab
restoration and restores nothing here. A preview is read-only on purpose: VS Code is the
host with an editor. A file over 512 KB is shown truncated, and a binary file is named rather than decoded.
Drag across the preview's line numbers to pin a range (`path:start-end`) to your next message — picking a
file in the `@` picker opens it so the drag is one step away. Ranges that touch or overlap become one chip
(and one highlight); dragging from inside an existing highlight edits that range, and its top and bottom
edges are handles you can pull to move a boundary. Pull one into a neighbouring range and the two merge.
Right-click a tab for Close, Close Others, Close to the Right and Close All — the actions VS Code's own tab
menu offers. The menu's scope is the tab you clicked: on a **session** it spans the whole strip (its quoted
files go with it), but on a **file chip** it only spans that chip's row, so closing a chip can never take the
session tab with it. Files opened from the `@` picker get their own row below the sessions, so quoting a file
never pushes a session tab aside.

## Prompt templates

pi turns Markdown files under `~/.pi/agent/prompts` (and, once a project is trusted, `<project>/.pi/prompts`)
into `/commands`. Run **Edit prompt templates** — from the toolbar's document button, the command palette, or
`Ctrl+Alt+E` (it is a Morse command, not a pi one) — to open Morse's editor for them: the browser host opens a
**Prompt templates** tab next to the sessions, and VS Code opens a **Prompt templates** editor panel, the same
way the MCP editor does. It lists the
templates the host read — your user prompt directory plus, with a session in front, that session's project
`.pi/prompts` — writes the file for you (frontmatter and body) and tests the expansion before you run it.

The editor understands pi's full substitution vocabulary: `$1`, `${1:-fallback}`, `$@` / `$ARGUMENTS`,
`${@:-fallback}`, `${@:2}` and `${@:2:3}`, with shell-like quoting for arguments that contain spaces. The
**Fields** tester derives one input per argument from `argument-hint` (angle brackets required, square brackets
optional) and shows the `${n:-…}` default as its placeholder; the **Raw** tester parses a line the way pi does.
Either way the preview is the exact prompt the agent would receive. A save asks the host to re-read the files, so
a new or renamed template shows up in the palette without restarting the session.

A template pi would refuse (invalid YAML frontmatter) is listed with its error instead of vanishing: fix the
frontmatter and save. Writing a project template works before the project is trusted, but pi ignores `.pi/prompts`
until you trust it — the editor says so, and the MCP panel's **Trust this project** does it. With no session in
front there is no project scope, so the editor offers the user templates only.
