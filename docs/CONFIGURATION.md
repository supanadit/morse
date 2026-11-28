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
| `morse.engine` | Engine new sessions start in: `pi` (default) or `opencode`. An engine that cannot be reached falls back to pi |
| `morse.opencode.path` | Path to the `opencode` executable. Empty = `opencode` from `PATH` |
| `morse.opencode.url` | Attach to a running OpenCode server instead of spawning one |
| `morse.opencode.password` | The password that server printed on startup (prefer `MORSE_OPENCODE_PASSWORD` in the environment) |
| `morse.sessions.hotLimit` | How many sessions stay warm (LRU, default 4) |
| `morse.sessions.perProject` | Sessions of one project listed before a "Load more" row (default 10) |

## Browser host environment

The NestJS host and the `morse` CLI are configured through the environment:

| Variable | Default | Meaning |
|---|---|---|
| `MORSE_HOST` | `127.0.0.1` | Bind address |
| `MORSE_PORT` | `4399` | Port (the CLI picks the next free one if this is taken and unset) |
| `MORSE_HOME` | `~/.morse` | Data directory: CLI state, pidfile, logs, Morse's session index (`sessions/`), the saved shell layout (`workbench.json`), the per-tab composer drafts (`drafts.json`) and the terminal scrollback (`terminals/`) |
| `MORSE_WORKSPACE` | current directory | Directory the agent works in |
| `MORSE_PROJECTS` | unset | Roots the agent may open, e.g. `/a:/b` |
| `MORSE_AUTH_PASSWORD` | unset | When set, every browser-facing data route needs this password: the bundle loads openly and the shared login page gates it (username field only when `MORSE_AUTH_USERNAME` is set), a successful login mints an HttpOnly cookie, and plain HTTP Basic keeps working beside it for scripts and `curl -u`. The CLI health probe and the bot bus stay open — the latter has its own loopback + token check |
| `MORSE_AUTH_USERNAME` | unset | Optional user name required alongside `MORSE_AUTH_PASSWORD`; unset means any user name is accepted and the password alone gates |
| `MORSE_AUTH_SECRET` | unset | Optional pepper for the single-user login cookie. Set it to a random string (`openssl rand -hex 32`); changing it — or the password — and restarting the host invalidates every issued cookie, so every browser logs in again. Alone it does nothing: with no `MORSE_AUTH_PASSWORD` there is no gate |
| `MORSE_OIDC_ENABLED` | disabled | Turns on the optional generic OIDC/OAuth2 door (`1`/`true`/`on`/`yes`). Any `MORSE_OIDC_*` knob makes the provider env-managed: the admin settings page stays visible but read-only. With none set, an admin configures the same provider on the settings page instead |
| `MORSE_OIDC_DISPLAY_NAME` | `Single sign-on` | Label of the login page's SSO button |
| `MORSE_OIDC_DISCOVERY_URL` | unset | The `.well-known/openid-configuration` URL (Keycloak realm URL + `/.well-known/openid-configuration`). Fills auth/token/userinfo endpoints when they are not set explicitly |
| `MORSE_OIDC_AUTH_URL` / `MORSE_OIDC_TOKEN_URL` / `MORSE_OIDC_USERINFO_URL` | unset | Explicit endpoints, for providers without discovery. All three (or discovery) plus the client id are required |
| `MORSE_OIDC_END_SESSION_URL` | from discovery when present | Where logout bounces to end the provider session (so the next login can pick a different user). Without one, logout ends the Morse session locally only |
| `MORSE_OIDC_CLIENT_ID` / `MORSE_OIDC_CLIENT_SECRET` | unset | The provider's client credentials for Morse |
| `MORSE_OIDC_SCOPES` | `openid profile email` | Scopes requested at login |
| `MORSE_OIDC_ALLOW_SIGNUP` | enabled | First SSO login creates the account (`0`/`false`/`off` restricts SSO to existing members). Linked by provider subject first, email otherwise — enabling SSO never strands a local account. SSO-created members hold a random password until they set one on Settings → Access → Password, which is also what unlocks SSH. |
| `MORSE_OIDC_ALLOW_PASSWORD` | enabled | Show the username/password form beside SSO. Off means SSO only — the server refuses password login and setup too, so the local form never appears. With sign-up also off and no users yet, the host refuses the combination rather than bricking itself |
| `MORSE_ENGINE` | `pi` | Engine new sessions start in: `pi` or `opencode` (an unreachable engine falls back to pi) |
| `MORSE_OPENCODE_URL` | unset | Attach to a running OpenCode server instead of spawning one |
| `MORSE_OPENCODE_PASSWORD` | unset | The password that server printed; required with a URL |
| `MORSE_OPENCODE_BIN` | unset | Path to the `opencode` binary (otherwise `opencode` from `PATH`) |
| `MORSE_HOT_SESSIONS` | `4` | How many sessions stay alive at once |
| `MORSE_SESSIONS_PER_PROJECT` | `10` | Sessions of one project listed before a "Load more" row |
| `MORSE_PI_PATH` / `MORSE_PI_ENTRY` | unset | Path to the `pi` binary, or a pi RPC entry run with node |
| `MORSE_SESSION_DIR` / `MORSE_NO_SESSION` | unset | pi session persistence |
| `MORSE_REQUEST_TIMEOUT_MS` | `30000` | Per-request RPC timeout |
| `MORSE_UI_DIR` | bundled frontend | Override the served frontend directory |
| `MORSE_UPLOAD_DIR` | `.morse/uploads` | Where browser uploads land (relative to a session cwd, or absolute) |
| `MORSE_UPDATE_CHECK` | enabled | Whether the panel may read the published Morse and pi versions from the npm registry (`0`/`false`/`off` disables both) |
| `MORSE_SELF_UPDATE` | disabled | Whether the browser footer's update notice may install the latest release and restart the host (`1`/`true`/`on`/`yes` enables). Off by default; see below |
| `MORSE_TERMINAL_IDLE_MS` | `1800000` | How long a terminal's shell keeps running with no page attached before the host reclaims it (`0` disables the timeout) |

