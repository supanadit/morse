# Engine resource foundation — design

**Date:** 2026-11-14
**Status:** design for approval
**Owner decisions:** abstract, reusable hierarchy (approach A); the foundation is
engine-generic, not bot-only and not MCP-only; MCP and prompt templates are the
first two domains migrated onto it; future engines extend it from their own
package.

## Intent

Morse already owns two copies of the same engine knowledge:

- **MCP**: `PiMcp` / `OpenCodeMcp` for the user's and a project's servers, and a
  second, bot-only codec inside `piBotLayout` / `openCodeBotLayout`. The copies
  have already drifted: the bot writers skip malformed entries, infer pi's
  transport and parse before writing, while the global OpenCode reader still uses
  strict `JSON.parse` and rejects a file OpenCode itself accepts.
- **Prompt templates**: `PiPrompts` (markdown files) and `OpenCodePrompts`
  (markdown files plus `command` entries in `opencode.json`) each implement the
  same list/save/delete/scope rules independently, with their own path
  resolution, validation and JSON writes.

The bot feature exposed the cost. It was designed as a bot-only extension because
that was the smallest safe change at the time, but the formats, validation,
preservation rules, scopes and "Fix" behavior are the same problem for the global
surfaces. The next features make the duplication untenable: Morse should manage
`opencode.json`/`opencode.jsonc`, pi's `settings.json`, `mcp.json` and
`models.json` from its own UI, and create isolated engine trees in Code Mode,
without the reader opening a JSON file in VS Code or Neovim.

The fix is a foundation, not another bot module: one abstract model of an
engine's files and resources, with concrete definitions supplied by each
integration package. MCP and prompt templates are migrated onto it in this
change. Settings, models and future engines reuse it without touching the
foundation.

## Goals

