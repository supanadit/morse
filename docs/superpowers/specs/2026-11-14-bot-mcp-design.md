# Bot MCP servers — design

**Date:** 2026-11-14
**Status:** design for approval
**Owner decisions:** per-bot servers (not imported/borrowed); engine-specific file
formats owned by Morse (approach A).

## Intent

A bot created in Morse cannot use any MCP server today. pi's `bot-layout.ts` says
it plainly: "Morse writes none of them yet, and a bot inherits no MCP servers."
OpenCode's bot config preserves an `mcp` block it never writes. The wizard has
nowhere to add one.

The reader should be able to add, edit and remove MCP servers for a specific bot
while creating it or editing it. Morse writes each server into that bot's own
engine-native configuration — the same file a person would hand-edit — and reads
it back for the next edit. No `pi` or `opencode` binary is involved in either
direction: Morse knows both formats.

## Goals

- The New bot wizard and Edit bot have an **MCP** step that manages the bot's own
  servers: stdio or HTTP, with env, headers, enabled, and pi's exposure.
- Creating or editing a bot writes those servers into the bot's tree:
  - pi: `<botRoot>/config/mcp.json` (`mcpServers`)
  - OpenCode: the `mcp` block of `<botRoot>/config/opencode/opencode.json`
- Edit bot reads the servers back from those files, so the form reflects the file.
- The host validates names and transports at the bot boundary; malformed input
  fails the create/update with a readable message instead of writing a broken bot.
- A **Test connection** button probes the server with Morse's existing MCP client
  before the reader saves it.
- pi bots' `settings.json` carries `"$schema": "https://pi.dev/schemas/settings.schema.json"`,
  the same self-describing header OpenCode's `opencode.json` already gets.

## Non-goals

- Importing or cloning servers from the host's global config or another bot. The
  owner chose per-bot entry only.
- Live connection state in the wizard after save. A bot's engine reads MCP config
  when it starts a session; Test is a one-shot probe.
- Per-tool exposure overrides (`toolExposure`), OAuth flows, and editing a server's
  unknown fields. Unknown fields on an entry survive a merge but are not editable.
- Changes to the global MCP panel/editor (`mcp-panel`, `mcp-editor`, `mcp*` host
  commands). Bot MCP is a separate surface.
- Any dependency on the `pi`/`opencode` CLI. The only spawned process is the MCP
  server itself, during Test.

## Anti-goals

- Do **not** move engine format knowledge into `@morse/system` (a central
  "MCP factory" that branches on engine kind). That duplicates the integrations'
  knowledge and violates the agent-boundary rule.
- Do **not** shell out to `pi mcp add` or an OpenCode command.
- Do **not** silently preserve a server the reader removed in the form, nor drop a
  server the form showed. The form's list is the complete managed set.

## Approaches considered

### A. Extend the bot layout port — **chosen**

`BotEngineConfig`/`BotEngineState` gain `mcpServers` in one neutral shape. Each
integration's `BotEngineLayout.write`/`read` translates it to/from its own file,
reusing the file helpers it already has. The wizard collects the list; the
protocol carries it on create/update.

Why: the layout already *is* the engine-format factory. MCP becomes one more thing
it owns, with zero new architecture, no binaries, and edit starting from what the
file really holds.

### B. Central MCP configuration factory in `@morse/system`

One module branching on engine kind and writing both formats. Rejected: it
duplicates format knowledge, puts engine specifics in the pure domain package, and
creates a second writer for the same files.

### C. Reuse the host's `mcp*` commands with the bot root as `cwd`

Rejected: pi's status path shells out to `pi mcp list`, OpenCode's writer targets
the XDG directory rather than a bot tree, and it couples the wizard to a session.

## Design

### 1. Neutral shape

`packages/system/src/bot/types.ts`:

```ts
export type BotMcpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden';

export interface BotMcpServer {
  /** Config key: letters, digits, `_` and `-`. */
  name: string;
  type: 'stdio' | 'http';
  command?: string;                       // stdio
  args?: string[];                        // stdio
  cwd?: string;
  env?: Record<string, string>;           // stdio
  url?: string;                           // http
  headers?: Record<string, string>;       // http
  /** Absent means enabled, as both file formats do. */
  enabled?: boolean;
  /** pi only; absent means the engine's default. Dropped for OpenCode. */
  exposure?: BotMcpExposure;
}
```