`MORSE_PROJECTS` is the security boundary: when set, the agent may only work inside those roots. When unset,
any absolute path is accepted — fine for a host bound to `127.0.0.1`, not for one you expose.

### OpenCode

OpenCode is optional: Morse registers its engine only when the binary is on `PATH` or a server is configured.

- **Attach** — set `MORSE_OPENCODE_URL` (`morse.opencode.url`) and `MORSE_OPENCODE_PASSWORD`
  (`morse.opencode.password`) to a running `opencode serve`. Morse authenticates with Basic auth, verifies the
  server answers, and **never stops** that process. The password is the one the server prints on startup; a URL
  without a password is reported as a configuration error.
- **Own a private server** — with no URL, Morse runs `opencode serve --hostname 127.0.0.1 --port 0`, reads the
  address and password the process announces, and stops it when the host shuts down. Point
  `MORSE_OPENCODE_BIN` / `morse.opencode.path` at a binary outside `PATH` if needed.
- **On Windows** the `opencode` on `PATH` is normally an npm shim (`opencode.cmd`), which Node cannot start
  without `cmd.exe`. Morse reads the shim and starts the program inside it (the executable or script the shim
  names) directly, so detection and spawn agree and no console window is involved; a shim it cannot read is
  run through `cmd.exe`, and a `.ps1` install through `powershell`. Extensions are probed in `PATHEXT` order.
- **Which engine a new session uses** is `MORSE_ENGINE` / `morse.engine`. Morse only registers the engines it can
  actually run — pi when its binary resolves, OpenCode when a server is configured or its binary is on `PATH` — so
  a machine with a single engine reports that one alone, offers no picker at all, and starts every new session
  in it. When more than one engine is installed, the empty composer also offers an engine picker; choosing one
  re-reads that engine's catalogs and the first prompt creates the session there. The choice is remembered for
  later new sessions in the same host, while the configured default still decides where a fresh host starts.
  Existing sessions always reopen through the engine recorded for them, whatever the default or draft choice
  is. A machine where neither engine resolves registers none: the panel shows a full-screen setup card
  offering both installs (`engineSetup` on the wire), each with its install command and this host's own
  setting — pi's `MORSE_PI_PATH` / `morse.pi.path`, OpenCode's `MORSE_OPENCODE_URL` / `morse.opencode.url`.