- Add `@morse/engine-config`, a package with **no engine knowledge** that models:
  - an engine's files and roots (user, project, isolated),
  - configuration files in JSON/JSONC (future formats behind the same base),
  - named config resources (MCP now; models, providers, agents later),
  - file resources (prompt templates now; skills, agents later),
  - composite resources (OpenCode's file + config commands),
  - scopes, precedence, preservation, atomic writes, permissions, issues and Fix.
- Provide abstract parent classes that a new engine package extends without
  editing the foundation: `EngineDefinition`, `EngineInstance`, `ConfigFormat`,
  `ConfigFile`, `ConfigSection`, `ConfigStore`, `ResourceStore`,
  `ConfigResourceStore`, `FileResourceStore`, `CompositeResourceStore`.
- Migrate **both** MCP surfaces onto one per-engine `McpStore`:
  - global/project panel and editor,
  - bot wizard (`<botRoot>/config/...` as an isolated engine).
- Migrate **both** prompt-template surfaces onto one per-engine `PromptStore`,
  with `PromptTemplate` as Morse's neutral object for pi prompts and OpenCode
  commands (files and `command` entries).
- Make OpenCode config reads legitimate: JSONC comments/trailing commas and
  `opencode.jsonc`, plus the project discovery Morse already implies
  (`<cwd>/opencode.json[c]`, `<cwd>/.opencode/opencode.json[c]`, ancestors).
- Give the UI a real **Fix** action and a captured problem report instead of a
  raw `Unexpected token` string.
- Prove the abstraction with two different storage shapes: config-backed (MCP)
  and file/composite-backed (prompt templates).

## Non-goals

- Building the generic settings/models UI in this change. The foundation and the
  extension points are built; those stores are a follow-up.
- Auto-repairing arbitrary syntax damage (missing braces, unquoted keys). Fix
  normalizes formats Morse understands; it does not guess at a broken document.
- Preserving comments when a JSONC file is rewritten. See the write rule below.
- Reworking agent/session behaviour, bot identity, credentials or the bot wizard
  steps. The bot MCP behaviour and tests remain the contract.
- A plugin system or dynamic package loading. "Extend it" means a new workspace
  package that subclasses the foundation.

## Anti-goals

- No engine format knowledge in `@morse/system` or the foundation. `system` is
  I/O-free; the foundation is engine-free.
- No second codec per feature: if the bot and the panel need the same file, they
  use the same store class.
- No God class branching on `engineKind`. Branching belongs in the engine's
  definition package, once.
- No silent rewrite of a user file that drops comments, and no write that
  half-applies a multi-file bot update.
- No new dependency for JSONC, atomic writes or frontmatter. Node built-ins plus
  the `yaml` package the pi integration already owns.

## Constraints

- `@morse/system` stays pure TypeScript with no `node:fs`; bot types may import
  shared DTOs from `@morse/protocol`.
- Engine format knowledge stays in `@morse/integration-pi` and
  `@morse/integration-opencode`.
- The existing host commands (`mcpStatus`, `mcpAdd`, `mcpRemove`,
  `mcpSetEnabled`, `mcpInspect`, `promptTemplates`, `promptTemplateSave`,
  `promptTemplateDelete`) keep their wire meanings; additions are additive.
- Bot files keep their privacy contract: directories `0700`, files `0600`,
  temp-file-then-rename writes.
- The new package builds before the integrations and is covered by
  `check-types`, `lint` and `test:fast`.

## Approaches considered

### A. Abstract foundation package + per-engine subclasses — chosen

A new `@morse/engine-config` package owns the generic hierarchy and the
engine-free algorithms (read, merge, write, normalize, issue capture). Each
integration package supplies a definition: file ids and paths, entry codecs,
prompt frontmatter, trust rules. Global managers and bot layouts both build an
`EngineInstance` and use the same stores.

Why: it is the only shape that removes the duplicate codecs without moving
format knowledge into `system`, and it is the shape future settings/models and
new engines extend. It also gives "isolated engine" a first-class meaning
(`EngineInstance.isolated(root)`), which the bot already needs and Code Mode will
reuse.

### B. One standalone store class per engine — rejected

`PiMcpStore`, `OpenCodePromptStore`, etc., each self-contained, sharing only a
file helper. It removes today's bot/global duplication but duplicates the
cross-cutting rules (JSONC, Fix, atomic writes, scope precedence, issue capture)
per engine and per domain. That is the drift this change exists to stop, and it
does not scale to settings/models.

### C. Composition (codec objects injected into generic stores) — rejected

`McpFileStore(codec)` has the same runtime shape as A with less inheritance. It
was rejected because the owner requires an abstract class hierarchy that a future
package can extend, and because paths, scopes and trust are engine behaviour, not
just a codec value. Composition remains available inside a subclass where it
helps (a `CompositeResourceStore` holds two stores).

## The foundation

### Package and layers

New package `packages/engine-config`, name `@morse/engine-config`, dependency
`@morse/protocol` only, Node built-ins allowed. Layout:

```
src/core/        format, file, section, store, issue, path, write helpers
src/resource/    ResourceStore, ConfigResourceStore, FileResourceStore,
                 CompositeResourceStore
src/engine/      EngineContext, EngineDefinition, EngineInstance
src/mcp/         McpStore and MCP entry/section bases
src/prompt/      PromptStore and PromptTemplate bases
src/index.ts
```

`@morse/engine-config` is not imported by `@morse/system`. Integrations and hosts
import it. The generic core knows nothing about MCP or prompts; those live in
their own modules as reusable domain bases for engines.

### The hierarchy

```ts
// engine/engine-context.ts
export type EngineOwnership = 'user' | 'isolated';

export interface EngineContext {
  ownership: EngineOwnership;
  /** Resolved user home. */
  home: string;
  /** Session/project directory, when there is one. */
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** Resolved `$XDG_CONFIG_HOME` (default `~/.config`). */
  xdgConfigHome: string;
  /** Resolved `$XDG_DATA_HOME` (default `~/.local/share`). */
  xdgDataHome: string;
  /** Isolated engines only: the engine's own config home. */
  root?: string;
}

// engine/engine-definition.ts
export abstract class EngineDefinition {
  abstract readonly kind: string;
  /** Files this engine owns, by stable id (`mcp`, `config`, `settings`, ...). */
  abstract files(): readonly ConfigFileId[];
  /** Builds the instance for a context (user/project or isolated). */
  abstract create(context: EngineContext): EngineInstance;
  /** The isolated form used by bots and Code Mode. */
  isolated(root: string, options?: EngineInstanceOptions): EngineInstance;
}

// engine/engine-instance.ts
export abstract class EngineInstance {
  abstract readonly definition: EngineDefinition;
  abstract readonly context: EngineContext;
  /** Resolve one file's read precedence and write target for a scope. */
  abstract paths(file: ConfigFileId, scope: ConfigScope, cwd?: string): ConfigPaths;
  /** Open a file (format chosen by extension/content), for Fix and future UI. */
  abstract file(file: ConfigFileId, scope: ConfigScope, cwd?: string): ConfigFile;
  /** Named config resources this engine supplies. */
  abstract readonly mcp?: McpStore;
  /** File/composite resources this engine supplies. */
  abstract readonly prompts?: PromptStore;
  // Future: settings, models, agents.
}
```

A new engine package implements `EngineDefinition` + `EngineInstance`, supplies
its `McpStore`/`PromptStore` subclasses, and registers the definition in the
host's registry. Nothing in the foundation changes.

`EngineInstance.isolated(root)` sets `ownership: 'isolated'`, `root`, and disables
project discovery: `scope: 'global'` means "this engine's own root", and
`scope: 'project'` is rejected with a typed issue. This is exactly the bot case
and the future Code Mode case.

### Configuration layer

```ts
export abstract class ConfigFormat {
  abstract readonly kind: 'json' | 'jsonc' | 'yaml';
  abstract parse(text: string, file: string): ParsedConfig;
  abstract serialize(value: unknown): string;
}

export abstract class ConfigFile {
  readonly path: string;
  abstract format(): ConfigFormat;
  /** Parse without writing. Always returns a document; failures are issues. */
  read(): ConfigDocument;
  /** Write the document; refuses a non-strict source unless `normalize`. */
  write(value: unknown, options?: WriteOptions): ConfigMutation;
  /** Fix: rewrite as strict JSON at the same path. */
  normalize(): ConfigMutation;
  signature(): string;
}

export abstract class ConfigSection<T> {
  abstract readonly key: string; // 'mcpServers' | 'mcp' | 'command' | ...
  abstract decode(raw: unknown, context: SectionContext): SectionResult<T>;
  abstract encode(value: T, existing: unknown): unknown;
}
```

`JsonFormat` is concrete: strict `JSON.parse` first; on failure, a small
comment/trailing-comma stripper that respects strings, then parse again. The
document records `strict: false` when the source needed the stripper, plus a
fixable `normalize` issue. A real syntax error reports the parser's message, the
byte offset mapped to a line, and a bounded snippet. No dependency.

`ConfigDocument` keeps the parsed value and the original text so a caller can
show exactly what is wrong; the value is never rewritten until a mutation.

### Resource layer

```ts
export abstract class ResourceStore<T, TSave = T> {
  abstract list(scope: ConfigScope, cwd?: string): ResourceList<T>;
  abstract save(input: TSave, scope: ConfigScope, cwd?: string): ResourceMutation;
  abstract remove(name: string, scope: ConfigScope, cwd?: string): ResourceMutation;
  abstract signature(scope: ConfigScope, cwd?: string): string;
}

export abstract class ConfigResourceStore<T> extends ResourceStore<T> {
  abstract readonly section: ConfigSection<Record<string, T>>;
  /**
   * Pure transform: apply a managed set to an already-read document and return
   * the next value plus issues. No I/O. A caller that owns other sections of the
   * same file (the OpenCode bot layout) composes its changes on this value and
   * writes once. `save`/`remove`/`replaceManaged` are read-apply-write wrappers.
   */
  abstract apply(document: ConfigDocument, items: readonly T[]): ApplyResult;
  // Concrete: list/upsert/remove/replaceManaged/normalize over ConfigFile.
  // It owns precedence, preservation, delete-when-empty and issue capture.
}

export abstract class FileResourceStore<T> extends ResourceStore<T> {
  abstract dirs(scope: ConfigScope, cwd?: string): ResourceDirs;
  abstract readonly extension: string;
  abstract decode(name: string, raw: string, path: string): T;
  abstract encode(item: T): string;
  // Concrete: list/merge by name/save-with-move/delete over a directory.
}

export abstract class CompositeResourceStore<T> extends ResourceStore<T> {
  // Concrete: merge N child stores by name and precedence; route save/delete
  // to the child named by the item's source.
}
```

This is the abstraction's proof: MCP is a `ConfigResourceStore`; pi prompts are a
`FileResourceStore`; OpenCode prompts are a `CompositeResourceStore` of a
`FileResourceStore` and a `ConfigResourceStore` for `command` entries. Future
settings/models are `ConfigResourceStore`s or plain `ConfigStore`s; future skills
are `FileResourceStore`s.

### Scopes, paths and precedence

`ConfigScope = 'global' | 'project'`. A store asks the engine instance for
`ConfigPaths { write: string; read: string[] }`; `read` is precedence-ordered,
highest first. The store merges by name and reports the defining source. Mutations
write the scope's target (the project file for `project`; the engine's own file
for `global`), never a read fallback. Isolated instances expose only `global`.