`BotEngineConfig` gains `mcpServers?: BotMcpServer[]`; `BotEngineState` gains the
same field. The existing tri-state rule applies: **absent leaves the file alone**
(repair, reconcile, model probe), **present replaces the managed set** (an edit
form knows the list; `[]` clears it).

### 2. Wire and service

`packages/protocol/src/dto/bot.ts` gains `BotMcpServerInput` (same fields as
`BotMcpServer`, importing `McpExposure` from `./mcp.js`) and:

- `BotCreateInput.mcpServers?: BotMcpServerInput[]`
- `BotUpdateInput.mcpServers?: BotMcpServerInput[]` — absent keeps the file's
  servers; present replaces them.
- `BotConfig.mcpServers?: BotMcpServerInput[]` — `undefined` when the layout could
  not read the config, `[]` when it read it and there are none.

`BotService`:
- `writeEngineConfig` maps input to `BotEngineConfig.mcpServers` when the field is
  present on the input (`'mcpServers' in input`), mirroring how providers work.
- `inspectBot` maps `state.mcpServers` back out with a `toMcpServerConfig` helper.
- `createBot` and `updateBot` validate every server before writing:
  - name matches `^[A-Za-z0-9_-]+$` and is not `__proto__`, `prototype` or
    `constructor` (these would be assigned as object keys);
  - no duplicate names;
  - `stdio` has a non-empty `command`; `http` has a non-empty `url`.
  The error names the offending server, like the existing subagent-name checks.
  Layouts validate again as a second line; the service check exists because the
  wire does not validate payloads.

### 3. Engine mappings

#### pi — `<botRoot>/config/mcp.json`

`piAgentDir(botRoot)` is `<botRoot>/config`, which is pi's `PI_CODING_AGENT_DIR`,
so this is exactly the file pi reads.

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "ALLOWED_DIR": "/tmp" },
      "exposure": "deferred",
      "enabled": false
    },
    "web": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

- Reuse `readMcpFile` from `integration-pi/internal/mcp-config.ts`; write with the
  bot layout's atomic `0600` writer (bot config is a private tree).
- Read: `type` is **inferred**, because a hand-written entry often omits it:
  `http` when `type` is `http`, or when `url` is present with no `command`;
  otherwise `stdio` (which requires a `command`). `enabled` defaults to true.
  An entry with neither `command` nor `url` is pi's project *override* shape (it
  only carries `enabled`/`exposure`); it is not a server, so it is left out of the
  form **and preserved untouched on write**. A malformed server entry (e.g. a
  `stdio` entry with no command) is skipped, not thrown.
- Write: merge each listed entry over the file's existing entry of the same name
  (so unknown fields such as `auth` survive and a `cwd` the form never displayed
  round-trips), then delete existing entries that define a server and are not in
  the list. Override-only entries are never deleted. Drop `enabled: true` (the
  default). `cwd`, `args`, `env`, `headers` are stored only when non-empty.
- `exposure` is written as given; absent means pi's default.

#### OpenCode — `<botRoot>/config/opencode/opencode.json`

Add an `mcp` key to the same file `writeOpenCodeBotConfig` already merges.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
      "environment": { "ALLOWED_DIR": "/tmp" },
      "enabled": false
    },
    "web": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

- Reuse the entry-validation rules from
  `integration-opencode/internal/opencode-mcp-config.ts`, but iterate the `mcp`
  object entry by entry instead of calling `readMcpServers` (which throws on the
  first bad entry). An invalid entry is skipped, consistent with how
  `readProviders` already treats malformed provider blocks.
- Local entries store argv (`[command, ...args]`), env is spelled `environment`.
- Write: same merge-per-name and delete-unlisted rule. Drop `enabled: true`.
- Read: `local` → stdio, `remote` → http. `cwd` round-trips even though the form
  does not show it.
- `exposure` has no OpenCode equivalent and is dropped on both write and read.

#### pi `settings.json` schema reference