- **Modes** are OpenCode's primary agents. `plan`, `build` and any primary agent you define are offered; hidden
  and subagent-only agents are not. The current mode can be changed while a conversation runs (OpenCode's Tab
  behaviour), and the mode picker re-reads the catalog when it opens.
- **Default mode** — OpenCode resolves it from your configuration. Set `default_agent` in `opencode.json[c]` (or a
  project `.opencode/opencode.json[c]`):

  ```json
  { "default_agent": "plan" }
  ```

  Morse reads the configuration documents from lowest to highest priority, so the last `default_agent` wins,
  exactly as OpenCode does: every `.opencode/opencode.json[c]` outranks every direct `opencode.json[c]`, a nearer
  directory outranks a further one, and the app-level `~/.config/opencode/opencode.json[c]` is lowest. When none
  is set, it uses the first primary agent OpenCode reports, which is where the server places its resolved
  default. Morse never hardcodes `build` or `plan`. A session created without an explicit mode omits the agent
  field, so OpenCode applies the same default at prompt time.
- **The model a draft and a new session name** — the model the *effective agent* is configured to run, not
  `/api/model/default` first. That is the draft's picked mode (`build`, `plan`, any custom primary agent), else
  the agent `default_agent` resolves to. Morse reads it from `/api/agent`, which carries the model the server
  already resolved from the global and project files, so a `model` written in either file arrives merged and
  Morse parses no precedence of its own. Switching the mode in a draft follows that agent's model, unless a model
  was picked by hand — that always wins — and a resumed session keeps the model it recorded. The model is
  validated against `/api/model`: an agent model the catalog does not list falls back to `/api/model/default`,
  and, with no explicit pick, the panel keeps `no model` only when neither resolves.
- **A config edit reaches the next new session** — OpenCode re-reads an edited `opencode.json[c]` on its own, so
  Morse does not wait to find out when: it fingerprints the app-level and project candidates — a missing file is
  part of the fingerprint, so creating the first one counts — and the empty panel's probe asks the server to
  reload (`POST /api/location/reload`) before it reads the catalogs. That happens only while no session of that
  engine is streaming, and only for a server Morse started itself; an attached `opencode serve` is left to
  OpenCode's own watcher. Only the explicit ⟳ request below posts to an attached server. A change skipped because
  a session was running keeps the old fingerprint, so the next idle probe reloads then. A warm session's next
  turn is served by the reloaded config.
- **Reloading now** — the composer's ⟳ control (**Reload agent configuration**, beside the thinking picker)
  asks the server to reload immediately, for every loaded location, and every warm session re-reads its model,
  mode, command and skill catalogs. It works for an attached server too, because this is the explicit request.
  When sessions are running it warns first, with the count, and says that pending permission and form prompts are
  cancelled; running turns continue at their next step. **Reload anyway** sends the forced reload. pi offers no
  such control: it has no engine-level config to reload, and its own pickers and draft probe already re-read what
  pi owns on demand.
- **Adding or changing modes** — define a primary agent in `opencode.json[c]` under `agents`, or add a Markdown file
  under `.opencode/agent/` (or `~/.config/opencode/agent/`). Opening the mode picker (or starting a new session)
  re-reads `/api/agent` and `/api/config`, so a new, renamed, disabled or removed agent appears without
  restarting Morse; the markdown files are read live by OpenCode, while an `opencode.json[c]` edit takes the
  fingerprint path above.
- **Commands** — OpenCode's own commands (markdown files under `~/.config/opencode/commands` and the project's
  `.opencode/commands`, plus `command` entries in `opencode.json[c]`) appear in the composer palette. Morse reads
  the same files and config the server loads, so a template that declares arguments — `$1`, `$ARGUMENTS`, or an
  `argument-hint` — opens the argument form, exactly as pi's templates do. Templates without declared arguments
  run as a bare `/name`, and OpenCode expands them itself (including its shell-injection and `@file` features,
  which Morse does not substitute). Commands Morse cannot find a file for — plugin-provided ones, nested
  `a/b` names — run the same way.