`ConfigPaths` and `ResourceDirs` are the only place an engine's filesystem
layout lives. `EngineInstance.paths` is the single resolver used by stores,
Fix and future UI; a client can never ask the host to write an arbitrary path.

### Issues, mutations and Fix

Wire types move to `@morse/protocol` so hosts and UI share them:

```ts
export interface ConfigIssue {
  file: string;      // absolute path
  fileId: string;    // 'mcp' | 'config' | 'settings' | ...
  pointer?: string;  // '/mcpServers/filesystem/command'
  code: 'parse' | 'shape' | 'normalize' | 'name' | 'frontmatter' | 'read' | 'write';
  message: string;
  snippet?: string;  // bounded offending region, for "capture wrong format"
  fixable: boolean;  // Fix can resolve it
}

export interface ConfigMutation {
  ok: boolean;
  message?: string;
  path?: string;
  scope?: ConfigScope;
  issues: ConfigIssue[];
}
```

Rules:

- **Read is tolerant.** A malformed entry is skipped with an issue; its siblings
  still list. A malformed file yields no items from that file and one issue; other
  scopes still list.
- **Write is strict and explicit.** A mutation on a user document whose source was
  JSONC returns `normalizeRequired` (fixable) and writes nothing. `normalize()`
  rewrites the same path as strict JSON, atomically, dropping comments and
  trailing commas. The UI's Fix button is the only caller; the confirmation copy
  says comments are removed. **Isolated (Morse-owned) trees are the exception:**
  a bot's files are generated by Morse, so an isolated instance normalizes a JSONC
  file on write instead of making the bot uneditable. The no-silent-rewrite rule
  protects user files, not generated ones.
