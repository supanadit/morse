# Bot access to user-owned space

Date: 2026-11-15 · Status: proposed

## Intent

A bot should be able to do real work as its reader: inspect rootless Podman containers,
read `~/.ssh`, and use any tool whose state lives under the reader's home. Isolation should
mean **the bot's own state is its own** — its OpenCode config, auth, sessions and workspace —
not that the bot is cut off from the machine it runs on.

Today a Podman Manager bot reports "no shell/execute tool" and cannot see the reader's
rootless containers. The task that prompted this:
`Enable bot access to user-owned space.` (toso `01a1dd1a-c75b-7d27-a528-760a521e29bb`).

## What is actually wrong (observed)

1. **The shell tool is denied by name.** OpenCode 2 renamed the permission action `bash`
   to `shell`. `packages/integration-opencode/src/bot-layout.ts` still emits
   `{ action: 'bash' }`, so the generated blanket deny leaves the shell tool unavailable.
   The bot's session only exposes read/edit/glob/grep/webfetch/websearch.
2. **External paths are denied.** The generated ruleset starts with
   `{ action: '*', resource: '*', effect: 'deny' }`. That wildcard also covers
   `external_directory`, the permission OpenCode uses for any file tool touching a path
   outside the workspace. With `read: *` allowed but `external_directory` denied, a bot
   cannot read `~/.ssh` or any other absolute path outside its workspace.
3. **The shell inherits the bot's XDG roots.** `botOpenCodeEnv` redirects
   `XDG_CONFIG_HOME` and `XDG_DATA_HOME` to the bot tree so OpenCode's own config, auth
   and logs stay isolated. Shell children inherit the same values, so `podman` looks in
   `<bot>/sessions/containers/storage` (empty) instead of `~/.local/share/containers`.
   Verified locally: with those two variables, `podman ps -a` lists nothing; without them,
   it lists the reader's containers. `HOME`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`
   are already inherited, so SSH keys and the rootless socket are not the problem.

The bot is not containerised. It is a process of the Morse host, running as the reader.

## Goals

- A bot with the shell tool can run `podman ps -a`, `systemctl --user`, and any other
  user-scoped command and see the reader's real state.
- File tools (`read`, `edit`, `glob`, `grep`) can reach paths outside the bot workspace,
  including `~`.
- OpenCode's own config, auth, database, logs and sessions remain under the bot's root;
  one bot never reads or writes another's engine state, or the reader's `~/.config/opencode`.
- Existing bots pick the fix up on the next host start, without editing each bot.

## Non-goals

- OS-level sandboxing (bubblewrap, Podman, a separate user) or per-path allow-lists. A bot
  with the shell tool can already run any command as the reader; path rules alone would
  not constrain it.
- Changing the bot's cwd: its workspace stays `<bot>/workspace`, so relative paths still
  mean the bot's own files.
- MCP servers inheriting the restored XDG roots. They keep the bot environment; only the
  shell hook restores the user values.
- Changing the pi engine. It already inherits the reader's environment and only overrides
  `PI_CODING_AGENT_DIR`.
- Windows or macOS behaviour beyond what the existing code already supports.

## Anti-goals

- Giving a bot the reader's OpenCode auth, sessions or global config.
- Silently widening access for a bot whose permissions the reader hand-edited. Repair only
  touches the ruleset in Morse's own generated shape.

## Approaches considered

1. **Default-on access, engine state isolated, shell env restored by a small plugin.**
   Translate the tool names to OpenCode 2 actions, allow `external_directory` when file
   tools are enabled, and install a plugin that restores the reader's real
   `XDG_CONFIG_HOME`/`XDG_DATA_HOME` only for shell commands. OpenCode's own XDG redirects
   stay. Chosen.
2. **Per-bot toggle, default off.** Same mechanics plus a wizard field and a stored flag.
   Safer, but the existing broken bot stays broken until the reader finds and flips it, and
   a shell-enabled bot is unrestricted anyway. Rejected after the reader chose default-on.
3. **Per-bot path allow-list.** Restricts file tools only; shell remains unrestricted, so
   it adds UI and a false sense of confinement. Rejected.