- **In the browser host**, OpenCode's MCP servers and prompt templates are managed by the same panels as pi's:
  the MCP manager reads the `mcp` key of `opencode.json[c]` and reports configured state — OpenCode connects a
  server when a session starts — and the prompt editor lists its command files and the config's `command`
  entries. The VS Code window wires one fixed MCP/prompt administration from its default engine instead: with
  pi as the default those panels edit pi's files even from an OpenCode session, and with OpenCode as the
  default its MCP manager is not offered at all (VS Code gates MCP on an engine CLI, which OpenCode has none
  of) — its prompt editor does work there. OpenCode's version notice is absent in both hosts: it reports no
  installed version to Morse, so the "newer release" row never appears for it. A compaction asked for with
  custom instructions runs without OpenCode-specific extras and says so.

Morse's session index lives under `<MORSE_HOME>/sessions/`, and both hosts use that one directory: a
rename in the browser shows up in VS Code (and the other way round) on the next list refresh, and a
title the reader set (`titlePinned`) survives everywhere. It is what the sidebar lists; each engine's
own storage still holds the conversations. An older extension build that kept its index under VS Code's
global storage has its records merged into the shared directory once, without overwriting anything.

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

## MCP servers

Morse reads MCP servers from each engine's own file and writes them back there — no `pi` or `opencode` CLI
runs for this.

| Engine | User file | Project file |
|---|---|---|
| pi | `<PI_CODING_AGENT_DIR>/mcp.json` (`~/.pi/agent/mcp.json` by default) | `<project>/.pi/mcp.json` |
| OpenCode | `<xdg config>/opencode/opencode.json`, or `opencode.jsonc` beside it (the `jsonc` wins) | `<project>/.opencode/opencode.json[c]`, then `<project>/opencode.json[c]`, and the same pair in every ancestor |

Every `.opencode` config outranks every direct one, and a nearer directory outranks a further one — OpenCode's
own precedence. An OpenCode save lands in the first existing file of that order — in the project, or the user's
file when there is no project — and a project with no config of its own gets a new `<project>/opencode.json`
(a user tree with none gets `<config>/opencode.json`). A pi project file is read only while pi would load it, so
the panel shows pi's **Trust this project** until it is.

Both MCP managers read **JSON or JSONC**: comments and trailing commas in a user's file are read, not
rejected. They share one foundation (`@morse/engine-config`), so the read, preserve and Fix rules below hold
for either engine; what differs is each engine's own file spelling.
A project entry shadows the user-level server of the same name. pi's project entry with none of `command`,
`url` or `type` is an *override* that only pins `enabled`/`exposure` for that directory (the same thing pi's
own `/mcp` writes); OpenCode's entry replaces a same-named one outright.

What the panel lists comes from the configured files, plus a probe where the engine has live state:

- **pi** lists what the files declare and, in the background, connects each enabled, trusted server to report
  its state and tools. Servers registered by a pi extension have no file entry, so they are **not** listed;
  the panel says the list is configured files only. Project entries and overrides are ignored until the
  project is trusted.
- **OpenCode** reports configured state only: a server connects when a session starts, so the panel never
  claims a live connection.

A malformed file or entry is shown as an issue beside the list — the file, a JSON pointer, and a bounded
snippet of what the engine read. An entry that is `null`, is not an object, or names a transport without its
`command` (stdio) or `url` (http) is skipped while its siblings still list. An edit keeps every key Morse
does not manage, and the `mcpServers`/`mcp` block is deleted once its last entry is removed.

**Fix** rewrites one of those files as strict JSON at the same path, dropping comments and trailing commas, so
the next edit can land. It only touches a path the selected engine resolved for that file id and scope — the
write target or a read fallback, including a `.jsonc` or ancestor file — never an arbitrary path. The browser
host offers it beside a fixable issue; VS Code does not implement the fix request, so a file it cannot write has
to be repaired by hand there. A file with a real syntax error is reported as needing a hand edit in either host,
because Fix does not guess at missing braces or unquoted keys. Morse never silently strips a user's comments:
a write to a JSONC user file is refused until Fix is used.

## Bots

A bot keeps its MCP servers in its **own** tree — never in your global `~/.pi/agent` or
`~/.config/opencode` — because its engine runs with that tree as its config directory:

- **pi** — `PI_CODING_AGENT_DIR` is `<bot>/config`, so the servers are the `mcpServers` entries of
  `<MORSE_HOME>/bot/<agent-name>/config/mcp.json`, in pi's own shape: `type` (`stdio` or `http`),
  `command`/`args`/`env`/`cwd` or `url`/`headers`, `enabled`, and pi's `exposure`.
