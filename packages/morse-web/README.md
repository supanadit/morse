# @supanadit/morse-web

**Morse in your browser, as one npm package.** It serves the same Angular frontend and drives the same
[Pi](https://github.com/earendil-works/pi) coding agent as the VS Code extension — no VS Code required.

```bash
npm install -g @supanadit/morse-web
morse start
```

```
  ▲  Morse started
  │
  ◆  port 4399 (PID: 20880)
  │
  ●  visit: http://127.0.0.1:4399/
  ●  logs:  morse logs
  │
  └  daemon running — the terminal can be closed
```

Then open <http://127.0.0.1:4399/>. The server keeps running in the background; stop it with `morse stop`.

## Requirements

- Node.js 20+ (developed on 24).
- The `pi` CLI on your `PATH` and already authenticated (`pi --version`), or a path via `MORSE_PI_PATH`.
  Morse reuses your existing pi configuration: models, credentials, tools and sessions under `~/.pi`.

## Commands

| Command | What it does |
|---|---|
| `morse` / `morse start` | Start the server as a background daemon and print the URL |
| `morse start -f` | Run in the foreground (systemd `Type=simple`, Docker) |
| `morse stop` | Stop the running server |
| `morse restart` | Stop, then start |
| `morse status` | Show PID, URL, workspace and uptime (`--json` for scripts) |
| `morse logs` | Print the server log (`--follow` to tail) |
| `morse help`, `morse version` | Help / version |

### Options

```
-p, --port <n>       Web server port (default: 4399, next free if taken)
--host <addr>        Bind address (default: 127.0.0.1)
--lan                Bind 0.0.0.0 so the LAN can reach it
-f, --foreground     Run in the foreground
--workspace <dir>    Directory the agent works in (default: the current one)
--projects <list>    Comma/colon separated roots the agent may open
--open               Open the browser once healthy
--force              Replace a server this CLI already started
```

### Environment

```
MORSE_HOME             Data directory (default: ~/.morse)
MORSE_PORT             Default port
MORSE_HOST             Default bind address
MORSE_WORKSPACE        Workspace the agent runs in
MORSE_PROJECTS         Roots the agent may open
MORSE_HOT_SESSIONS     How many pi processes stay alive (default: 4)
MORSE_PI_PATH          Path to the pi executable (default: pi on PATH)
MORSE_PI_ENTRY         Run a pi RPC entry with node instead of the binary
MORSE_UI_DIR           Override the served frontend directory
```

## Security

`morse start` binds `127.0.0.1` by default. `--lan` exposes an **unauthenticated** chat UI to your network:
only do it on a trusted network, or put a TLS reverse proxy with auth in front of it.

## How the single package is built

Everything lives in one tarball:

```
dist/server.mjs   NestJS host, with every @morse/* workspace package inlined
dist/cli.mjs      the `morse` lifecycle CLI
dist/ui/          the built Angular frontend, served as static assets
```

The `@morse/*` packages are private workspace libraries, so they cannot be installed from npm — bundling
them into `server.mjs` is what makes a single publishable artifact possible. The NestJS runtime
(`@nestjs/*`, `rxjs`, `ws`, `reflect-metadata`) stays external and is installed normally from
`dependencies`.

## Uninstall

```bash
morse stop
npm uninstall -g @supanadit/morse-web
rm -rf ~/.morse      # state and logs
```
