# @morse/engine-config

The **engine-generic configuration foundation**: the abstract model of an engine's config files,
sections and resources that every Morse engine integration builds on. It owns the rules that are the
same for every engine — scopes and precedence, JSON/JSONC reading, strict atomic writes, issue
capture and Fix — and **no engine's own file layout**.

Part of the [Morse](../../README.md) monorepo. It depends on `@morse/protocol` and Node built-ins
only. The neutral vocabulary an engine needs — `McpServer`, `PromptTemplate`, `ConfigIssue`,
`ConfigMutation`, `ConfigScope` — is re-exported here, so a store can be written against this package
without a second import.

**The rule:** engine formats stay in integration packages. This package knows a JSON object and a
comment-bearing JSONC file; it does not know pi's `mcpServers` block, OpenCode's `mcp` spelling,
either engine's project-override rules, a prompt file's frontmatter, or where any engine keeps its
config. Those live in `@morse/integration-pi`, `@morse/integration-opencode`, and whatever
integration comes next.

## What is in here

| Directory | Contents |
|---|---|
| `src/core/` | `JsonFormat`/`ConfigFormat`, `ConfigFile`/`JsonConfigFile`, `ConfigSection`/`NamedConfigSection`, `ConfigStore`/`ConfigResourceStore`, the shared vocabulary (`ConfigDocument`, `ConfigPaths`, `WritePolicy`, `SectionContext`, `EngineContext`), and the atomic writer |
| `src/engine/` | `resolveEngineContext`, `EngineDefinition`, `EngineInstance`, and the narrow `ConfigLocator` a store reads through |
| `src/mcp/` | `McpStore` and `McpSection` (the named-entry base every engine's MCP block extends) plus the server-name rules |
| `src/prompt/` | the `PromptStore` contract (`list` returns a `PromptList`: rows, directories, trust and the config file config-sourced rows live in) |
| `src/resource/` | `ResourceStore`, `FileResourceStore` (one file per item), `CompositeResourceStore` (several surfaces behind one store) |

Everything is exported from `src/index.ts`; there is no second entry point.

## The hierarchy

```text
resolveEngineContext(input) ──> EngineContext { ownership, home, cwd?, env, xdgConfigHome, xdgDataHome, root? }

EngineDefinition                     kind, create(context), isolated(root, options?)
      │ creates
      ▼
EngineInstance                       definition, context, ownership, paths, file, fileAt, scopeOf, mcp?, prompts?
      implements ConfigLocator       (ownership, paths, file, fileAt, scopeOf)

ConfigFormat                         kind ('json' | 'jsonc'), parse, serialize
  └─ JsonFormat                      strict JSON out; strict JSON first, then JSONC in

ConfigFile                           read() -> ConfigDocument, write(value, {normalize?}), normalize(), signature()
  └─ JsonConfigFile                  a JSON file on disk (WritePolicy: user | isolated)

ConfigSection<T>                     key, decode(raw, context), encode(value, existing)
  └─ NamedConfigSection<T>           a `{ name: entry }` block; decodeEntry/encodeEntry, isOverride,
                                     keepsOnReplace

Document store (not a ResourceStore: no list/remove)
└─ ConfigStore<T>                    read/save/normalize/signature over the whole document

ResourceStore<T, TSave>              list, save, remove, signature
├─ ConfigResourceStore<T, TItem>     named entries of one block; upsert/remove/replaceManaged/apply/normalize
│    └─ McpStore                     names validated, overrides merged, project override hook, enable/disable
├─ FileResourceStore<T, TSave>       one file per item in a global and a project directory
├─ CompositeResourceStore<T, TSave>  N child stores; list concatenates, a mutation routes by `source`
└─ PromptStore                       the prompt contract (PromptList: dirs, trusted, configPath)
```

A store is written against `ConfigLocator` (`paths`, `file`, `fileAt`, `scopeOf`, `ownership`), not
against a concrete engine. `EngineInstance` implements that interface, so a manager hands the engine
itself to its stores. The base algorithms only open the paths in the chain they resolved; `file` and
`fileAt` trust their caller with a path, so a Fix handler validates the issue's absolute `file`
against the resolved chain before it calls `fileAt(...)` — which is exactly what the pi and OpenCode
managers do.

`EngineDefinition.isolated(root)` is the bot/Code-Mode form: `ownership: 'isolated'`, that root as the
engine's own global home, no project discovery (`scope: 'project'` is refused with an `unsupported`
issue). A user instance reads the user tree and, for a project scope, the project chain.

### Scopes, paths and precedence