- **Preserve everything not managed.** The whole document is round-tripped;
  unknown keys on entries survive through `encode(item, existing)`.
- **Delete an empty block.** When the last managed entry is removed the section
  key is deleted, matching both engines.
- **Atomic and private when isolated.** Temp file in the same directory, `rename`;
  isolated: dir `0700`, file `0600`; user: preserve the existing mode, default
  `0644`. No write is attempted on a read-only operation.
- **Parse before any write.** A store exposes its parsed document to the caller;
  the bot layout parses every file it will touch first, then commits. A corrupt
  `mcp.json` aborts the update before identity is written.

### Extension recipe

A future engine (example: `@morse/integration-claude`) does four things:

1. `class ClaudeEngineDefinition extends EngineDefinition` with `kind`, `files()`
   and `create()`.
2. `class ClaudeEngineInstance extends EngineInstance` resolving its paths and
   exposing `mcp`/`prompts` stores.
3. `class ClaudeMcpStore extends McpStore` implementing the entry codec, or
   `class ClaudePromptStore extends FileResourceStore<PromptTemplate>`.
4. Register the definition in the host registry.

No foundation file and no `system` file changes. The recipe goes in the package
README and the design's appendix.

## Domain 1: MCP

### Neutral object

`@morse/protocol` gains one `McpServer`:

