# Morse container (enterprise, server mode only)

`ghcr.io/supanadit/morse/server`, built from [`Dockerfile`](./Dockerfile), or
`localhost/morse:local` when built by hand. This is the multi-user deployment:
login-gated, Postgres-backed, one workspace per user. Host-native installs stay
single-user; this image is the enterprise path.

Every `vX.Y.Z` tag publishes `<version>` and `latest` to GHCR via
[`release-container.yml`](../../../.github/workflows/release-container.yml). Pin
`<version>` for production; `latest` tracks the newest release.

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
  `MORSE_PG_HOST=postgresql` resolves. Loopback-only `:4399` and `:2222` (SSH).
- `morse-data.volume` — `<MORSE_HOME>` (sessions spillover, workbench, logs, SSH host key).
- `morse-workspaces.volume` — one directory per login user, also their SSH homes (`/home` is a symlink to it).

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
| `MORSE_OS_USERS` | `1` | Real Linux user per login (`/home/<username>`, SSH below). Off on host installs. |
| `MORSE_SSH_PORT` | `2222` | Direct SSH into your own workspace (loopback-only in the quadlet). |
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
- `/workspaces/<username>` — one tree per login user, and also their SSH home (`/home` is a symlink to `/workspaces`, so two volumes cover everything: workspaces + `MORSE_HOME`).
- ezx stays PID 1 and supervises `opencode` (sidecar, port 4096), `morse`
  (gated on the sidecar's readiness probe), then `sshd` (gated on the server,
  which generates its host key on boot); server and engines run as
  `morse:morse`, sshd as root the way sshd must.

## SSH (one Linux user per login)

Every Morse login is also a Linux user homed at `/home/<username>` with the
same password — set it in Morse (first-run wizard, admin panel, or profile)
and `ssh <username>@<host> -p 2222` lands in your workspace. Admins get one
too; only their Morse fence is wider, not their home. The login shell is zsh
for everyone: `~/.zshrc` is seeded once from the image and then yours alone.

- Provisioned on first login (and repaired on every login for pre-existing
  accounts); the SSH password follows each Morse password set. Accounts that
  predate this feature SSH-fail until their next password change.
- Homes are `<user>:<user>` mode `2750` with an ACL for exactly uid `morse`:
  the server keeps working inside, other logins see nothing — no sudo for
  anyone (only `morse` holds three sudo entries), and `/workspaces` itself is
  `0711` so one user cannot even list another's directory name. Deleting the
  Morse user drops the login but keeps the home (their data).
- The bottom-panel shell runs as the member's own uid (`sudo -u`, allowed for
  exactly `/bin/zsh` as members of `workspace-users`, never root, never
  `morse`), so the kernel fences what the spawn policy cannot: `cd
  /home/someone-else` is denied even though the pty started fenced. Admins
  keep the service account and roam (below); engine login TUIs do too, since
  they write host-wide config. `morse` and `root` cannot sign up, so no login
  ever lands on a privileged uid.
- Admins roam: every admin holds `rwx` on every home and `rx` on `/workspaces`
  itself, so an admin's SSH session goes anywhere (list, enter, edit) while
  regulars stay fenced. The roam follows the Morse role — granted on promote
  (and on every admin sign-in, for pre-existing trees), revoked on demote or
  delete — and only ever touches the filesystem, never sudo.
- Ports to publish: `:4399` (app) + `:2222` (SSH), both loopback-only in the
  quadlet.
- Surviving a recreate: `/etc` is container-local, so the login database
  (`passwd`, `shadow`, `group`, `gshadow`) is snapshotted to
  `<MORSE_HOME>/os-users` after every user change, and the boot entrypoint
  replays it before sshd starts — same names, same uids, same password
  hashes, so passwords and key files keep working and file ownership never
  scrambles. Homes are repaired on every web login anyway (`<user>:<user>`,
  plus `~/.ssh` handed over with an ACL keeping the server inside).