- **OpenCode** — the bot's own server loads `<bot>/config/opencode/opencode.json` — or an
  `opencode.jsonc` beside it, which the isolated engine reads and writes instead (its
  `XDG_CONFIG_HOME` is `<bot>/config`) — and the servers are that file's `mcp` key as OpenCode writes
  it: `local` with a `command` array plus `environment`/`cwd`, or `remote` with `url` and `headers`;
  `enabled: false` switches one off.

The bot wizard writes them for you: the optional **MCP** step sits between **Persona** and
**Advanced**, and the list it shows is what the next edit reads back out of the engine's file. Morse
writes the files directly — no `pi` or `opencode` CLI runs for this — and a bot inherits no MCP
servers from your own configuration.

A bot's tree is Morse's own, so its files are private: directories `0700` and files `0600`. It is also
the one place a JSONC file is normalized without asking: the bot's file is generated, so a JSONC
`mcp.json` (or `opencode.json[c]`) is read and then rewritten as strict JSON by the same save, where a
user's file waits for Fix.

pi's `settings.json` in a bot's agent dir carries
`"$schema": "https://pi.dev/schemas/settings.schema.json"` as its first key. Morse writes that
reference — `repair` seeds it into a bot's existing `settings.json` — but never validates the file
against it: the schema is for the editor, which uses it to validate and complete the file. OpenCode's
config names its own (`https://opencode.ai/config.json`).

Entries are read leniently and written authoritatively. An entry that is null, is not an object, or
names a transport without its `command` (stdio) or `url` (http) is skipped when the wizard reads the
file, and the rest still show. A server the wizard shows is rewritten on save. An entry it no longer
shows is removed on the next save — a malformed stdio/http entry and a `null` or non-object entry
included — except a pi entry with none of `command`, `url` or `type`, which is a project *override*
that only switches a user-level server's `enabled`/`exposure` and is kept. OpenCode's whole `mcp`
block is replaced by the list on screen. Unknown keys inside a managed server survive an edit too —
`auth`, for instance, stays. A name that is not letters, digits, `_` and `-`, or that is one of
`__proto__`, `prototype` and `constructor`, is refused before anything is written.

A pi `mcp.json` that cannot be parsed is ignored on read: the bot's other settings still appear and
the MCP step shows no servers, but adding a server to that file makes the save fail, because the
writer has to rewrite a file it cannot parse — repair it by hand first. `opencode.json[c]` is
stricter still, since MCP lives inside it: a file that cannot be parsed can be neither read nor
written, so Edit bot shows nothing at all — persona, model, tools, subagents and MCP alike — and a
save fails until it is fixed by hand. A file that parses but whose `mcp` block is not an object lists
no servers, and the next save replaces that block with the list on screen.

### What a bot can reach

A bot is not a container. It is a process of the Morse host, running as you, from `<bot>/workspace` — so
its file tools reach your home directory and its shell tool can run any command you can. A new OpenCode
bot starts with `read`, `edit`, `glob`, `grep` and `shell`, and OpenCode's `external_directory`
permission is allowed whenever a file tool is, which is what makes `~/.ssh` or an absolute path outside
the workspace readable. There is no OS-level sandbox and no per-path allow-list behind this: a bot that
may run a shell is your own login, and path rules alone would not confine it.

The ruleset is generated from the checklist every time the wizard saves: a blanket deny, then one allow
per chosen tool, so a resource-scoped rule hand-added to `opencode.json` is flattened by that save. Morse's
own bus tools (`bot_list`, `bot_send`, `human_list`, `human_send`) are allowed in every generated ruleset
regardless of the checklist: under the blanket deny alone they were hidden from the model, which then went
looking for another way to reach a teammate.

What Morse keeps out of your own tree is the engine's config and data roots: OpenCode's config
(`<bot>/config`), and its auth, database, sessions and logs (`<bot>/sessions`). Morse points both roots
into the bot; it does not scrub an `OPENCODE_*` path override inherited from the host. Each bot's engine
state and workspace land in its own directory, which is placement, not a boundary — with
`external_directory` and a shell, a bot can read a sibling's files.