```ts
export interface McpServer {
  name: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;          // absent = enabled
  exposure?: McpExposure;     // pi only
  description?: string;
}
```

`BotMcpServer`, `BotMcpServerInput` and the MCP subset of `McpServerInput`
become this type (aliases where the wire needs the engine/scope fields).
`enabled` keeps meaning "absent = enabled"; engines drop `true` on write.

### Store

`McpStore extends ConfigResourceStore<McpServer>` is abstract and owns:

- name validation (`^[A-Za-z0-9_-]+$`, not `__proto__`/`prototype`/`constructor`);
- `setEnabled(name, enabled, scope, cwd)` with an engine hook
  `writeProjectOverride?` (pi writes an override; OpenCode returns unsupported);
- `replaceManaged(servers, scope, cwd)` for the bot wizard (the form's list is
  the complete managed set) with a hook `keepsEntry(entry)` (pi keeps
  override-only entries; OpenCode keeps none);
- issue capture with pointers and bounded snippets;
- `normalize()` for Fix.

Per engine, only the entry codec and paths differ:

- **pi** (`PiMcpStore`): block `mcpServers`; `type` optional and inferred
  (`url` without `command` = http, else stdio); stdio `command` string + `args`
  array; http `url` + `headers`; `environment` is spelled `env`; `enabled` absent
  when true; `exposure`/`toolExposure`/`oauth`/`timeout` preserved.
- **OpenCode** (`OpenCodeMcpStore`): block `mcp`; `type: 'local' | 'remote'`;
  local `command` is an argv array, env is spelled `environment`; remote `url` +
  `headers`; no exposure.

### Status

- **pi**: `PiMcp.status(cwd, { probe })` lists from the store instead of spawning
  `pi mcp list`. Without `probe`, it answers immediately with the configured rows
  (`state: 'connecting'` for enabled servers, `disabled` for disabled ones) and
  `issues`. With `probe: true`, it probes the enabled servers with Morse's
  existing MCP client (`internal/mcp-client.ts`) under bounded concurrency and a
  per-server timeout, and fills `state`, `tools`, `resources` and errors. The
  panel makes the fast call first for an instant list, then the probing call in
  the background and replaces the rows when it lands. No host→client push message
  is added: both are ordinary request/response calls and the existing 30 s client
  timeout covers the probing call. Project entries are filtered when the project
  is untrusted (the panel already offers Trust). Servers registered by pi
  extensions are not visible from files and are no longer listed; the panel note
  says "configured files only".
- **OpenCode**: configured truth only, as today, but read through the JSONC-aware
  store and with `.jsonc`/project discovery. This is what makes the screenshot's
  file readable.

### Scopes and paths

- pi user: `<agentDir>/mcp.json`; pi project: `<cwd>/.pi/mcp.json` (project wins).
- OpenCode global: `<configHome>/opencode.json` and `opencode.jsonc`
  (`.jsonc` higher precedence); project: `opencode.json[c]` and
  `.opencode/opencode.json[c]` from the workspace upward, nearest wins.
  `OPENCODE_CONFIG`, system/managed config and the OpenCode server API remain out
  of scope.
- Isolated (bot): pi `<root>/mcp.json`; OpenCode `<root>/opencode/opencode.json[c]`.
  Writes target the existing extension; a new file is `.json`.

## Domain 2: Prompt templates

### Neutral object

`PromptTemplate` becomes the one object Morse uses, with the existing fields:
`name`, `scope`, `source: 'file' | 'config'`, `path?`, `description?`,
`argumentHint?` (pi only), `body?`, `raw?`, `entry?` (OpenCode config commands),
`error?`. `PromptTemplateInfo`, `PromptTemplateInput` and the host DTOs keep their
wire names but are built from this object.

### Stores