- Pubkey notes: `StrictModes` is off for this sshd, because homes are
  deliberately group-writable (`2750` + default ACL) and key files are written
  by uid `morse` — stock strict mode would refuse every key and silently fall
  back to password. The fence itself (private group per user, `0711` root, no
  cross-home writes) is the protection strict mode stands in for.

## Toolchain (user space, no sudo needed)

The image ships `git`, a C/C++ toolchain and the pyenv build prerequisites
(`libssl-dev`, `zlib1g-dev`, `libbz2-dev`, `libreadline-dev`, `libsqlite3-dev`,
`libncursesw5-dev`, `tk-dev`, `libffi-dev`, `liblzma-dev`, `libxml2-dev`,
`libxmlsec1-dev`). Version managers stay per-user installs — nvm and pyenv
are intentionally not bundled — but every member can install their own
without ever asking an admin, following the upstream guides
([pyenv wiki](https://github.com/pyenv/pyenv/wiki)). Nothing a member builds
touches another tree: it all lands under their own (fenced) home.

## Extending the image (add your own tools)

The final image is an ordinary base image: you can add tools with a child
`Dockerfile` that starts `FROM` it. Docker reuses the parent's layers from cache
or the registry, so only your added layers build — the parent image and this
repo never need rebuilding, and the published tag keeps working for everyone
else. The supervisor entrypoint is inherited untouched; adding `RUN`/`COPY`
layers does not replace it.

Two facts make this work without any changes to the parent:

- **No `USER` is set.** PID 1 (`ezx`) starts as root and drops to `morse` for
  each supervised process at run time. A child `RUN` is therefore root and can
  `apt-get`/install binaries; do not add a `USER` back.
- **`/usr/local/bin` is on `PATH`** for both the container processes (image
  `ENV PATH`) and SSH login users (`/etc/profile`), so CLI tools dropped there
  work in agent sessions *and* when a member logs in by SSH.

Example — add `kubectl` and `kustomize` to a pinned parent tag:

```dockerfile
# Dockerfile.morse-tools
FROM ghcr.io/supanadit/morse/server:X.Y.Z   # or localhost/morse:local

ARG TARGETARCH
ARG KUBECTL_VERSION=v1.32.0
ARG KUSTOMIZE_VERSION=v5.5.0

RUN set -eu; \
    case "${TARGETARCH}" in amd64) karch=amd64 ;; arm64) karch=arm64 ;; *) exit 1 ;; esac; \
    curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${karch}/kubectl" && \
    chmod +x /usr/local/bin/kubectl && \
    curl -fsSLo /tmp/kustomize.tar.gz \
      "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2F${KUSTOMIZE_VERSION}/kustomize_${KUSTOMIZE_VERSION}_linux_${karch}.tar.gz" && \
    tar -xzf /tmp/kustomize.tar.gz -C /usr/local/bin kustomize && \
    rm /tmp/kustomize.tar.gz
```

Build it and point the quadlet at the new tag:

```bash
podman build -f Dockerfile.morse-tools -t localhost/morse:tools .   # no source context needed
# then in ~/.config/containers/systemd/morse.container: Image=localhost/morse:tools
```

Notes:

- Pin versions (and verify checksums, as the parent does) — unpinned `latest`
  downloads make the child layer non-reproducible.
- Tools installed this way are **global**: root-installed and available to
  every login. Per-user config and credentials belong in each
  `/workspaces/<username>` home. Set global env with `ENV`/the quadlet, not by
  editing the seeded `.zshrc` (it is seeded once, then user-owned).
- Upgrading Morse means rebuilding the child against the new parent tag — just
  these few added layers, never a rebuild of Morse itself.
- This covers CLI tools. Adding a *supervised service/sidecar* is a different
  thing: the node graph lives in `entrypoint.d/bootstrap/main.js` and does need
  a parent-image change.