For OpenCode that redirection is all the isolation there is: the server runs with `XDG_CONFIG_HOME` and
`XDG_DATA_HOME` pointed into the bot, and your real values travel beside them as
`MORSE_HOST_XDG_CONFIG_HOME` and `MORSE_HOST_XDG_DATA_HOME`. Morse writes
`<bot>/config/opencode/plugins/morse-user-space.ts`, whose shell hook puts those values back on the
environment of each command, so rootless Podman, `systemctl --user` and `~/.ssh` work from inside a bot
while its own server keeps the bot's roots. Only the shell is restored: if OpenCode cannot load the
plugin, commands keep the bot's roots (your Podman state looks empty) and the failure appears in the
bot's OpenCode log at `<bot>/sessions/opencode/log/`. A pi bot needs no such plugin: `PI_CODING_AGENT_DIR`
is the only variable pointed at its tree, so its commands already see your environment. MCP servers keep
the bot environment in every case.

Bot settings → Environment also takes `KEY=value` lines under **Bot-only values**. Those values live in
that bot's `engine.json`, are merged over the host's environment when its engine starts (and when the
wizard probes its catalog), and override a host variable of the same name. Only that bot receives them;
they are still plaintext on disk in its private directory and come back to the browser when you edit the
bot, so treat them like the API keys you paste into a provider.

Bots created before this update are repaired on the next host start: they gain the shell plugin, the bus
tools in their ruleset, and, where their generated ruleset still uses the old tool names, the correct
permission actions — so their shell and external-path file access start working without being recreated.

## Interface preferences

Some display choices belong to whoever is reading, not to the host, so they live in the panel
(`localStorage`) and behave the same in both hosts:

| Key | Values | Meaning |
|---|---|---|
| `morse.navigation.collapsed` | `1` / `0` | Wide layouts only: the sidebar column folded away |
| `morse.chat.toolDisplay` | `compact` / `timeline` | `compact` (default): one summary line per turn, a tree of steps with their files; `timeline`: the legacy always-open cards |
| `morse.view.sessionNav.folds` | JSON `{ "<path>": true }` | Projects folded in the session list, by path; a path absent from it is unfolded |
| `morse.view.sessionNav.listFolded` | `true` / `false` | The whole session list folded to its title bar |
| `morse.view.mode.current` | `code` / `bot` | Which tab the window was on |
| `morse.view.mode.botConversation` | a conversation id (`group-…`, `dm-…`) | The bot DM or group that was in front |

The tool-call toggle sits in the chat header, next to the conversation compactor; the compact tree is the
default, and `timeline` is the opt-in legacy view. Storage is a nicety: with `localStorage` unavailable the
choice still holds for the session.

The session list's folds are remembered the same way, and by the host: per project (the header chevron) and
as a whole (the pane's fold), so a reload — or a `morse stop` — comes back the way it was left. Until a
reader has folds on record, one project is unfolded — the one the open session is in, or else the one they
used last — and every other project waits behind its header, so a catalog of hundreds of projects arrives
as a list to scan rather than a wall of sessions. From then on the record is the reader's own: what they
fold stays folded, and what they unfold stays open.

The **tab** is remembered too: a reload comes back on `Code` or `Bot`, whichever the reader left, and bot mode
reopens the DM or group that was in front (`state/mode-prefs.ts`). The conversation is a memory, not a
promise — the roster decides. A conversation deleted while the page was shut is forgotten instead of being
reopened as an empty room.

### Explorer and tabs (browser host)

When the host advertises `filePreview` — the NestJS/browser host does, VS Code does not — the sidebar grows
an **Explorer** for the session's project and the chat grows a **tab strip**. Clicking a file opens it in a
new preview tab; selecting a session opens or reveals its tab and activates that session. The tree loads
one directory at a time as folders open, lists ignored entries as well as tracked ones (an `.env`, a file
under `node_modules`), and remembers the open folders per project, so a browser refresh lands on the same
tree. A **filter box** above the tree narrows the project to the files whose path matches — the tree gives
way to a flat, ranked list with each file's folder beside it — searching what the opened folders have
listed, so finding a file whose folder the reader would otherwise have to open by hand is one box instead
of a walk. The strip is
frontend state, and the browser host persists it (with the bottom panel and its terminals) to
`<MORSE_HOME>/workbench.json`, so opening the page again lands on the tab the reader left; the drafts of
those tabs — text, pins, mentions and inline images — are persisted per tab to
`<MORSE_HOME>/drafts.json`, so a long prompt survives a reload or a `morse stop`. VS Code keeps its own tab
restoration and restores nothing here. The file opens in a read-only editor (syntax
highlighting, folding, find, no language server), so a file over 512 KB is shown truncated and a binary file
is named rather than decoded.
Drag across the editor's line numbers to pin a range (`path:start-end`) to your next message, or select text
and press `⧉ Pin L12-14` in the file's header to pin the exact columns — picking a file in the `@` picker opens it
so the drag is one step away. Either way the pin replaces the paint: the range keeps its tint, and the selection
goes. Ranges that touch or overlap become one chip (and one highlight). A pinned range is tinted
in the code, and pointing at the range raises a corner pair: the chip carries the note's opening words — hover it
to read the whole annotation, click it to write one — and `Cancel` unpins. The pair goes as soon as it is used, so
what stays on the file is the highlight; the header's `N ranges` button walks from one pinned range to the next.
Re-drag or re-select to change the range.
Right-click a tab for Close, Close Others, Close to the Right and Close All — the actions VS Code's own tab
menu offers. The menu's scope is the tab you clicked: on a **session** it spans the whole strip (its quoted
files go with it), but on a **file chip** it only spans that chip's row, so closing a chip can never take the
session tab with it. Files opened from the `@` picker get their own row below the sessions, so quoting a file
never pushes a session tab aside.