- **pi** (`PiPromptStore extends FileResourceStore<PromptTemplate>`):
  - dirs: global `<agentDir>/prompts`, project `<cwd>/.pi/prompts`;
  - `.md` children only; file name is the command name;
  - frontmatter parsed with the same `yaml` parser pi uses
    (`internal/prompt-frontmatter.ts` moves into the store or is shared);
  - invalid frontmatter is an item issue (`error`) and refuses to save, with
    pi's own message; project templates shadow global by name; `trusted` rides
    the list result.
- **OpenCode** (`OpenCodePromptStore extends CompositeResourceStore<PromptTemplate>`):
  - files: global `<configHome>/commands/*.md`, project
    `<cwd>/.opencode/commands/*.md`; `description` in frontmatter;
  - config: the `command` key of the **global** `opencode.json[c]` only, via a
    `ConfigResourceStore` with the same JSONC-aware file. This preserves today's
    behavior; project `command` entries are a later feature even though project
    config discovery exists for MCP;
  - file rows and config rows are distinct by `source`, merged by name with files
    first (current behavior); save/delete routes by `source`;
  - `trusted: true` (OpenCode has no trust gate).

### Save/delete semantics

Unchanged from today: a scope move writes the new file before deleting the old;
a rename at the same scope rewrites in place; config entries are keyed, with
rename = delete + insert; deleting the last config entry deletes the `command`
block; the body/raw and entry round-trip exactly as the editor composed them.

## Engine definitions

### pi

Files: `mcp` (`mcp.json`), `settings` (`settings.json`), `models` (`models.json`),
`auth` (`auth.json`), plus prompts (a directory, not a config file id).
Roots: user `<agentDir>` (`PI_CODING_AGENT_DIR` or `~/.pi/agent`), project
`<cwd>/.pi`, isolated `<root>`. Project resources honor the `.pi` trust gate.
`$schema` writing and the `repair` backfill stay in the engine definition; they
are file mutations, now through `ConfigFile`.

### OpenCode

Files: `config` (`opencode.json[c]`), plus command files. Roots: user
`<xdgConfigHome>/opencode`, project workspace discovery, isolated `<root>` with
config at `<root>/opencode/opencode.json[c]` (the bot's `XDG_CONFIG_HOME` is
`<botRoot>/config`). Agents, providers and `$schema` writing stay in the bot
layout; they become file sections over the same `ConfigFile` in later work.

### Bot mode

`piBotLayout` / `openCodeBotLayout` stop owning MCP codecs. Each builds an
isolated `EngineInstance` over `<botRoot>/config` and uses `instance.mcp`:

- write: parse the store's document first, then write identity/settings/etc.
  Where MCP shares a file with other sections (OpenCode), the layout calls the
  store's pure `apply(document, servers)` and composes the returned value with
  `$schema`, `username`, providers, agents and instructions, then writes the file
  **once**. There is never a second writer for the same path.
- read: `instance.mcp.list('global')` (isolated mode), skipping a corrupt file as
  today;
- the wizard's `mcpServers` tri-state is unchanged: absent leaves the file,
  present replaces the managed set, `[]` clears it.

Prompt templates are not part of the bot wizard yet; the store is ready when they
are. The bot never reads the user's or project's engine resources.

## UI and host changes

- `McpStatus` gains `issues: ConfigIssue[]` while `errors: string[]` stays
  populated for compatibility. The panel renders each issue's message, pointer
  and snippet, with a **Fix** button when `fixable`. `mcpStatus` gains an optional
  `probe: boolean` (default `false`); the panel calls it once without probing,
  then again with probing in the background.
- `PromptTemplatesResult` gains `issues`; the prompt editor renders them beside
  the list and offers Fix for a format issue in its config file.