pi documents the same idea OpenCode already uses: add
`"$schema": "https://pi.dev/schemas/settings.schema.json"` to `settings.json`
for editor validation and completion. The schema itself declares `$schema`,
allows additional properties, and `pi` does not reject it.

- Add `PI_SETTINGS_SCHEMA` beside the file constants in
  `integration-pi/src/bot-layout.ts`.
- `writePiBotConfig` writes `{ $schema: PI_SETTINGS_SCHEMA, ...settings }`, so a
  new bot is self-describing and an edit rewrites it first, matching
  `writeOpenCodeBotConfig`'s `$schema: CONFIG_SCHEMA`.
- `piBotLayout.repair` seeds the reference into an existing `settings.json` that
  lacks it, so bots created by earlier releases get it on the next start without
  an edit. It never creates the file, it changes nothing else, and it runs before
  repair's legacy-persona early return (so both fixes land in one visit).
- `read` ignores the key (it is metadata, not a setting).

**Morse does not validate either file against its schema today.** The only
`$schema` in the codebase is the literal OpenCode writes; there is no JSON-schema
validator dependency. Adding pi's is therefore inert at runtime and useful to
editors and to a future validation step, exactly like OpenCode's.

#### Read failure is isolated to MCP

A bot's other settings must not be lost because its MCP file is corrupt.
`BotService.engineState` treats a throwing `layout.read` as "the whole config is
unreadable", and the wizard would then submit an empty persona over the real one.
So each layout reads only its MCP part inside its own `try`/`catch`:

- pi: any throw from `readMcpFile` (bad JSON, wrong top-level shape) yields **no
  `mcpServers` field**, not a failed `read`. The rest of the bot configuration is
  still read normally, and an edit leaves `mcp.json` untouched.
- OpenCode: the `mcp` key is already validated by `readOpenCodeFile` (a
  pre-existing behavior of the shared reader); individual malformed entries are
  skipped as above. A `local` entry missing `command` or a `remote` missing `url`
  is skipped, not fatal.

The same rule applies on write: a failure throws (the create/update fails), never
a partial silent success.

### 4. Wizard

New optional step **MCP**, inserted between **Persona** and **Advanced** in
`bot-wizard.ts` (`Step`, `steps()`, `labels`, `isStepComplete`). It is always
complete, like Advanced, so it never blocks Submit; the rail can jump to it once
Persona is satisfied.

The step is extracted into a focused child component
(`bot-mcp-step.ts/.html/.css`) rather than growing the 1,100-line wizard:

- **List** of the bot's servers as cards: name, `stdio: command args` or
  `http: url`, enabled state, pi exposure when the engine is pi, Edit, Remove.
- **Add/Edit form**:
  - Name
  - Transport: stdio / HTTP
  - stdio: Command, Arguments (whitespace-split, same convention as the global
    editor), Environment (`KEY=value` per line)
  - HTTP: URL, Headers (`Name: value` per line)
  - Enabled checkbox (default on)
  - Exposure select for pi only: Engine default / codemode / deferred / direct /
    hidden
  - **Test connection** — calls the existing `McpState.inspect` (`mcpInspect` host
    command, Morse's own MCP client) and shows a one-line result: connected with
    tool count, or the error class and message. It never blocks saving.
    The probe runs in the host's current workspace, exactly as the global MCP
    editor does (the bot's `workspace/` may not exist yet on create, and the host
    policy checks an explicit `cwd`). It answers "this command/URL starts and
    speaks MCP", not "this server behaves correctly with the bot's own working
    directory" — the UI copy says so, and the tests assert the probe payload.
- Validation in the form mirrors the host: name required/unique/pattern; command
  for stdio; URL for http; env/header lines must contain their separator.
- Review shows `MCP: filesystem, web (2)` when any are configured.
- Edit bot seeds the list from `BotConfig.mcpServers`; the wizard records whether
  the config actually supplied the field (`mcpLoaded`). Submit sends
  `mcpServers` when the wizard created any, or when an edit loaded the list (which
  includes the empty list, so removing the last server clears the file). If the
  layout could not read the config, the field is absent and an edit leaves MCP
  untouched.

Env and header values are read back into the form on edit. They are inline MCP
config, not the engine's credential store: provider keys stay unreadable by design,
but an MCP entry is only editable if its env/headers are visible. They stay inside
the bot's `0700` tree and go to the same authenticated host that serves the chat.

### 5. Errors and preservation

- A malformed MCP *entry* on read is skipped for the form; an edit rewrites the
  managed set, so a malformed hand-written entry disappears when the reader saves.
  This matches the existing provider-block behavior and is noted in the docs.
  pi's project-override entries are the exception: they are not servers and are
  preserved. A *file-level* failure never hides the rest of the bot's config (see
  "Read failure is isolated to MCP").
