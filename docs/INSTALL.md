# Installing Morse

Morse ships as **two independent artifacts** for the same product. Install whichever host you want, or both.

| Host | Artifact | How you get it | Entry point |
|---|---|---|---|
| VS Code | `morse-<version>.vsix` (`supanadit.morse`) | VS Code Marketplace, or build it from `packages/extension` | the Morse panel in the activity bar |
| Browser / CLI | `@supanadit/morse-web` on npm | `npm install -g @supanadit/morse-web` | `morse start` |

Both hosts load the **same Angular bundle** (`@morse/ui-angular`) and drive the **same `pi` subprocess**
through `@morse/adapter-pi-rpc`; only the delivery differs. Their requirements are therefore identical:

- Node.js 20+ (developed on 24) and npm 10+.
- The `pi` CLI on `PATH` and already authenticated (`pi --version`), or a path to it via `morse.pi.path`
  (VS Code) / `MORSE_PI_PATH` (CLI). Morse reuses your existing pi config: models, credentials, tools and
  sessions under `~/.pi`.

Without pi, Morse does not pretend: the panel shows a **setup screen** naming the missing agent, with the
install command to copy, the setting or environment variable this host reads (`agentFailure` on the wire),
and a Retry button. Nothing else needs to be configured first — Morse is only the interface, and it says so.

---

## 1. VS Code extension

### 1.1 Install a built VSIX

```bash
code --install-extension dist/morse.vsix          # add --force to replace an older build
code --list-extensions | grep morse
# supanadit.morse
```

Then reload VS Code (or run **Developer: Reload Window**) and open the **Morse** icon in the activity bar.

Uninstall:

```bash
code --uninstall-extension supanadit.morse
```

### 1.2 Build the VSIX yourself

```bash
npm install
npm run package          # build everything -> verify webview -> vsce package -> dist/morse.vsix
```

The usual rebuild-and-reinstall loop while iterating on the extension (the VSIX always overwrites
`supanadit.morse`, so `--force` is required):

```bash
npm run package && code --install-extension dist/morse.vsix --force
```

`npm run package` is `npm run build && npm run vsix -w morse`. The `vsix` script runs, in order:

1. `check-types` + `lint` + `node esbuild.js --production` → `packages/extension/dist/extension.js`
   (esbuild, CJS, `vscode` left external).
2. `node scripts/verify-webview.mjs` — **refuses to package** unless `packages/extension/media/webview`
   is a production bundle with a matching protocol version.
3. `vsce package --no-dependencies --out dist/morse.vsix`.

The extension bundle has **no npm dependencies at runtime**: `@morse/*` are inlined by esbuild, and
`@vscode/vsce` is only used at packaging time (`--no-dependencies`). The only runtime requirement is the
`pi` binary.

### 1.3 What `verify-webview.mjs` protects

A F5 development build (`ng build --configuration development`) has no `webview.manifest.json`, unhashed
asset names and no minification. Packaging that by accident produces a VSIX that looks fine but serves a
stale/development UI. The guard checks:

- `media/webview/index.html` exists and references a hashed `main-*.js`;
- `media/webview/webview.manifest.json` exists, parses, and its `protocolVersion` equals
  `packages/protocol/src/version.ts`.

Fix a refusal with:

```bash
npm run build:ui && npm run sync-webview
```

`sync-webview` copies `packages/ui-angular/dist` into `packages/extension/media/webview`. A different
frontend is swapped in with `npm run sync-webview -- --frontend=ui-react` (note the `--`; npm drops flags on
nested `npm run`). The `--frontend` flag is ignored if passed without `--`.

### 1.4 Development loop (F5)

Open the repository in VS Code and press <kbd>F5</kbd> (**Morse: run extension**). The launch config in
`.vscode/launch.json` uses the prelaunch task **morse: dev (build + watch)**, which runs `npm run dev:extension`:

- builds the libraries once (`@morse/protocol`, `core`, `host-runtime`, `adapter-pi-rpc`, `ui-runtime`),
- builds the Angular bundle and syncs it into `media/webview`,
- starts esbuild watch (extension), `ng build --watch` (UI) and the webview watcher in parallel.

The F5 window is an **Extension Development Host** loading `packages/extension` via
`--extensionDevelopmentPath`; the prelaunch task is a shell task with a problem matcher keyed on esbuild's
`[watch] build started` / `build finished`.

Other `.vscode` tasks: **morse: build ui**, **morse: build server**, **morse: package vsix**. The
**Morse: debug NestJS host** launch config runs `packages/server/dist/main.js` with `MORSE_PORT=4399`.

> After a UI change, run `npm run sync-webview` (or keep the F5 watcher running) or the webview stays blank.