- New generic host command `configFix`
  (`{ engine?, fileId, scope, cwd?, path }`) calls the engine instance's
  `file(fileId, scope, cwd).normalize()` for the file named by the issue. The
  path is validated against the resolved candidate set for that file and scope
  (write target **and** every read fallback, including `.jsonc` and ancestor
  files); anything else is refused. This is why an issue carries its absolute
  `file` and `fileId`, and why `fixable` is computed when the file is read: a
  broken ancestor that Fix cannot legally write is reported but not fixable. The
  MCP and prompt surfaces call it through `McpState`/`PromptTemplatesState`.
- The MCP editor's save error points at the Fix action instead of only printing a
  parse error.
- The header dot and panel copy keep their meaning; pi's probe replaces the CLI's
  live state, and OpenCode stays "configured only".

**Host scope.** The browser/NestJS host (the one whose engine registry supplies
per-engine `AgentExtras`) gets the new `probe` flag and `configFix`. The VS Code
extension currently registers engines without extras and builds its MCP/prompt
ports from `router.defaultExtras()`, so those capabilities are already off there;
wiring per-engine extras into that host is a pre-existing gap and is out of scope
for this change. It inherits the foundation when it is done, and the UI hides Fix
when the command is unsupported.

## Error handling and safety

- Every read returns a result, never throws for a malformed file; unexpected I/O
  errors (EACCES, ENOENT after a check) become issues with their path.
- Writes are atomic per file; multi-file updates are not a transaction, but every
  input file is parsed and validated before the first write.
- The host never accepts an arbitrary path: `configFix` validates against
  `engine.paths`, and store mutations use the engine's resolver.
- Names are validated before becoming object keys; `__proto__`, `prototype` and
  `constructor` are refused.
- A JSONC write is refused, not silently normalized; Fix is explicit and its
  confirmation states that comments are dropped.
- File permissions: isolated trees `0700/0600`; user files keep their mode.

## Testing

- Foundation: JSONC parse/strict flag/serialize, parse errors with line and
  snippet, atomic write and modes, write refusal + normalize, isolated
  auto-normalize, section codec, pure `apply`, precedence merge,
  delete-when-empty, issue pointers, `ResourceStore` contract tests, composite
  routing, isolated scope rejection, extension recipe compile.
- pi: existing `PiMcp`/`PiPrompts`/bot-layout tests port unchanged; new tests for
  store parity (global vs bot path), probe mapping, trust filtering, no CLI call.
- OpenCode: existing MCP/prompt/bot tests port unchanged; new tests for JSONC,
  `.jsonc`, project discovery, `command` entries, write refusal + Fix.
- System/protocol: type unification compiles; bot data migration tests pass.
- UI: panel issue rendering and Fix flow; prompt editor issue rendering; existing
  specs unchanged.
- Gates: `npm run test:fast`, integration-pi, integration-opencode,
  `npm run check-types`, `npm run lint`, then full `npm test`.

## Migration and rollout

1. Add the package and update `build:libs` (after protocol, before integrations),
   `test:fast`, lint and tsconfig includes.
2. Move shared DTOs (`McpServer`, `PromptTemplate`, `ConfigIssue`) to protocol;
   alias the bot/wire types.
3. Port pi MCP + prompts, then pi bot layout.
4. Port OpenCode MCP + prompts, then OpenCode bot layout; add JSONC and
   `.jsonc`/discovery.
5. Add `issues` to status DTOs and `configFix`; wire the panel/editor Fix.
6. Update docs: `docs/CONFIGURATION.md`, the bot MCP design's superseded non-goal,
   the bot-mode spec if it repeats the format details, and the package README.
7. Delete the old internal modules only after their tests are ported and green.

Backwards compatibility: bot files, names, permissions and tri-state semantics do
not change. Existing user configs remain readable; JSONC files that used to error
now read, and their first mutation asks for Fix. Hosts that do not know
`configFix` still work; the button is hidden when the command is unsupported.

## Risks

- **Parity drift during the port.** Both old and new tests run in the same task
  and are removed only after the new store passes them. A table of old→new tests
  is part of the plan.
- **pi probing replaces the CLI.** Slower panel opens and no extension servers.
  Mitigated by bounded concurrency, the existing 60 s TTL, an immediate
  configured list, and explicit panel copy.
