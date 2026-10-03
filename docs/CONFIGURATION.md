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

`MORSE_UPDATE_CHECK` controls the only request Morse makes to the internet: reading
`registry.npmjs.org/@supanadit/morse-web/latest` once per page load, so the sidebar can say when a newer release
is out. It carries nothing about you or your sessions, and an air-gapped host can turn it off — the panel then
simply never mentions updates.

Files the browser uploads (drag-and-drop, paste, or the `+` button) land in `<session-cwd>/.morse/uploads/` and
ride as `@mentions`; `MORSE_UPLOAD_DIR` moves that inbox. Consider adding it to the project's `.gitignore`.