> **F5 aborts with exit code 134?** Not Morse. VS Code 1.141's `js-debug` enables CDP network
> inspection on the extension-host inspector (`debug.javascript.enableNetworkView`, on by default),
> and the bundled Node aborts before any extension activates. The repo ships
> `.vscode/settings.json` setting it to `false`; **Ctrl+F5** (Run Without Debugging) is stable
> regardless. Upstream: [microsoft/vscode#336233](https://github.com/microsoft/vscode/issues/336233).

### 1.5 Extension settings

All settings live under `morse.*` (see the extension manifest / README):

| Setting | Meaning |
|---|---|
| `morse.pi.path` | Path to the `pi` executable. Empty = `pi` from `PATH` (or `MORSE_PI_PATH`) |
| `morse.pi.entry` | Run a pi RPC entry (`dist/bundle/rpc-entry.js`) with node instead of the binary |
| `morse.pi.sessionDir` | Override the session directory (`pi --session-dir`) |
| `morse.pi.noSession` | Run without persisting a session (`pi --no-session`) |
| `morse.pi.extraArgs` | Extra arguments for the pi process |
| `morse.pi.requestTimeoutMs` | Per-request RPC timeout |
| `morse.sessions.hotLimit` | How many `pi` processes stay warm (LRU, default 4) |

### 1.6 Install from a marketplace

```bash
code --install-extension supanadit.morse        # VS Code (Microsoft Marketplace)
codium --install-extension supanadit.morse      # VSCodium
cursor --install-extension supanadit.morse      # Cursor
```

Or search for **Morse** in the Extensions view, which lists it for any editor built on the VS Code API:

| Registry | Editors | Where |
|---|---|---|
| VS Code Marketplace | VS Code, and editors that opt into it | <https://marketplace.visualstudio.com/items?itemName=supanadit.morse> |
| Open VSX | VSCodium, Cursor, Windsurf, code-server, Theia | <https://open-vsx.org/extension/supanadit/morse> |

Both serve the same extension; only the registry differs. `--force` replaces a VSIX you installed by hand, and a
manual install has to be removed first if the marketplace one should take over (`code --uninstall-extension
supanadit.morse`).

### 1.7 Publish to the marketplaces

`vsce publish` needs a Personal Access Token from the publisher (`supanadit`) and `publisher` already set in
`packages/extension/package.json`; Open VSX uses the same VSIX with an `ovsx` token:

```bash
npx @vscode/vsce publish --packagePath dist/morse.vsix -p <PAT>   # VS Code Marketplace
npx ovsx publish --packagePath dist/morse.vsix -p <OVSX_PAT>       # Open VSX
# or, inside packages/extension:
npm run vsix && npx @vscode/vsce publish
```

`vscode:prepublish` is wired to `npm run package`, so `vsce publish` rebuilds before shipping. Releases normally go
through the tag workflow instead — see [`RELEASING.md`](RELEASING.md).

---

## 2. CLI — the browser host (`morse`)

The published package is `@supanadit/morse-web`; it exposes one binary, `morse`. Internals of the artifact are
in [`PACKAGING.md`](./PACKAGING.md).

### 2.1 Install from npm

```bash
npm install -g @supanadit/morse-web
morse --version
morse start
```

### 2.2 Install from a local tarball (before it is on npm)

```bash
npm run build:web                      # libs -> Angular -> packages/morse-web/dist
npm pack -w @supanadit/morse-web       # writes ./supanadit-morse-web-<version>.tgz
npm install -g ./supanadit-morse-web-*.tgz
rm supanadit-morse-web-*.tgz
morse --version
```

This is a real copy of the artifact (`~/.nvm/.../lib/node_modules/@supanadit/morse-web` on nvm), not a
symlink: after any code change, repeat the three commands. Confirm where it landed with
`npm config get prefix` and `command -v morse`.

### 2.3 Dev link (optional, no re-pack)

```bash
npm run build:web
cd packages/morse-web && npm link      # global `morse` -> the repo dist/
```

`npm link` makes the global binary point at the workspace, so rebuilds are picked up immediately. Do **not**
use it at the same time as a global tarball install — they overwrite the same `morse` binary. Undo with
`npm unlink -g @supanadit/morse-web` inside `packages/morse-web`.

### 2.4 Running

```bash
morse start                 # daemon on 4399, prints URL, terminal may close
morse start --port 3020     # specific port
morse start --lan           # bind 0.0.0.0 (LAN, no auth)
morse start --open          # open the browser once healthy
morse start -f              # foreground (systemd Type=simple, Docker, Ctrl+C stops)
morse status                # PID, URL, workspace, uptime (--json for scripts)
morse logs --follow         # tail the server log
morse restart
morse stop
```

By default the server binds `127.0.0.1`. `--lan` exposes an **unauthenticated** chat UI to your network — use
it only on a trusted network or behind a TLS reverse proxy.

### 2.5 Where state lives

| Path | Contents |
|---|---|
| `~/.morse/server.json` | daemon state: pid, port, host, url, workspace, startedAt, instance (`MORSE_HOME` overrides) |
| `~/.morse/logs/server.log` | server stdout + stderr; `morse logs` reads this |
| `~/.morse/workbench.json` / `drafts.json` | the tabs, panel and terminals a browser left open, and its per-tab composer drafts |
| `~/.morse/terminals/` | terminal scrollback, one file per pane, so output survives a host restart |
| `<session-cwd>/.morse/uploads/` | browser uploads, attached as `@mentions` (`MORSE_UPLOAD_DIR` moves it) |

The daemon is `spawn(process.execPath, [dist/server.mjs], { detached: true, stdio: ['ignore', logFd, logFd] })`
followed by `unref()`, so it survives the shell exiting. `morse start` returns once `GET /api/health` answers
(up to 25 s). If `pi` is missing from the daemon's `PATH`, the server starts but the panel reports that the
agent is unavailable — set `MORSE_PI_PATH` in the environment you launch from.

### 2.6 Environment

`MORSE_HOME`, `MORSE_PORT`, `MORSE_HOST`, `MORSE_WORKSPACE`, `MORSE_PROJECTS`, `MORSE_HOT_SESSIONS` (4),
`MORSE_PI_PATH`, `MORSE_PI_ENTRY`, `MORSE_SESSION_DIR`, `MORSE_NO_SESSION`, `MORSE_REQUEST_TIMEOUT_MS`,
`MORSE_UPLOAD_DIR`, `MORSE_UI_DIR`, `MORSE_TERMINAL_IDLE_MS`, `MORSE_LSP_IDLE_MS`, `MORSE_LSP_TS`,
`MORSE_LSP_JSON`, `MORSE_LSP_YAML`, `MORSE_LSP_SH`, `MORSE_LSP_GO`, `MORSE_LSP_PY`.

The language servers the preview uses are resolved per language: an explicit `MORSE_LSP_<KEY>` path first, then
the project's own `node_modules/.bin`, then `PATH`, and finally `npx -y <package>` (which downloads once). A
host where none of those resolve simply reports that no server covers the file, and the preview says so instead
of showing a clean file.

`MORSE_PROJECTS` is the security boundary: when set (`/a:/b`), the agent only works inside those roots. Unset
means any absolute path is accepted — fine for `127.0.0.1`, not for `--lan`.

### 2.7 Uninstall

```bash
morse stop
npm uninstall -g @supanadit/morse-web
rm -rf ~/.morse        # state + logs (optional)
```

---

## 3. Verifying an install

```bash
# VS Code
code --list-extensions | grep morse
# CLI
morse --version
morse status
curl -s http://127.0.0.1:4399/api/health     # {"status":"ok","protocolVersion":15,"instance":"…",…}
curl -s http://127.0.0.1:4399/api/manifest   # the protocolVersion the served frontend speaks
```

`/api/health` and `/api/manifest` are also how a host detects a mismatched frontend: if the served bundle's
`protocolVersion` differs from the host's, rebuild the frontend (`npm run build:ui && npm run sync-webview`)
or the package.

## 4. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| VSIX contains unminified `main.js` and no manifest | a development webview was packaged; `verify-webview.mjs` blocks it — `npm run build:ui && npm run sync-webview` |
| Webview blank after a UI change | `npm run sync-webview` |
| `morse: command not found` after install | the global npm bin dir (`<prefix>/bin`) is not on `PATH`; check `npm config get prefix` |
| `morse start` prints "failed to start" | `morse logs`; most often `pi` is not on the daemon's `PATH` (set `MORSE_PI_PATH`) |
| Panel says “The pi coding agent is not installed” | the setup screen: `npm install -g @earendil-works/pi-coding-agent`, or point the host at an existing pi (`morse.pi.path`, needs a window reload / `MORSE_PI_PATH`, needs `morse restart`) |
| Browser shows “Morse is waiting for a host” after `morse stop` | the page is the frontend the browser is still holding, not the host; start it again (`morse start`) — that screen names both the CLI and the repo command. Nothing was lost: sessions live with the host and in pi’s session files |
| Browser UI stuck on `connecting` / blank page | open `http://127.0.0.1:<port>/api/health`; if it fails the server is not up — `morse logs` |
| Port busy after an unclean exit | `morse status`; state is `~/.morse/server.json`, then `morse restart` |
| Old favicon still shown | browser cache — hard-refresh (Ctrl+Shift+R) or an incognito window |
| Agent runs in the wrong project | sessions carry their own cwd; pass `--workspace <dir>` (CLI) or check `MORSE_WORKSPACE` |
| `EADDRINUSE` inside the NestJS dev loop | stale process; the host installs shutdown hooks — `morse stop` or kill the previous `dist/main.js` |