- A write failure (invalid name, unreadable JSON, permission) throws from the
  layout; create deletes the half-written bot as it does today, and update surfaces
  the message through the existing notice path.
- Unknown fields on entries the form keeps (OAuth config, future keys) are merged
  over and preserved; fields the form owns are overwritten.
- The `mcp`/`mcpServers` key is deleted when the list becomes empty, rather than
  left as an empty object, so a bot with no servers looks like a hand-made one.

## Files touched

- `packages/system/src/bot/types.ts` — neutral types, `BotEngineConfig`/`State`.
- `packages/system/src/bot/service.ts` — map, validate, inspect.
- `packages/protocol/src/dto/bot.ts` — `BotMcpServerInput`, create/update/config.
- `packages/integration-pi/src/bot-layout.ts` — write/read `config/mcp.json`;
  `$schema` in `settings.json` on write and repair.
- `packages/integration-opencode/src/bot-layout.ts` — write/read `mcp` block.
- `packages/ui-angular/src/app/features/bot-wizard/bot-wizard.ts/.html` — step,
  signals, submit, review.
- `packages/ui-angular/src/app/features/bot-wizard/bot-mcp-step.ts/.html/.css` — new.
- Tests beside each (see below).
- `docs/CONFIGURATION.md` — a bot-MCP paragraph naming both files, and pi's
  `settings.json` schema reference.
- `docs/superpowers/specs/2026-11-13-bot-mode-design.md` — amend the wizard order
  and note bot MCP servers.

## Test plan

- `integration-pi/src/bot-layout.spec.ts`
  - writes `config/mcp.json` with stdio/http, args/env/headers/cwd, enabled false,
    exposure;
  - reads it back into the neutral shape; absent `enabled` reads as true; an entry
    with no `type` is inferred from `command`/`url`;
  - an override-only entry (enabled/exposure only) is not shown but survives a
    write;
  - merges an existing entry's unknown field while replacing known ones;
  - deletes a server entry the form removed and removes the key when the list is
    empty;
  - a corrupt `mcp.json` leaves the rest of `read` intact and omits `mcpServers`;
  - an absent `mcpServers` leaves the file untouched;
  - `settings.json` is written with pi's `$schema` first and the reader's other
    settings preserved; `repair` seeds it into an existing file that lacks it and
    does not create one.
- `integration-opencode/src/bot-layout.spec.ts`
  - writes the `mcp` block with `local` argv and `remote` url/environment/headers;
  - reads it back; drops exposure; preserves unrelated top-level keys;
  - merge/remove/empty semantics as above; an absent field leaves `mcp` untouched;
  - a malformed entry is skipped while its siblings still read.
- `system/src/bot/service.spec.ts`
  - create/update forward `mcpServers`; an update without the field leaves the
    layout call without it;
  - `inspectBot` returns what the layout read;
  - invalid names, duplicates and missing command/url are refused.
- `ui-angular/src/app/features/bot-wizard/bot-wizard.spec.ts`
  - adding a server shows it and sends it on create;
  - edit seeds the list and sends it back; removing the last server sends `[]`;
  - an unreadable config (`mcpServers` absent) does not send the field;
  - duplicate/invalid names are refused in the form.
- Run `npm run test:fast` plus the two integration packages' tests
  (`npm test -w @morse/integration-pi -w @morse/integration-opencode`), since
  `test:fast` does not include them.

## Open items for the plan

- A future engine that does not support MCP would need a capability flag to hide
  the step. Both shipped engines support it, so none is added now.
- The global MCP helpers still key objects by server name without rejecting
  `__proto__`; this design rejects it at the bot boundary but does not change the
  global path.
