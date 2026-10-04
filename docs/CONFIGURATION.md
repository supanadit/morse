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
| `MORSE_HOME` | `~/.morse` | CLI state, pidfile and logs |
| `MORSE_WORKSPACE` | current directory | Directory the agent works in |
| `MORSE_PROJECTS` | unset | Roots the agent may open, e.g. `/a:/b` |
| `MORSE_HOT_SESSIONS` | `4` | How many `pi` processes stay alive at once |
| `MORSE_PI_PATH` / `MORSE_PI_ENTRY` | unset | Path to the `pi` binary, or a pi RPC entry run with node |
| `MORSE_SESSION_DIR` / `MORSE_NO_SESSION` | unset | pi session persistence |
| `MORSE_REQUEST_TIMEOUT_MS` | `30000` | Per-request RPC timeout |
| `MORSE_UI_DIR` | bundled frontend | Override the served frontend directory |
| `MORSE_UPLOAD_DIR` | `.morse/uploads` | Where browser uploads land (relative to a session cwd, or absolute) |
| `MORSE_UPDATE_CHECK` | enabled | Whether the panel may read the published version from the npm registry (`0`/`false`/`off` disables it) |

`MORSE_PROJECTS` is the security boundary: when set, the agent may only work inside those roots. When unset,
any absolute path is accepted — fine for a host bound to `127.0.0.1`, not for one you expose.

`MORSE_HOT_SESSIONS` is the memory dial, and `pi` is what it multiplies: a hot session is a `pi` process plus
whatever else your own pi configuration loads beside it (measured: 275–450 MB per session on the machine we
tested, against ~110 MB for the host itself). On a small box, set it to 1 or 2.

`MORSE_UPDATE_CHECK` controls the only request Morse makes to the internet: reading
`registry.npmjs.org/@supanadit/morse-web/latest` once per page load, so the sidebar can say when a newer release
is out. It carries nothing about you or your sessions, and an air-gapped host can turn it off — the panel then
simply never mentions updates.

Files the browser uploads (drag-and-drop, paste, or the `+` button) land in `<session-cwd>/.morse/uploads/` and
ride as `@mentions`; `MORSE_UPLOAD_DIR` moves that inbox. Consider adding it to the project's `.gitignore`.

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
new preview tab; selecting a session opens or reveals its tab and activates that session. Tabs are frontend
state only (close the last one and the strip is empty), and a preview is read-only on purpose: VS Code is the
host with an editor. A file over 512 KB is shown truncated, and a binary file is named rather than decoded.
Drag across the preview's line numbers to pin a range (`path:start-end`) to your next message — picking a
file in the `@` picker opens it so the drag is one step away. Ranges that touch or overlap become one chip
(and one highlight); dragging from inside an existing highlight edits that range, and its top and bottom
edges are handles you can pull to move a boundary. Pull one into a neighbouring range and the two merge.
Right-click a tab for Close, Close Others, Close to the Right and Close All — the actions VS Code's own tab
menu offers.