- `ConfigScope` is `'global' | 'project'`. `paths(fileId, scope, cwd?)` answers `{ write, read }`:
  `read` is the precedence chain, highest first; `write` is what a plain upsert, remove or managed
  replacement edits. A listed entry toggled through `setEnabled` is written to the file that defines it,
  which may be a read fallback rather than `write`.
- A chain may hold more than two files (OpenCode's `.opencode`/ancestor configs). The chain is walked
  by **path**, and an edit to a listed entry lands in the file that defines it, even when that file is
  a read fallback. An explicit scope restricts the edit to that scope's files; an unnamed scope edits
  the nearest definition.
- `defaultConfigScope(locator, cwd)` is `global` for an isolated instance, `global` when no directory
  is named, and `project` otherwise.

### Reading, writing and Fix

- **Read is tolerant.** `ConfigFile.read()` always returns a `ConfigDocument`
  (`path`, `fileId`, `scope`, `value`, `text`, `exists`, `strict`, `issues`) and never throws for bad
  content. A missing file is an empty document; a file that is a directory or unreadable is a `read`
  issue.
- **JSONC reads.** `JsonFormat` tries strict JSON first. If that fails it strips comments and trailing
  commas (outside strings) and parses again; success means `strict: false` plus one fixable
  `normalize` issue. A second failure is a real syntax error: a `parse` issue with the parser's
  message and a bounded snippet, `fixable: false`.
- **Write is strict and explicit.** A write refuses when the file has a `read` issue, when a user file
  has a `parse` issue, or when a user file was JSONC and `{ normalize: true }` was not passed — that
  last refusal is a fixable `normalize` issue, so the UI can offer Fix. An **isolated** (Morse-owned)
  file is normalized on write instead: a bot's file is generated, so JSONC there is rewritten as
  strict JSON rather than making the bot uneditable.
- **Fix rewrites, it does not guess.** `normalize()` parses, refuses a `parse`/`read` problem, no-ops on
  an already strict or missing file, and otherwise rewrites the same path as two-space strict JSON
  through the atomic writer. A store's `normalize(scope, cwd)` does that for every existing non-strict
  file in the chain.
- **Preserve what is not managed.** The whole document round-trips; `encode(item, kept)` receives the
  existing entry so unknown fields survive. Removing the last entry of a block deletes the block.
- **Atomic and private when isolated.** `writeAtomic` writes a sibling temp file and renames it over
  the target. An isolated tree gets directories `0700` and files `0600`; a user file keeps its current
  mode (`0644` when the file is new). The file's mode is enforced with an explicit chmod because a
  umask can strip what `writeFileSync` asked for.
- **Failures are values.** Every mutation answers `ConfigMutation { ok, message?, path?, scope?,
  issues }`; a read answers a `ConfigDocument` and a list a `ResourceList`, each carrying the issues it
  met. Nothing stores a thrown error, and a refused write can still carry the issues it found while
  reading.

### The issue and Fix contract

`ConfigIssue` (defined in `@morse/protocol`, re-exported here) is the one complaint shape the host and
the UI share:

```ts
interface ConfigIssue {
  file: string;      // absolute path of the file
  fileId: string;    // 'mcp' | 'config' | 'prompt' | ...
  scope: ConfigScope;
  pointer?: string;  // JSON pointer, e.g. '/mcpServers/filesystem/command'
  code: 'parse' | 'shape' | 'normalize' | 'name' | 'frontmatter' | 'read' | 'write' | 'unsupported';
  message: string;
  snippet?: string;  // bounded offending region
  fixable: boolean;  // Fix can resolve it
}
```

- An engine's codec reports `shape` (with a pointer) for an entry it cannot read and `name` for an
  unusable key; `parse`/`read`/`write` belong to the file, `normalize` is the fixable JSONC rewrite,
  and `unsupported` is a scope or a file the engine has no legal path for. A decoder never throws: it
  returns `undefined` and pushes its explanation, so siblings still list.
- `fixable` is decided when the file is read. Only a `normalize` issue is fixable today.
- Fix is the **host's** `configFix` command, and the engine manager is what validates it: the issue's
  absolute `file` must be one of the paths that engine resolves for `fileId`/`scope`/`cwd` (the write
  target or a read fallback, including `.jsonc` and ancestor files). Anything else is refused as
  `unsupported`; a store or a client can never make the host rewrite an arbitrary file.
- The browser host exposes the action beside a fixable issue in the MCP panel and the prompt editor.
  The VS Code host does not implement `configFix`, so a Fix there is refused rather than performed.

## Extension recipe: a new engine

`@morse/integration-acme` needs four things; no file in this package changes.

**1. A definition.** Name the engine and how to build an instance from a resolved context.

```ts
export class AcmeEngineDefinition extends EngineDefinition {
  readonly kind = 'acme';

  create(context: EngineContext): AcmeEngineInstance {
    return new AcmeEngineInstance(this, context);
  }
}
```

**2. An instance.** Resolve this engine's paths for each file id and expose the stores it has.

```ts
export class AcmeEngineInstance extends EngineInstance {
  readonly definition: AcmeEngineDefinition;
  readonly context: EngineContext;
  readonly ownership: 'user' | 'isolated';
  readonly mcp: AcmeMcpStore;
  readonly prompts: AcmePromptStore | undefined;

  constructor(definition: AcmeEngineDefinition, context: EngineContext) {
    super();
    this.definition = definition;
    this.context = context;
    this.ownership = context.ownership;
    this.mcp = new AcmeMcpStore(this);
    this.prompts = undefined; // until the engine has a prompt store
  }

  paths(fileId: string, scope: ConfigScope, cwd?: string): ConfigPaths {
    // Return { write, read } for this engine's own file, project chain or
    // isolated root. Throw UnsupportedScopeError for a scope it cannot serve.
  }

  file(fileId: string, scope: ConfigScope, cwd?: string): ConfigFile {
    return this.fileAt(fileId, this.paths(fileId, scope, cwd).write, scope);
  }

  fileAt(fileId: string, path: string, scope: ConfigScope): ConfigFile {
    return new JsonConfigFile(path, fileId, scope, { ownership: this.ownership });
  }

  scopeOf(fileId: string, path: string): ConfigScope {
    // Which scope a resolved path belongs to; throw UnsupportedScopeError when
    // the path is not one this instance resolved.
  }
}
```

**3. The store subclasses.** Supply the engine's own spelling, never the algorithms.

```ts
class AcmeMcpSection extends McpSection {
  readonly key = 'acmeServers'; // this engine's block key
  decodeEntry(name: string, raw: unknown, context: SectionContext): McpServer | undefined { /* ... */ }
  encodeEntry(item: McpServer, kept: unknown): unknown { /* ... */ }
  override isOverride(raw: unknown): boolean { /* optional: a project pin */ }
}

class AcmeMcpStore extends McpStore {
  constructor(locator: ConfigLocator) {
    super(locator, 'mcp', new AcmeMcpSection());
  }
}
```

A prompt source extends `FileResourceStore` (`extension`, `dirs`, `decode`, `encode`) when templates
are files, or `CompositeResourceStore` over a file store and a `ConfigResourceStore` when the engine
also keeps commands in a config block. It does not extend `PromptStore`: `EngineInstance.prompts` is
typed as one, which such a store satisfies structurally by answering `list` with a `PromptList`.

**4. Wire it into a host.** A manager builds the definition per directory (or as
`definition.isolated(root)` for a bot/Code Mode tree) and adapts the stores to the host's
administration port: `AgentExtras.fix` and the host commands that route through `AgentExtras.mcp`
(`status`, `add`, `remove`, `setEnabled`, `trustProject`, `configSignature`) and `AgentExtras.prompts`
(`list`, `save`, `delete`). Register that integration with the host's engine list (the NestJS host's
`createAgentRouter`). Nothing in `@morse/system` learns the engine's format either.