## Prompt templates

Each engine's `/commands` are edited by the same **Edit prompt templates** view — from the toolbar's document
button, the command palette, or `Ctrl+Alt+E` (it is a Morse command, not pi's or OpenCode's): the browser host
replaces the tab strip and chat with the full-page **Prompt templates** editor (toggle it from the same button,
the command palette, or `Ctrl+Alt+E` again to go back), and VS Code opens a **Prompt templates** editor panel,
the same way the MCP editor does. It writes the template for you (frontmatter and body) and tests the expansion
before you run it.

- **pi** turns Markdown files under `~/.pi/agent/prompts` (and, once a project is trusted,
  `<project>/.pi/prompts`) into `/commands`. The file name is the command name, and a project file shadows a
  user one.
- **OpenCode** reads `<xdg config>/opencode/commands/*.md` and `<project>/.opencode/commands/*.md` — both lists
  show, because OpenCode merges them — plus the `command` entries of the **user-level** `opencode.json[c]`
  (`{ template, description, agent?, model?, subtask? }`). A `command` row is edited as its structured entry;
  a project `command` block is not read. OpenCode has no trust gate.

Both engines' templates are read and written through the same foundation as their MCP servers, so the
listing, validation and Fix rules are shared; what differs is the engine's own format — pi's frontmatter
fields versus OpenCode's command files and `command` entries.

The editor understands pi's full substitution vocabulary: `$1`, `${1:-fallback}`, `$@` / `$ARGUMENTS`,
`${@:-fallback}`, `${@:2}` and `${@:2:3}`, with shell-like quoting for arguments that contain spaces. The
**Fields** tester derives one input per argument from `argument-hint` (angle brackets required, square brackets
optional) and shows the `${n:-…}` default as its placeholder; the **Raw** tester parses a line the way pi does.
Either way the preview is the exact prompt the agent would receive. For OpenCode the sheet lists the two forms
OpenCode itself expands — `$ARGUMENTS` and `$1`–`$9` — and OpenCode applies its own shell and `@file` features
when it runs the command. A save asks the host to re-read the templates, so a new or renamed one shows up in the
palette without restarting the session.

A template the engine would refuse is listed with its error instead of vanishing — pi's invalid YAML
frontmatter, or an OpenCode command file whose frontmatter is broken — so fix it and save. Writing a project
template works before the project is trusted, but pi ignores `.pi/prompts` until you trust it — the editor says
so, and the MCP panel's **Trust this project** does it. With no session in front there is no project scope, so
the editor offers the user templates only.

A config file the editor cannot write yet — an `opencode.json[c]` still carrying comments — is listed as an
issue beside the templates; **Fix** rewrites it as strict JSON, exactly as it does for MCP. A template file the
host could not read stays listed with its own error instead.
