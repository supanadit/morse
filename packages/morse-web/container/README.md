# Morse container (enterprise, server mode only)

`localhost/morse:local`, built from [`Dockerfile`](./Dockerfile). This is the
multi-user deployment: login-gated, Postgres-backed, one workspace per user.
Host-native installs stay single-user; this image is the enterprise path.

Methodology follows `containers/container-scripts` (multi-stage build,
checksum-pinned everything, env-driven, ezx-supervised, non-root app).
The one deviation: the setup stage runs npm instead of `forge build` —
forge has no npm component yet.

## Build

From the repo root (context is the whole monorepo):

```bash
podman build -f packages/morse-web/container/Dockerfile -t localhost/morse:local .
```

Cache contract (verified): only a manifest/lock change reruns `npm ci`;
only a source change in a package rebuilds it (leaf libs → system →
integrations → UI → server bundle, in dependency order); entrypoint edits
rebuild only the runtime tail (~13 s). A no-change rebuild takes ~30 s.

## Run (quadlet)

Fresh deployments use the units in `~/.config/containers/systemd`:

- `morse.container` — the server, on the shared `buku.network` so
  `MORSE_PG_HOST=postgresql` resolves. Loopback-only `:4399`.
- `morse-data.volume` — `<MORSE_HOME>` (sessions spillover, workbench, logs).
- `morse-workspaces.volume` — one directory per login user.

```bash
systemctl --user daemon-reload
systemctl --user start morse   # first visit creates the admin account
```

The database is the shared `postgresql` container: one database per project,
created by hand (`CREATE DATABASE morse`), exactly like the other projects.

## Environment

| Variable | Default | What it does |
|---|---|---|
| `MORSE_MULTIUSER` | `1` | Login gate + per-user session index. The container's reason to exist. |
| `MORSE_WORKSPACE_ROOT` | `/workspaces` | Per-user fence: `<root>/<username>`, created on login. Unset disables fencing. |
| `MORSE_PG_HOST/PORT/USER/PASSWORD/DATABASE` | `postgresql/5432/postgres/<unset>/morse` | Session index. `MORSE_PG_PASSWORD` has no default — boot fails naming it. |
| `MORSE_OPENCODE_PASSWORD` | *(required)* | Loopback Basic secret for the bundled OpenCode sidecar. No default — boot fails naming it. |
| `MORSE_OPENCODE_URL` | `http://127.0.0.1:4096` | The sidecar the host attaches to (owned-mode announcement parsing is stale on OpenCode ≥ 1.19, so the sidecar is supervised instead). |
| `MORSE_PI_PATH` | `/opt/engines/bin/pi` | pi CLI (pinned `PI_VERSION`, npm-installed in the engines stage). |
| `MORSE_OPENCODE_BIN` | `/opt/engines/opencode/opencode` | OpenCode binary (pinned `OPENCODE_VERSION`, checksum-verified tarball). |
| `MORSE_HOST/PORT` | `0.0.0.0/4399` | Bind. Published loopback-only in the quadlet. |
| `MORSE_ENGINE` | *(unset)* | New-session default when several engines resolve. |

## Layout inside

- `/opt/morse/server.mjs` + `/opt/morse/ui` — the bundle and the frontend.
- `/opt/engines/{bin,opencode}` — pi + OpenCode, never on PATH by default.
- `/opt/containers/{data,config,logs,run,backup}` — `MORSE_HOME` and logs.
- `/workspaces/<username>` — one tree per login user.
- ezx stays PID 1 and supervises `opencode` (sidecar, port 4096) then `morse`
  (gated on the sidecar's readiness probe); both run as `morse:morse`.