## Rules this package enforces for you

- Every mutation takes its target from the locator — `write` for an upsert/remove/managed
  replacement, the path that defined an entry for a `setEnabled` — so the engine's resolver chooses the
  file; a path handed to `fileAt` directly is trusted, which is why Fix validates it first (above).
- MCP server names (`^[A-Za-z0-9_-]+$`, not `__proto__`/`prototype`/`constructor`) are validated before
  becoming object keys, on read and on write.
- `McpStore.setEnabled` with no scope edits the nearest definition, and a project edit of a user-level
  server goes through the engine's `writeProjectOverride` hook (pi writes a pin, OpenCode refuses).
- A multi-file update is not a transaction: the foundation makes each individual write atomic, and the
  caller that owns several files (a bot layout) parses and validates every input before the first
  write.

## Conventions the engine codecs share

- `enabled` means "absent is enabled": a codec stores `enabled: false` and never a stored `true`.
- An override-only entry merges only the keys it names (`enabled`/`exposure` by default) onto the server
  it modifies; the base's `mergeOverride` is the place an engine extends that list.
- A managed replacement drops the entries it was not given, except the ones the section reports through
  `keepsOnReplace` (pi's project overrides).
- A codec keeps the fields Morse does not edit: the existing entry (`kept`) is spread back into the
  encoded value, and every document key outside the section survives.

## Build and test

```bash
npm run build -w @morse/engine-config
npm run check-types -w @morse/engine-config
npm test -w @morse/engine-config
```

The package is built before the integrations (`build:libs`) and is part of `test:fast`.
See [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for where it sits and
[`docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md) for the user-facing behavior.