- **JSONC write refusal surprises.** The issue and Fix copy explain it; reads
  never block.
- **OpenCode discovery is larger than today.** Ancestor and `.opencode` files can
  change what the panel lists. Tests pin precedence; out-of-scope sources
  (`OPENCODE_CONFIG`, managed config) are documented.
- **New package wiring.** Build order and test scripts are easy to miss; the plan
  lists every edit and a clean `npm run build` is a gate.
- **Multi-file bot writes.** Parse-before-write closes the corrupt-file case; a
  disk failure mid-way can still leave a partly written bot. This is existing
  behaviour, documented, and not made worse.

## Decisions made (the owner can correct any)

1. New package `@morse/engine-config` rather than putting the foundation in
   `system` (which must stay I/O-free) or duplicating it per engine.
2. Abstract classes, not composition, as the public extension surface; a
   composite store uses composition internally.
3. `McpServer` and `PromptTemplate` become the shared neutral types in protocol;
   bot and wire types alias them.
4. Reads accept JSONC; writes to a non-strict file fail with a fixable issue;
   Fix rewrites strict JSON and drops comments after confirmation.
5. Fix repairs formats Morse understands; entry-shape problems are captured with
   pointer/snippet, not auto-converted.
6. pi status lists from files and probes with Morse's client; extension servers
   are no longer listed. OpenCode stays configured-only.
7. OpenCode gains `.jsonc` and project discovery in this change.
8. Bot mode uses `EngineInstance.isolated(<botRoot>/config)`; no user/project
   inheritance.
9. Prompt templates migrate now, as the second storage shape that proves the
   abstraction; prompt UI behavior is unchanged except issues/Fix.
10. Settings/models/agents stores and generic config modals are follow-ups built
    on this foundation, not part of this change.
11. Live pi state is a second `mcpStatus` call with `probe: true`, not a new
    host→client push channel; the panel renders configured rows first.
12. A file shared by MCP and other bot sections (OpenCode) is composed through
    the store's pure `apply` and written once by the layout, never by two writers.
13. `configFix` acts on the issue's absolute path after validating it against the
    resolved candidate set; `fixable` is computed per file at read time.
14. The VS Code host's missing per-engine extras stay a pre-existing gap; this
    change is scoped to the browser/NestJS host and the frontend.
15. OpenCode project `command` entries remain unlisted in this change; only the
    global config's `command` block is a prompt source, as today.
16. Isolated (Morse-generated) JSONC is normalized on write; user JSONC requires
    the explicit Fix action.

## What is left to the builder

- Exact method names and file layout inside the new package, the shape of
  `ConfigDocument`/`ResourceList`, and whether `EngineDefinition.isolated` is a
  method or a factory function.
- The JSONC stripper's implementation and its test corpus.
- Probe concurrency/timeout numbers for pi status, within the stated bounds.
- The precedence list for OpenCode ancestor discovery and the write-target rule
  when several project files exist.
- UI copy and the exact placement of the Fix button in the panel/editor.
- The migration order inside each task, as long as each old test port is green
  before its old module is deleted.

## Appendix: extension recipe example

```ts
// @morse/integration-claude
export class ClaudeEngineDefinition extends EngineDefinition {
  readonly kind = 'claude';
  files() { return ['mcp', 'settings'] as const; }
  create(context: EngineContext) { return new ClaudeEngineInstance(this, context); }
}

export class ClaudeEngineInstance extends EngineInstance {
  readonly mcp = new ClaudeMcpStore(this);
  readonly prompts = new ClaudePromptStore(this);
  paths(file: ConfigFileId, scope: ConfigScope, cwd?: string): ConfigPaths { ... }
  file(file: ConfigFileId, scope: ConfigScope, cwd?: string): ConfigFile { ... }
}

export class ClaudeMcpStore extends McpStore {
  protected decodeEntry(name: string, raw: unknown, ctx: SectionContext) { ... }
  protected encodeEntry(server: McpServer, kept: unknown) { ... }
}
```

The host registry gains one line; MCP, prompts, Fix and future settings work
without a foundation change.