4. **Stop redirecting XDG entirely and isolate with `OPENCODE_CONFIG_DIR` + `OPENCODE_DB`.**
   There is no data-directory override for OpenCode's auth store, so the bot would import
   the reader's `auth.json` on first boot. Rejected.

For the env restoration itself, two implementations were considered:

- **Plugin using `ctx.shell.hook('create.before')`.** Documented OpenCode 2 extension point;
  changes only environment, not the shell the reader configured. Chosen.
- **A wrapper script used as OpenCode's `shell`.** Simpler, but replaces the reader's shell
  choice and is not the intended extension point.

## Decisions

### Permissions (OpenCode 2 names)

- Map engine tool names to V2 permission actions in one place:
  `bash → shell`, `task → subagent`, `write/patch → edit`; `list` has no V2 tool and is
  dropped.
- Keep the blanket deny, then one allow per selected tool. When any of `read`, `edit`,
  `glob`, `grep` is allowed, append
  `{ action: 'external_directory', resource: '*', effect: 'allow' }`.
- Update the bot wizard's OpenCode tool list and defaults to `read`, `edit`, `glob`,
  `grep`, `shell`, `subagent`, `webfetch`, `websearch`, `todowrite`. pi's list is unchanged.
- Read-back normalises legacy action names and excludes `external_directory` so Edit bot
  shows tools, not internal rules.

### Shell environment

- `botOpenCodeEnv` keeps pointing `XDG_CONFIG_HOME`/`XDG_DATA_HOME` at the bot, and also
  passes the host's real values as `MORSE_HOST_XDG_CONFIG_HOME` and
  `MORSE_HOST_XDG_DATA_HOME` (defaulting to `$HOME/.config` and `$HOME/.local/share`).
- Morse writes `<bot>/config/opencode/plugins/morse-user-space.ts`, a V2 plugin whose
  `shell.create.before` hook copies those two values into `event.env` for every shell
  command. Nothing else changes: `HOME`, `PATH`, `XDG_RUNTIME_DIR` and D-Bus are already
  inherited.
- The plugin file is Morse-owned and rewritten on create, edit and repair.

### Existing bots

- Extend the OpenCode layout's `repair` (already run by `reconcileBotData` on every start)
  to translate action names and add the `external_directory` allow **only when the ruleset
  starts with Morse's blanket-deny rule**. A hand-authored ruleset is left alone.
- Install/refresh the plugin file in the same pass. Repair remains idempotent and keeps
  every key Morse does not own.
- Restructure `repair` so the legacy persona / legacy `agent` migrations no longer return
  early and skip the new steps.

## Acceptance

- A new or repaired OpenCode bot's `opencode.json` contains `shell` and
  `external_directory` allows, and no `bash`/`list` allows.
- In that bot, `podman ps -a` lists the reader's containers; `podman info` reports
  `~/.local/share/containers/storage`; `cat ~/.ssh/known_hosts` works.
- The bot's own server still reads/writes only `<bot>/config` and `<bot>/sessions`.
- A bot whose permissions were hand-edited is not rewritten.
- `npm run test:fast` passes.

## What is left to the builder

- Choose the module split for the plugin/env helpers (`integration-opencode` owns both).
- Decide whether the plugin load failure should be surfaced; this design does not add a
  health check beyond OpenCode's own log.
- Add the docs: `ARCHITECTURE.md` (what a bot can reach), `CONFIGURATION.md` (the bot
  access subsection next to the MCP one), `STATUS.md` (bot mode bullet).
- Add tests: permission mapping and ruleset migration, plugin file contents, env
  computation, wizard tool list, and the existing bot-layout/bot-engine specs.

## Risks

- **Shell is full user access.** This is the requested behaviour; docs must say so plainly
  next to the tool checklist, and the wizard should not imply that file tools are confined.
- **Plugin API dependency.** If OpenCode fails to load the plugin, bots still work but see
  the bot XDG roots again (empty Podman). The failure is visible in the bot's OpenCode log.
- **MCP servers** keep the isolated XDG roots; a reader whose MCP server depends on user
  XDG config would need a separate change.
