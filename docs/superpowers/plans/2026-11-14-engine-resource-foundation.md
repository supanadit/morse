# Engine Resource Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the duplicated MCP and prompt-template codecs with one abstract, engine-generic foundation (`@morse/engine-config`) that global surfaces, bot layouts and future engines share.

**Architecture:** A new package owns the engine-free hierarchy: JSON/JSONC files, sections, config/file/composite resource stores, and an `EngineDefinition`/`EngineInstance` pair with user/project/isolated roots. `@morse/integration-pi` and `@morse/integration-opencode` subclass it with their formats, paths and trust rules. Global managers and bot layouts both drive the same stores. UI gains issues, a probe flag and a validated `configFix` action.

**Tech Stack:** TypeScript 6 (NodeNext), Node built-ins (`node:fs`, `node:path`), vitest 5, Angular 22 signals for the UI, the existing `yaml` package for pi prompt frontmatter.

**Spec:** `docs/superpowers/specs/2026-11-14-engine-resource-foundation-design.md`

## Global Constraints

- `@morse/system` stays pure TypeScript: no `node:fs`, no `@morse/engine-config` import. `@morse/protocol` stays dependency-free.
- Engine format knowledge stays in `@morse/integration-pi` and `@morse/integration-opencode`; the foundation has no MCP-format or prompt-format branches.
- No new runtime dependencies. `yaml` is already a pi dependency.
- No `pi`/`opencode` CLI invocation for MCP or prompt config reads/writes. The only spawned MCP process is a probe of the server itself.
- Bot files: directories `0700`, files `0600`, atomic temp-file-then-rename.
- `mcpServers` tri-state unchanged: absent leaves the file, present replaces the managed set, `[]` clears it.
- User JSONC is readable; a user-file write refuses until `normalize()` (Fix). Isolated (bot) files normalize on write.
- Preserve unknown keys and unknown entry fields; delete a section key when its last managed entry is removed.
- Every task ends with its own tests, a passing focused run, and a commit. Do not batch commits across tasks.

## Foundation Contracts

Every task uses these names and signatures. Later tasks do not redefine them.

```ts
// @morse/protocol — dto/config.ts
export type ConfigScope = 'global' | 'project';
export type ConfigIssueCode =
  | 'parse' | 'shape' | 'normalize' | 'name'
  | 'frontmatter' | 'read' | 'write' | 'unsupported';

export interface ConfigIssue {
  file: string;
  fileId: string;
  scope: ConfigScope;
  pointer?: string;
  code: ConfigIssueCode;
  message: string;
  snippet?: string;
  fixable: boolean;
}

export interface ConfigMutation {
  ok: boolean;
  message?: string;
  path?: string;
  scope?: ConfigScope;
  issues: ConfigIssue[];
}
```

```ts
// @morse/engine-config — core
export interface ConfigDocument {
  path: string;
  fileId: string;
  scope: ConfigScope;
  value: unknown;
  text: string;
  exists: boolean;
  strict: boolean;
  issues: ConfigIssue[];
}

export interface ConfigPaths {
  write: string;
  read: string[];
}

export interface WritePolicy {
  ownership: 'user' | 'isolated';
  fileMode?: number;
  dirMode?: number;
}

export abstract class ConfigFormat {
  abstract readonly kind: 'json' | 'jsonc';
  abstract parse(text: string, path: string, fileId: string, scope: ConfigScope): {
    value: unknown;
    strict: boolean;
    issues: ConfigIssue[];
  };
  abstract serialize(value: unknown): string;
}

export abstract class ConfigFile {
  readonly path: string;
  readonly fileId: string;
  readonly scope: ConfigScope;
  protected constructor(path: string, fileId: string, scope: ConfigScope, policy: WritePolicy);
  abstract format(): ConfigFormat;
  read(): ConfigDocument;
  write(value: unknown, options?: { normalize?: boolean }): ConfigMutation;
  normalize(): ConfigMutation;
  signature(): string;
}

export class JsonConfigFile extends ConfigFile {
  format(): ConfigFormat;
}

export interface SectionContext {
  file: string;
  fileId: string;
  scope: ConfigScope;
  issues: ConfigIssue[];
  pointer(...segments: string[]): string;
}

export abstract class ConfigSection<T> {
  abstract readonly key: string;
  abstract decode(raw: unknown, context: SectionContext): T;
  abstract encode(value: T, existing: unknown): unknown;
}

export abstract class NamedConfigSection<T> extends ConfigSection<Record<string, T>> {
  abstract decodeEntry(name: string, raw: unknown, context: SectionContext): T | undefined;
  abstract encodeEntry(item: T, kept: unknown): unknown;
  /** pi: an entry that only overrides enabled/exposure of a user-level server. */
  isOverride(raw: unknown): boolean { return false; }
  /** Entries that survive a managed-set replacement even when unlisted. */
  keepsOnReplace(raw: unknown): boolean { return false; }
}

export interface EngineContext {
  ownership: 'user' | 'isolated';
  home: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
  xdgConfigHome: string;
  xdgDataHome: string;
  root?: string;
}

/** The path/file resolver a store needs; `EngineInstance` is its full form. */
export interface ConfigLocator {
  readonly ownership: 'user' | 'isolated';
  paths(fileId: string, scope: ConfigScope, cwd?: string): ConfigPaths;
  file(fileId: string, scope: ConfigScope, cwd?: string): ConfigFile;
}

export abstract class EngineDefinition {
  abstract readonly kind: string;
  abstract create(context: EngineContext): EngineInstance;
  isolated(root: string, options?: { env?: NodeJS.ProcessEnv; home?: string }): EngineInstance;
}

export abstract class EngineInstance implements ConfigLocator {
  abstract readonly definition: EngineDefinition;
  abstract readonly context: EngineContext;
  abstract readonly ownership: 'user' | 'isolated';
  abstract paths(fileId: string, scope: ConfigScope, cwd?: string): ConfigPaths;
  abstract file(fileId: string, scope: ConfigScope, cwd?: string): ConfigFile;
  abstract readonly mcp: McpStore | undefined;
  abstract readonly prompts: PromptStore | undefined;
}
```

```ts
// @morse/engine-config — resources
export interface ResourceList<T> {
  items: T[];
  issues: ConfigIssue[];
}

export abstract class ResourceStore<TItem, TSave = TItem> {
  abstract list(cwd?: string): ResourceList<TItem>;
  abstract save(input: TSave, scope: ConfigScope, cwd?: string): ConfigMutation;
  abstract remove(
    name: string,
    scope: ConfigScope,
    cwd?: string,
    source?: string,
  ): ConfigMutation;
  abstract signature(cwd?: string): string;
}

export abstract class ConfigResourceStore<T, TItem = T>
  extends ResourceStore<TItem, T> {
  protected constructor(locator: ConfigLocator, fileId: string);
  abstract readonly section: NamedConfigSection<T>;
  /** Apply a managed set to an already-read document. Pure: never writes. */
  abstract apply(document: ConfigDocument, items: readonly T[]): {
    value: unknown;
    issues: ConfigIssue[];
  };
  replaceManaged(items: readonly T[], scope: ConfigScope, cwd?: string): ConfigMutation;
  normalize(scope: ConfigScope, cwd?: string): ConfigMutation;
}

export abstract class FileResourceStore<
  TItem extends { name: string; scope: ConfigScope },
  TSave extends { name: string; originalName?: string; originalScope?: ConfigScope },
> extends ResourceStore<TItem, TSave> {
  abstract dirs(cwd?: string): { global: string; project?: string };
  abstract readonly extension: string;
  /** `shadow`: project entries replace same-named global ones; `all`: keep both. */
  abstract readonly merge: 'shadow' | 'all';
  abstract decode(name: string, raw: string, path: string, scope: ConfigScope): TItem;
  abstract encode(input: TSave, context: { previousRaw?: string }): string;
}

export abstract class CompositeResourceStore<TItem, TSave>
  extends ResourceStore<TItem, TSave> {
  protected abstract children(): Array<{
    source: string;
    store: ResourceStore<TItem, TSave>;
  }>;
}

export interface McpServerEntry {
  server: McpServer;
  scope: ConfigScope;
  source: string;
  override?: string;
}

export abstract class McpStore extends ConfigResourceStore<McpServer, McpServerEntry> {
  list(cwd?: string): ResourceList<McpServerEntry>;
  setEnabled(
    name: string,
    enabled: boolean,
    scope: ConfigScope,
    cwd?: string,
  ): ConfigMutation;
  protected writeProjectOverride(
    name: string,
    enabled: boolean,
    cwd: string,
  ): ConfigMutation | undefined;
}

export interface PromptList extends ResourceList<PromptTemplate> {
  globalDir: string;
  projectDir?: string;
  trusted: boolean;
  configPath?: string;
}

export abstract class PromptStore
  extends ResourceStore<PromptTemplate, PromptTemplateInput> {
  abstract list(cwd?: string): PromptList;
}
```

```ts
// @morse/protocol — shared domain types
export interface McpServer {
  name: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  exposure?: McpExposure;
  description?: string;
}

// Existing McpServerInput becomes:
export interface McpServerInput extends Omit<McpServer, 'type'> {
  type?: 'stdio' | 'http';
  engine?: string;
  scope?: McpConfigScope;
}

// Existing PromptTemplateInfo is aliased to PromptTemplate:
export type PromptTemplateInfo = PromptTemplate;
```

## Review Focus

- A malformed server entry must not hide its siblings, and a corrupt file must not blank the rest of Edit bot.
- JSONC that OpenCode accepts must read; a user-file write must not silently drop comments, while a bot file must stay editable.
- Bot files stay `0700/0600`, and a corrupt `mcp.json` must abort before identity/settings are written.
- An OpenCode bot save writes its single `opencode.json` once; MCP replacement must not erase agents, providers, instructions or `$schema`.
- pi status must work with zero servers, with a hung server (bounded), and must keep the trust filter — without `pi mcp list`.

---

### Task 1: Package scaffold and shared protocol vocabulary

**Files:**
- Create: `packages/engine-config/package.json`
- Create: `packages/engine-config/tsconfig.json`
- Create: `packages/engine-config/vitest.config.ts`
- Create: `packages/engine-config/src/index.ts`
- Create: `packages/engine-config/src/core/scope.ts`
- Test: `packages/engine-config/src/core/scope.spec.ts`
- Create: `packages/protocol/src/dto/config.ts`
- Modify: `packages/protocol/src/dto/index.ts`
- Modify: `packages/protocol/src/dto/mcp.ts`
- Modify: `packages/protocol/src/dto/bot.ts`
- Modify: `packages/protocol/src/dto/prompt.ts`
- Modify: `packages/system/src/bot/types.ts`
- Modify: root `package.json`

**Interfaces:**
- Produces: `ConfigScope`, `ConfigIssue`, `ConfigMutation`, `McpServer`, `PromptTemplate`, `isConfigScope(value): value is ConfigScope`.
- Keeps: `McpConfigScope` as an alias of `ConfigScope`; `BotMcpServerInput` as an alias of `McpServer`; `BotMcpServer` as an alias of `McpServer`; `PromptTemplateInfo` as an alias of `PromptTemplate`.

- [ ] **Step 1: Write the failing scope test**

```ts
import { describe, expect, it } from 'vitest';
import { isConfigScope } from './scope.js';

describe('isConfigScope', () => {
  it('accepts the two scopes and nothing else', () => {
    expect(isConfigScope('global')).toBe(true);
    expect(isConfigScope('project')).toBe(true);
    expect(isConfigScope('user')).toBe(false);
    expect(isConfigScope(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -w @morse/engine-config -- src/core/scope.spec.ts`
Expected: FAIL — the package or `scope.js` does not exist.

- [ ] **Step 3: Create the package and the shared types**

`package.json` mirrors `packages/integration-pi/package.json` (same scripts, `type: module`, `main`/`types` on `dist`, `files: ["dist"]`), with `dependencies: { "@morse/protocol": "*" }` and devDependencies `@types/node`, `typescript`, `vitest`. `tsconfig.json` mirrors the integration tsconfig. `vitest.config.ts` mirrors the integration one with `include: ['src/**/*.spec.ts']`.

`scope.ts`:

```ts
import type { ConfigScope } from '@morse/protocol';

export function isConfigScope(value: unknown): value is ConfigScope {
  return value === 'global' || value === 'project';
}
```

Add the protocol types exactly as the Foundation Contracts block specifies. In `mcp.ts`, move `McpExposure`/`McpServer` into the shared area, make `McpStatus` gain `issues?: ConfigIssue[]` and `McpMutation` gain `issues?: ConfigIssue[]`, and keep `McpServerInput` as the input shape above. In `prompt.ts`, add `issues?: ConfigIssue[]` to `PromptTemplatesResult` and `PromptTemplateMutation`, rename `PromptTemplateInfo` to `PromptTemplate` and add `export type PromptTemplateInfo = PromptTemplate;`. In `bot.ts`, replace the `BotMcpServerInput` body with `export type BotMcpServerInput = McpServer;`. In system `types.ts`, replace `BotMcpServer` with `export type BotMcpServer = McpServer;` (import from protocol) and keep `BotMcpExposure`.

Root `package.json`: add `npm run build -w @morse/engine-config` to `build:libs` after `@morse/protocol`; add `npm run test -w @morse/engine-config` to `test:fast` after protocol.

- [ ] **Step 4: Run the checks**

Run: `npm test -w @morse/engine-config -- src/core/scope.spec.ts`
Expected: PASS (1 test).

Run: `npm run check-types -w @morse/engine-config && npm run check-types -w @morse/protocol && npm run check-types -w @morse/system`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/engine-config packages/protocol packages/system package.json
git commit -m "feat(engine): add the engine-config package and shared vocabulary"
```

---

### Task 2: JSON/JSONC file layer

**Files:**
- Create: `packages/engine-config/src/core/types.ts` (if Task 1 kept types inline, move them here)
- Create: `packages/engine-config/src/core/json-format.ts`
- Create: `packages/engine-config/src/core/config-file.ts`
- Create: `packages/engine-config/src/core/write.ts`
- Test: `packages/engine-config/src/core/json-format.spec.ts`
- Test: `packages/engine-config/src/core/config-file.spec.ts`
- Modify: `packages/engine-config/src/index.ts`

**Interfaces:**
- Consumes: `ConfigIssue`, `ConfigDocument`, `ConfigMutation`, `ConfigScope` from Task 1.
- Produces: `JsonFormat`, `JsonConfigFile`, `ConfigFile`, `WritePolicy`, and the JSONC parse result `{ value, strict, issues }`.

- [ ] **Step 1: Write the failing format tests**

```ts
import { describe, expect, it } from 'vitest';
import { JsonFormat } from './json-format.js';

const format = new JsonFormat();

describe('JsonFormat', () => {
  it('parses strict JSON with strict true', () => {
    const result = format.parse('{"a":1}', '/x.json', 'config', 'global');
    expect(result.value).toEqual({ a: 1 });
    expect(result.strict).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('parses comments and trailing commas, marking them non-strict and fixable', () => {
    const result = format.parse(
      '{\n  // note\n  "a": 1,\n}\n',
      '/x.json',
      'config',
      'global',
    );
    expect(result.value).toEqual({ a: 1 });
    expect(result.strict).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: 'normalize', fixable: true, file: '/x.json' });
  });

  it('reports a syntax error with a line and a bounded snippet', () => {
    const result = format.parse('{\n  "a":\n}', '/x.json', 'config', 'global');
    expect(result.value).toBeUndefined();
    expect(result.issues[0]).toMatchObject({ code: 'parse', fixable: false });
    expect(result.issues[0].message).toContain('/x.json');
    expect(result.issues[0].snippet).toContain('"a":');
  });

  it('serializes with two spaces and a trailing newline', () => {
    expect(format.serialize({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});
```

- [ ] **Step 2: Write the failing file tests**

```ts
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonConfigFile } from './config-file.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-config-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('JsonConfigFile', () => {
  it('refuses to write JSONC without normalize and writes strict JSON with it', () => {
    const dir = root();
    const path = join(dir, 'opencode.json');
    writeFileSync(path, '{\n  // keep?\n  "a": 1,\n}\n');
    const file = new JsonConfigFile(path, 'config', 'global', { ownership: 'user' });

    const refused = file.write({ a: 2 });
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({ code: 'normalize', fixable: true });
    expect(readFileSync(path, 'utf8')).toContain('// keep?');

    const fixed = file.normalize();
    expect(fixed.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
    expect(readFileSync(path, 'utf8')).not.toContain('// keep?');
  });

  it('writes isolated files 0600 inside a 0700 directory, atomically', () => {
    const dir = root();
    const path = join(dir, 'config', 'mcp.json');
    const file = new JsonConfigFile(path, 'mcp', 'global', { ownership: 'isolated' });
    expect(file.write({ mcpServers: {} }).ok).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'config')).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('reports a missing file as a read without issues', () => {
    const file = new JsonConfigFile(join(root(), 'none.json'), 'mcp', 'global', {
      ownership: 'user',
    });
    expect(file.read()).toMatchObject({ exists: false, strict: true, issues: [], value: undefined });
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npm test -w @morse/engine-config -- src/core/json-format.spec.ts src/core/config-file.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the format and file**

`JsonFormat.parse`: try `JSON.parse`; on failure, run `stripJsonc(text)` (remove `//` and `/* */` comments outside strings, then remove trailing commas before `}`/`]` outside strings), parse again. A successful strict parse yields `strict: true`, `issues: []`. A successful stripped parse yields `strict: false` and one `normalize` issue (`fixable: true`, message names the path and says comments/trailing commas will be dropped). A second failure yields `value: undefined`, `strict: true`, and one `parse` issue whose message is the native parser message plus the path, whose `snippet` is two lines around the reported offset (cap 400 chars), `fixable: false`.

`JsonConfigFile.read`: missing file → `{ exists:false, value:undefined, text:'', strict:true, issues:[] }`; otherwise read text, call `format().parse`.

`JsonConfigFile.write(value, options)`: read first; if the document is non-strict and `options?.normalize !== true` and the context is `ownership:'user'`, return `{ ok:false, issues:[normalizeRequired] }`; if isolated, proceed. Write `serialize(value)` via `writeAtomic(path, text, policy)`. Return `{ ok:true, path, scope, issues:[] }`.

`normalize()`: read; if the parse issue is present and unfixable, return `{ ok:false, issues }`; otherwise write the parsed value strictly.

`writeAtomic`: `mkdirSync(dirname(path), { recursive:true, mode: dirMode ?? 0o700 })` (only chmod a directory the call created; do not weaken an existing one), write a sibling `${path}.${process.pid}.${Date.now()}.tmp` with `mode: fileMode ?? 0o600` for isolated or `0o644` for user, then `renameSync`. Remove the temp on failure. For user files, preserve an existing file's mode when it exists.

`signature()`: `${size}:${mtimeMs}` or `'-'`.

- [ ] **Step 5: Run the tests and the package check**

Run: `npm test -w @morse/engine-config -- src/core/json-format.spec.ts src/core/config-file.spec.ts`
Expected: PASS (7 tests).

Run: `npm run check-types -w @morse/engine-config`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/engine-config
git commit -m "feat(engine): read JSONC and write config files atomically"
```

---

### Task 3: Sections, config stores and engine instances

**Files:**
- Create: `packages/engine-config/src/core/section.ts`
- Create: `packages/engine-config/src/core/config-store.ts`
- Create: `packages/engine-config/src/engine/context.ts`
- Create: `packages/engine-config/src/engine/locator.ts`
- Test: `packages/engine-config/src/core/config-store.spec.ts`
- Test: `packages/engine-config/src/engine/context.spec.ts`
- Modify: `packages/engine-config/src/index.ts`

**Interfaces:**
- Consumes: `JsonConfigFile`, `ConfigFormat` from Task 2.
- Produces: `ConfigSection`, `NamedConfigSection`, `ConfigStore`, `ConfigResourceStore`, `EngineContext`, `resolveEngineContext`, `ConfigLocator`, `ConfigPaths`.
- Does not produce `EngineDefinition`/`EngineInstance`; those arrive in Task 6 once `McpStore` (Task 5) and `PromptStore` (Task 4) exist. `ConfigLocator` is the interface stores accept.

- [ ] **Step 1: Write the failing store test**

Use a fake engine and a fake named section in the spec:

```ts
class FakeSection extends NamedConfigSection<{ label: string }> {
  readonly key = 'items';
  decodeEntry(name: string, raw: unknown): { label: string } | undefined {
    const row = raw as { label?: unknown };
    return typeof row?.label === 'string' ? { label: row.label } : undefined;
  }
  encodeEntry(item: { label: string }, kept: unknown): unknown {
    return { ...(kept as object), label: item.label };
  }
  keepsOnReplace(raw: unknown): boolean {
    return (raw as { keep?: boolean })?.keep === true;
  }
}
```

Assertions:

```ts
it('merges project over global by name and keeps a malformed sibling', () => {
  // global: { items: { a: { label: 'global-a' }, b: { label: 'global-b' } } }
  // project: { items: { a: { label: 'project-a' }, bad: 3 } }
  // list() -> items [{name:'a', item:{label:'project-a'}}, {name:'b',...}]
  // issues has one shape issue pointing at /items/bad
});

it('upserts into the named scope file and deletes an emptied block', () => {
  // upsert('project', {name:'c', item:{label:'c'}}) writes project file
  // remove('project','c') deletes the 'items' key when it was the last entry
});

it('replaceManaged removes unlisted entries but keeps kept-on-replace entries', () => {
  // file items: old, overridden {keep:true}
  // replaceManaged([{name:'new', item:{label:'new'}}])
  // file items: new, overridden
});

it('apply is pure and returns the next document value', () => {
  const before = readFileSync(path, 'utf8');
  const result = store.apply(store.file().read(), [{ name: 'new', item: { label: 'new' } }]);
  expect(result.value).toMatchObject({ items: { new: { label: 'new' } } });
  expect(readFileSync(path, 'utf8')).toBe(before);
});
```

- [ ] **Step 2: Write the failing context/locator test**

Use a fake `ConfigLocator` that returns one global file and one project file. Assert:

- `store.list()` reads project then global and merges by name.
- `paths('project', cwd).read` is project then global; `.write` is the project file.
- `paths('global', cwd).read` is global only.
- `resolveEngineContext` resolves `xdgConfigHome`/`xdgDataHome` from env with the documented defaults, and an isolated context carries `root` and `ownership:'isolated'`.
- `ConfigResourceStore` receives the locator, not an engine instance.

- [ ] **Step 3: Run them and watch them fail**

Run: `npm test -w @morse/engine-config -- src/core/config-store.spec.ts src/engine/context.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the section and store**

`NamedConfigSection.decode`: read the block (`raw`), require a non-array object; for each entry call `decodeEntry`; skip `undefined` and record a `shape` issue with `pointer(key, name)`. `encode`: map items to `encodeEntry(item, existing[name])`.

`ConfigResourceStore`:
- `paths(scope, cwd)` delegates to `locator.paths(fileId, scope, cwd)`.
- `readDocuments(cwd)`: read every read path; tag each issue with the path's scope (the project path is the first one when present; derive scope from the path list).
- `list(cwd)`: iterate documents highest-precedence first, decode entries, first name wins; call `toItem` (default `(item) => item`); collect issues.
- `save(input, scope, cwd)`: `upsert` semantics.
- `upsert(name, item, scope, cwd)`: read the target file, validate, apply the section with the existing kept entry, write; refused writes return issues.
- `remove(name, scope, cwd)`: read the target/defining file; remove; delete the block when empty; write.
- `replaceManaged(items, scope, cwd)`: read target; remove entries that define a value and are not in the set and are not `keepsOnReplace`; encode items; delete block when empty; write.
- `apply(document, items)`: pure — compute the next whole document value; used by `replaceManaged` and by the OpenCode bot layout.
- `normalize(scope, cwd)`: `file.normalize()` only for files that exist and are not already strict-and-clean (Task 2's no-op guard), for the write target and each read fallback; aggregate issues.

`resolveEngineContext` defaults `home` to `os.homedir()`, `xdgConfigHome` to `env.XDG_CONFIG_HOME ?? join(home,'.config')`, `xdgDataHome` to `env.XDG_DATA_HOME ?? join(home,'.local','share')`, and carries `root`. `ConfigLocator` is the interface in the contracts; no engine class yet.

- [ ] **Step 5: Run the tests and the package check**

Run: `npm test -w @morse/engine-config -- src/core/config-store.spec.ts src/engine/context.spec.ts`
Expected: PASS (7 tests).

Run: `npm run check-types -w @morse/engine-config`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/engine-config
git commit -m "feat(engine): add sections, config stores and engine context"
```

---

### Task 4: File and composite resource stores

**Files:**
- Create: `packages/engine-config/src/resource/resource-store.ts`
- Create: `packages/engine-config/src/resource/file-store.ts`
- Create: `packages/engine-config/src/resource/composite-store.ts`
- Create: `packages/engine-config/src/prompt/prompt-store.ts`
- Test: `packages/engine-config/src/resource/file-store.spec.ts`
- Test: `packages/engine-config/src/resource/composite-store.spec.ts`
- Modify: `packages/engine-config/src/index.ts`

**Interfaces:**
- Consumes: `ConfigMutation`, `ConfigIssue`, `ConfigScope`.
- Produces: `ResourceStore`, `FileResourceStore`, `CompositeResourceStore`, `PromptStore`, `PromptList`.
- Produces: `PromptTemplateInput` is the existing protocol type.

- [ ] **Step 1: Write the failing file-store test**

Use a fake `FileResourceStore<{ name:string; scope:ConfigScope; body:string; error?:string }, FakeSave>` with `.md` files. Assert:

```ts
it('lists both scopes and shadows global by name', () => {
  // global a.md, project a.md, global b.md -> a from project, b from global
});

it('keeps a broken file as an item with an error, not a list failure', () => {
  // decode returns { name, scope, body, error:'bad frontmatter' }
});

it('writes the new scope before deleting the old one on a move', () => {
  // save({ name:'x', originalName:'x', originalScope:'global' }, 'project')
  // project/x.md exists, global/x.md is gone
});

it('refuses a project save when there is no project directory', () => {
  // save(..., 'project') with no project dir -> ok:false, issues[0].code === 'unsupported'
});
```

- [ ] **Step 2: Write the failing composite test**

Two children: `source:'file'` and `source:'config'`. Assert list concatenates (file first), save routes by `input.source`, remove routes by `source`, and a duplicate name in each child appears twice.

- [ ] **Step 3: Run them and watch them fail**

Run: `npm test -w @morse/engine-config -- src/resource/file-store.spec.ts src/resource/composite-store.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the stores**

`FileResourceStore.list(cwd)`: read `global` then `project` dirs (`readdirSync`, only `extension`), decode each; `merge:'shadow'` keeps the last occurrence by name (project wins), `merge:'all'` concatenates. Sort by name for `shadow`. Issues from decode go on the item (`error`) or the list.

`save`: validate name with a hook `isValidName(name)` (abstract, default `^[A-Za-z0-9][A-Za-z0-9._-]*$`), resolve the target dir for the scope (missing project → unsupported issue), encode, write atomically (user policy), then if `originalName`/`originalScope` differ, delete the old file **after** the write. Never delete the target.

`remove`: resolve the dir, delete the file; missing → `ok:false` with a message.

`CompositeResourceStore`: list = children in order, concat; save = child whose `source` matches `(input as {source?:string}).source ?? 'file'`; remove = child named by `source ?? 'file'`; signature = join of child signatures.

`PromptStore` is the abstract typed contract; no behavior yet.

- [ ] **Step 5: Run the tests and the package check**

Run: `npm test -w @morse/engine-config -- src/resource/file-store.spec.ts src/resource/composite-store.spec.ts`
Expected: PASS (5 tests).

Run: `npm run check-types -w @morse/engine-config`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/engine-config
git commit -m "feat(engine): add file and composite resource stores"
```

---

### Task 5: MCP domain base

**Files:**
- Create: `packages/engine-config/src/mcp/mcp-section.ts`
- Create: `packages/engine-config/src/mcp/mcp-store.ts`
- Create: `packages/engine-config/src/mcp/names.ts`
- Test: `packages/engine-config/src/mcp/mcp-store.spec.ts`
- Modify: `packages/engine-config/src/index.ts`

**Interfaces:**
- Consumes: `ConfigResourceStore`, `NamedConfigSection`, `McpServer`, `McpServerEntry`.
- Produces: `McpStore`, `McpSection`, `McpServerEntry`, `isValidMcpServerName`, `assertMcpServerName`.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses reserved and malformed names, and skips a malformed entry with a pointer', () => {
  expect(isValidMcpServerName('filesystem_1-x')).toBe(true);
  expect(isValidMcpServerName('__proto__')).toBe(false);
  expect(isValidMcpServerName('a/b')).toBe(false);
  // list() with { good: {...}, bad: 3 } -> one item + issue pointer '/mcpServers/bad'
});

it('replaces the managed set, keeps override-only entries and unknown fields', () => {
  // existing: old {command:'x', auth:{token:'t'}}, pin {enabled:false}
  // replaceManaged([{name:'new',type:'stdio',command:'npx'}])
  // -> new {command:'npx', ...}; pin survives; old gone; auth on a kept entry survives
});

it('deletes the block when the last entry is removed', () => {
  // remove('only') -> file has no 'mcpServers' key
});

it('writes a project override only when the engine supports it', () => {
  // setEnabled('x', false, 'project') -> the hook's override path is used
  // a store without the hook -> ok:false with an unsupported issue
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -w @morse/engine-config -- src/mcp/mcp-store.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`names.ts`: regex `^[A-Za-z0-9_-]+$`; reserved `__proto__`, `prototype`, `constructor`; `assertMcpServerName` throws the message used today.

`McpSection extends NamedConfigSection<McpServer>` with abstract `decodeEntry`/`encodeEntry`; concrete `isOverride` defaults false.

`McpStore`:
- constructor `(engine, fileId, section)`.
- `list(cwd)`: read documents project-first; for each raw entry, skip invalid names with a `name` issue; decode; if `section.isOverride(raw)` and a base exists, merge enabled/exposure via `mergeOverride(base, item)` and set `override` to the source; otherwise the entry replaces the base. Return `McpServerEntry[]`.
- `save`/`upsert`: validate the name, then the base store.
- `remove`: base store.
- `replaceManaged`: base store's apply uses `keepsOnReplace`.
- `setEnabled`: if `scope === 'project'` and `writeProjectOverride` returns a mutation, use it; else update the defining entry (project first, then global) or return `No server named`.
- `writeProjectOverride` returns `undefined` by default; pi overrides it.
- `mergeOverride(base, override)` returns the base with `enabled`/`exposure` from the override; pi may extend it.

- [ ] **Step 4: Run the tests and the package check**

Run: `npm test -w @morse/engine-config -- src/mcp/mcp-store.spec.ts`
Expected: PASS (5 tests).

Run: `npm run check-types -w @morse/engine-config`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/engine-config
git commit -m "feat(engine): add the shared MCP store base"
```

---

### Task 6: pi engine definition and MCP store

**Files:**
- Create: `packages/engine-config/src/engine/definition.ts`
- Create: `packages/engine-config/src/engine/instance.ts`
- Create: `packages/integration-pi/src/engine/pi-engine.ts`
- Create: `packages/integration-pi/src/engine/pi-mcp-section.ts`
- Create: `packages/integration-pi/src/engine/pi-mcp-store.ts`
- Test: `packages/integration-pi/src/engine/pi-mcp-store.spec.ts`
- Test: `packages/integration-pi/src/engine/pi-engine.spec.ts`
- Modify: `packages/integration-pi/src/index.ts`
- Modify: `packages/integration-pi/package.json` (add `@morse/engine-config`)

**Interfaces:**
- Consumes: `EngineContext`, `ConfigLocator`, `McpStore`, `McpSection`, `McpServer`, `ConfigPaths`.
- Produces: `EngineDefinition`, `EngineInstance` (the generic base; now that `McpStore` exists), `PiEngineDefinition`, `PiEngineInstance`, `PiMcpStore`, `PiMcpSection`. It does not export `piAgentDir`/`piMcpPath`; `bot-layout.ts` keeps those public names.

- [ ] **Step 1: Write the failing engine-path test**

```ts
const engine = new PiEngineDefinition();
const user = engine.create(resolveEngineContext({ ownership:'user', home:'/home/me', cwd:'/work/app', env:{} }));
expect(user.paths('mcp','global')).toEqual({ read:['/home/me/.pi/agent/mcp.json'], write:'/home/me/.pi/agent/mcp.json' });
expect(user.paths('mcp','project')).toEqual({
  read:['/work/app/.pi/mcp.json','/home/me/.pi/agent/mcp.json'],
  write:'/work/app/.pi/mcp.json',
});
const bot = engine.isolated('/bots/x/config', { home:'/home/me' });
expect(bot.paths('mcp','global')).toEqual({ read:['/bots/x/config/mcp.json'], write:'/bots/x/config/mcp.json' });
expect(bot.context.ownership).toBe('isolated');
```

Also assert `PI_CODING_AGENT_DIR` overrides the user agent dir, and a project scope on an isolated instance returns an unsupported issue.

- [ ] **Step 2: Write the failing codec test**

Port every case from `packages/integration-pi/src/internal/mcp-config.ts`'s behavior:
- stdio round-trip `{type:'stdio',command:'npx',args:[...],env,cwd,exposure,description}`;
- http round-trip `{type:'http',url,headers}`;
- `enabled:false` preserved, `enabled:true` dropped;
- unknown fields (`oauth`, `toolExposure`, `timeout`) survive a rewrite;
- override-only entry `{enabled:false}` is kept by `replaceManaged` and merges onto the global server;
- malformed entry is skipped with an issue and siblings list;
- a project definition shadows a global one; a project override does not hide the global command.

- [ ] **Step 3: Run and watch them fail**

Run: `npm test -w @morse/integration-pi -- src/engine`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`engine-config/src/engine/definition.ts`: `EngineDefinition.isolated(root, options)` builds `resolveEngineContext({ ownership:'isolated', root, env: options?.env, home: options?.home })` and calls `create`. `engine-config/src/engine/instance.ts`: `abstract class EngineInstance implements ConfigLocator` with `definition`, `context`, `ownership`, abstract `paths`/`file`, and abstract `mcp: McpStore | undefined` / `prompts: PromptStore | undefined`. Both are exported from `@morse/engine-config`.

`PiEngineDefinition`:
- `kind = 'pi'`.
- `create(context)`: `new PiEngineInstance(this, context)`.
- `PiEngineInstance` resolves the agent dir as `context.ownership === 'isolated' ? context.root! : (env.PI_CODING_AGENT_DIR || join(home,'.pi','agent'))`, project dir as `<cwd>/.pi`, global file `<agentDir>/mcp.json`, project file `<cwd>/.pi/mcp.json`. `paths` returns read precedence `[project, global]` (project first) and write = project for `'project'`, global for `'global'`. Isolated `'project'` returns a `ConfigIssue`-carrying unsupported `ConfigPaths` or throws `UnsupportedScopeError`; use a typed error and catch it in the store.
- `mcp = new PiMcpStore(this)`.
- `prompts` is `undefined` until Task 8.

`PiMcpSection`:
- key `mcpServers`; decode infers type (`type:'http'` or a `url` without `command`), requires a non-empty command/url, maps `args`, `env`, `cwd`, `headers`, `exposure`, `enabled !== false`.
- encode: pi's shape; omit `enabled` when true; unknown fields preserved; `description` preserved from the neutral server when present (add `description` to `McpServer` if Task 1 did not).
- `isOverride(raw)`: no `command`, no `url`, no `type`.
- `keepsOnReplace(raw)`: `isOverride(raw)`.
- Invalid entries return `undefined` with a `shape` issue naming the server and the missing field.

`PiMcpStore`:
- `mergeOverride(base, override)`: apply `enabled` and `exposure` (and leave command/url/env/headers from base).
- `writeProjectOverride(name, enabled, cwd)`: write `{enabled}` when the server is known globally; enabling removes the override and deletes an empty entry.

- [ ] **Step 5: Run the tests and the package checks**

Run: `npm test -w @morse/integration-pi -- src/engine`
Expected: PASS (the ported cases plus the path tests).

Run: `npm run check-types -w @morse/integration-pi`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/integration-pi
git commit -m "feat(pi): define the pi engine and its MCP store"
```

---

### Task 7: pi MCP manager, status and probe (remove `pi mcp list`)

**Files:**
- Modify: `packages/integration-pi/src/pi-mcp.ts`
- Test: `packages/integration-pi/src/pi-mcp.spec.ts`
- Modify: `packages/integration-pi/src/create-pi-rpc-adapter.ts`
- Modify: `packages/integration-pi/src/index.ts`
- Modify: `packages/system/src/session/integration.ts` (status options)
- Modify: `packages/integration-opencode/src/opencode-engine.ts` (status signature only)

**Interfaces:**
- Consumes: `PiEngineDefinition`, `PiMcpStore` from Task 6; `McpInspector`/`inspect` from `internal/mcp-client`.
- Produces: `PiMcp` with `status(cwd?, options?: { probe?: boolean })`; `add`, `remove`, `setEnabled`, `trustProject`, `configSignature` delegate to the store.
- Produces: `AgentMcpExtras.status(cwd?: string, options?: { probe?: boolean }): Promise<unknown>`.

- [ ] **Step 1: Write the failing status tests**

```ts
it('lists configured servers without a working pi binary', async () => {
  // seed agentDir/mcp.json with one server
  // new PiMcp({ agentDir, piPath: '/nonexistent/pi' })
  const status = await mcp.status(cwd);
  expect(status.servers[0]).toMatchObject({ name:'one', state:'connecting', enabled:true });
  expect(status.note).toMatch(/configured files only/);
});

it('probes enabled servers and fills tools', async () => {
  // inject a fake inspector returning { ok:true, tools:[{name:'read'}] }
  const status = await mcp.status(cwd, { probe:true });
  expect(status.servers[0]).toMatchObject({ state:'connected', tools:['read'] });
  expect(inspector.inspect).toHaveBeenCalledTimes(1);
});

it('does not probe a disabled server and reports its disabled state', async () => {
  // enabled:false -> state:'disabled', inspector not called
});

it('keeps the project trust filter and reports untrusted', async () => {
  // project .pi/mcp.json server + no trust -> not listed, trusted:false
});

it('aborts the probe budget without failing the list', async () => {
  // inspector never resolves; status({probe:true}) settles with the configured rows
  // within the test's budget, state stays 'connecting' or 'disconnected', no throw
});
```

Port all add/remove/setEnabled cases from the existing `pi-mcp.spec.ts`. Remove or replace the `pi mcp list` CLI tests.

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -w @morse/integration-pi -- src/pi-mcp.spec.ts`
Expected: FAIL — the new status shape/options do not exist.

- [ ] **Step 3: Implement**

`PiMcp` keeps its constructor options (`piPath`, `nodeEntryPath`, `env`, `agentDir`, `timeoutMs`) for compatibility, but status no longer calls `resolvePiCli`/`execFile`. Build a `PiEngineDefinition` per call with the injected `agentDir` as an isolated root when it is set; otherwise user mode with `cwd`. `status(cwd, { probe })`:
- `const list = store.list(cwd)`; map entries to `McpServerStatus` (`scope`, `source`, `enabled`, `exposure`, `transport`, `state:'connecting'|'disabled'`, `tools:[]`, `override`).
- Add `errors` from `list.issues.map(i => i.message)` and `issues`.
- If `probe`, run `Promise.allSettled` over enabled servers with a concurrency limit of 3 and a per-server 10 s timeout; map `McpInspectionResult` to `connected` + tools/resources, or `failed`/`needs-auth` + `error`. A timeout leaves the row `disconnected` and adds an issue, not a thrown error.
- `trusted` uses `readProjectTrust`; if untrusted, filter project entries and don't probe them.
- `note` says configured files only and that a probe fills live state.

Add/remove/setEnabled use the store; keep the same `McpMutation` shapes (`ok`, `message`, `path`, `scope`, `override`, `issues`). `configSignature` uses the store's files.

Update the adapter: `status: (cwd, options) => this.mcp.status(cwd, options)` and extend `AgentMcpExtras.status` in system to accept the options. Update the OpenCode adapter's `status` to accept and ignore the options so both satisfy the port.

- [ ] **Step 4: Run the tests and checks**

Run: `npm test -w @morse/integration-pi -- src/pi-mcp.spec.ts`
Expected: PASS (the ported cases plus the five status tests).

Run: `npm run check-types -w @morse/integration-pi`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/integration-pi
git commit -m "feat(pi): list MCP servers from files and probe them"
```

---

### Task 8: pi prompt store and manager

**Files:**
- Create: `packages/integration-pi/src/engine/pi-prompt-store.ts`
- Modify: `packages/integration-pi/src/pi-prompts.ts`
- Modify: `packages/integration-pi/src/engine/pi-engine.ts`
- Test: `packages/integration-pi/src/engine/pi-prompt-store.spec.ts`
- Test: `packages/integration-pi/src/pi-prompts.spec.ts`
- Modify: `packages/integration-pi/src/index.ts`

**Interfaces:**
- Consumes: `FileResourceStore`, `PromptStore`, `PromptTemplate`, `PromptTemplateInput`; `parsePromptTemplate` from `internal/prompt-frontmatter`.
- Produces: `PiPromptStore`; `PiEngineInstance.prompts`.

- [ ] **Step 1: Write the failing store tests**

- global and project dirs resolve to `<agentDir>/prompts` and `<cwd>/.pi/prompts`;
- a project file shadows a global one by name;
- invalid YAML frontmatter lists the item with `error` and refuses to save with pi's message;
- save writes the new file then deletes the old one on a scope move;
- delete removes only the target file;
- `trusted` mirrors `readProjectTrust` with no project → `false`.

Then port every case from `pi-prompts.spec.ts` against `PiPrompts` delegating to the store.

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -w @morse/integration-pi -- src/engine/pi-prompt-store.spec.ts src/pi-prompts.spec.ts`
Expected: FAIL — modules not found / manager not delegating.

- [ ] **Step 3: Implement**

`PiPromptStore extends FileResourceStore<PromptTemplate, PromptTemplateInput>`:
- `dirs(cwd)` → `{ global: join(agentDir,'prompts'), project: cwd ? join(cwd,'.pi','prompts') : undefined }`;
- `extension = '.md'`; `merge = 'shadow'`;
- `decode` uses `parsePromptTemplate` and returns `{ name, scope, path, raw, body, description, argumentHint, error? }`;
- `encode` validates with `parsePromptTemplate` and returns the raw composed by the editor (prompt templates are already composed by the frontend);
- `trusted` for the list comes from the engine instance's trust reader; `PiPromptStore.list` adds `globalDir`, `projectDir`, `trusted`.

`PiPrompts` keeps its constructor and API (`list`, `save`, `delete`, `configSignature`) but delegates to the store created from `PiEngineDefinition` with the injected `agentDir`. `PiEngineInstance.prompts = new PiPromptStore(this)`.

- [ ] **Step 4: Run tests and checks**

Run: `npm test -w @morse/integration-pi -- src/engine/pi-prompt-store.spec.ts src/pi-prompts.spec.ts`
Expected: PASS.

Run: `npm run check-types -w @morse/integration-pi`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/integration-pi
git commit -m "feat(pi): move prompt templates onto the shared file store"
```

---

### Task 9: pi bot layout MCP migration

**Files:**
- Modify: `packages/integration-pi/src/bot-layout.ts`
- Test: `packages/integration-pi/src/bot-layout.spec.ts`
- Modify: `packages/integration-pi/src/index.ts`

**Interfaces:**
- Consumes: `PiEngineDefinition.isolated(piAgentDir(botRoot))`, `PiMcpStore`.
- Produces: the same `piAgentDir`, `piMcpPath`, `piBotLayout` exports; no bot-only MCP codec.

- [ ] **Step 1: Keep the existing bot MCP tests as the gate**

Run them first:
`npm test -w @morse/integration-pi -- src/bot-layout.spec.ts`
Expected: PASS on the old implementation (baseline).

Add:

```ts
it('parses mcp.json before writing anything, so a corrupt file aborts the update', () => {
  // seed auth/settings/SYSTEM/AGENTS sentinels and a corrupt mcp.json
  // expect writePiBotConfig(...) to throw
  // every sentinel is byte-identical afterwards
});
```

- [ ] **Step 2: Replace the bot codec**

`writePiBotConfig`:
- Build `const engine = new PiEngineDefinition().isolated(piAgentDir(botRoot), { env: ... })`.
- Parse the MCP file first when `config.mcpServers !== undefined` (`engine.mcp!.file('mcp','global').read()`), and keep the document.
- Write auth/models/settings/SYSTEM/AGENTS as today.
- For MCP: if `mcpServers === undefined` leave the file; if `[]` call `replaceManaged([], 'global')`; otherwise `replaceManaged(config.mcpServers, 'global')`. The store writes the same file, so parsing first preserves the abort-before-write property.
- Delete `readPiMcpServers`, `writePiMcpServers`, `piMcpEntry` and their imports; `piBotLayout.read` uses `engine.mcp!.list()` and maps entries to `BotEngineState.mcpServers` (omit the key when the file is missing/unreadable, as today).

- [ ] **Step 3: Run the tests**

Run: `npm test -w @morse/integration-pi -- src/bot-layout.spec.ts`
Expected: PASS, including the new corrupt-file test and every prior MCP case.

Run: `npm run check-types -w @morse/integration-pi`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/integration-pi
git commit -m "refactor(pi): use the shared MCP store for bot configuration"
```

---

### Task 10: OpenCode engine definition and MCP store

**Files:**
- Create: `packages/integration-opencode/src/engine/open-code-engine.ts`
- Create: `packages/integration-opencode/src/engine/open-code-mcp-section.ts`
- Create: `packages/integration-opencode/src/engine/open-code-mcp-store.ts`
- Create: `packages/integration-opencode/src/engine/config-discovery.ts`
- Test: `packages/integration-opencode/src/engine/open-code-mcp-store.spec.ts`
- Test: `packages/integration-opencode/src/engine/config-discovery.spec.ts`
- Modify: `packages/integration-opencode/src/index.ts`
- Modify: `packages/integration-opencode/package.json` (add `@morse/engine-config`)

**Interfaces:**
- Consumes: `EngineDefinition`, `EngineInstance`, `McpStore`, `McpSection`, JSONC file layer.
- Produces: `OpenCodeEngineDefinition`, `OpenCodeEngineInstance`, `OpenCodeMcpStore`, `OpenCodeMcpSection`, `discoverOpenCodeConfigPaths`. The new discovery name avoids colliding with the old `openCodeConfigPaths` still used by the pre-migration manager; the old module is deleted only after Task 11's port.

- [ ] **Step 1: Write the failing discovery tests**

```ts
it('finds json and jsonc in the global config dir, jsonc winning', () => {
  // <xdg>/opencode/opencode.json + opencode.jsonc -> read [jsonc, json]
  // write target = jsonc
});

it('finds project configs from the workspace and .opencode, nearest first', () => {
  // /repo/opencode.json, /repo/.opencode/opencode.jsonc, /repo/app/opencode.json
  // cwd /repo/app -> app first, then .opencode, then repo, then global
});

it('returns one file for an isolated root', () => {
  // root /bots/x/config -> /bots/x/config/opencode/opencode.json[c]
});
```

- [ ] **Step 2: Write the failing codec tests**

- `local` entry `{type:'local',command:['npx','one'],environment:{A:'1'},cwd:'/w'}` ↔ neutral `{type:'stdio',command:'npx',args:['one'],env:{A:'1'},cwd:'/w'}`;
- `remote` entry `{type:'remote',url,headers}` ↔ neutral http;
- `enabled:false` preserved; `enabled:true` dropped;
- unknown fields (`oauth`, `timeout`) survive;
- malformed entry (`type:'local'` with a string command, or missing url) is skipped with a pointer issue, siblings list;
- a project entry replaces a same-named global one;
- `replaceManaged` removes every unlisted entry (no override concept).

- [ ] **Step 3: Run and watch them fail**

Run: `npm test -w @morse/integration-opencode -- src/engine`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`config-discovery.ts`: given `EngineContext` and `cwd`, return `ConfigPaths` for `'config'`:
- isolated: `<root>/opencode/opencode.json` and `.jsonc` (read both, `.jsonc` first), write the existing one or `.json`.
- user global: `<xdgConfigHome>/opencode/opencode.json[c]`.
- project: walk from `cwd` to the filesystem root, collecting `opencode.json[c]` and `.opencode/opencode.json[c]`; nearest first, `.jsonc` before `.json` within a directory; append global last. Write target = the nearest existing project file, else `<cwd>/opencode.json`.
- Skip the home directory's `opencode.json` at the root? Do not overreach: stop at the filesystem root, but do not include `.opencode` under `$HOME` unless it is an ancestor of cwd; tests pin the exact list.

`OpenCodeEngineInstance`: `paths('mcp', scope, cwd)` = config discovery; `file` uses `JsonConfigFile`; `mcp = new OpenCodeMcpStore(this)`.

`OpenCodeMcpSection`: key `mcp`; decode/encode as above; `enabled:true` dropped; invalid entries return `undefined` with issues.

`OpenCodeMcpStore`: no overrides; `mergeOverride` inherited (never used); `replaceManaged` removes all unlisted.

- [ ] **Step 5: Run tests and checks**

Run: `npm test -w @morse/integration-opencode -- src/engine`
Expected: PASS.

Run: `npm run check-types -w @morse/integration-opencode`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/integration-opencode
git commit -m "feat(opencode): define the engine and its JSONC-aware MCP store"
```

---

### Task 11: OpenCode MCP manager and status

**Files:**
- Modify: `packages/integration-opencode/src/opencode-mcp.ts`
- Test: `packages/integration-opencode/src/opencode-mcp.spec.ts`
- Modify: `packages/integration-opencode/src/opencode-engine.ts` (adapter plumbing)

**Interfaces:**
- Consumes: `OpenCodeEngineDefinition`, `OpenCodeMcpStore`.
- Produces: `OpenCodeMcp.status(cwd?)` with `issues`, `add`, `remove`, `setEnabled`, `trustProject`, `configSignature`.

- [ ] **Step 1: Port the tests and add JSONC cases**

Keep every case in `opencode-mcp.spec.ts`. Add:

```ts
it('reads a JSONC config and reports a fixable issue', () => {
  // global opencode.json with comments + trailing comma
  const status = mcp.status(cwd);
  expect(status.servers.map(s => s.name)).toEqual(['one']);
  expect(status.issues?.[0]).toMatchObject({ code:'normalize', fixable:true });
});

it('refuses a mutation on JSONC until fixed, then writes', () => {
  // add -> ok:false, normalizeRequired
  // fix -> ok:true, file is strict JSON, add -> ok:true
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -w @morse/integration-opencode -- src/opencode-mcp.spec.ts`
Expected: FAIL on the new JSONC expectations.

- [ ] **Step 3: Implement**

`OpenCodeMcp` builds an engine instance from `{ configDir }` (keep the option; treat it as the OpenCode config dir: `<configDir>/opencode.json[c]`). `status` lists from the store, maps entries to `McpServerStatus` (`state: disabled|disconnected`, `tools: []`, `transport`), sets `trusted:true`, the existing note, `errors` from issues and `issues`. `add/remove/setEnabled` delegate; JSONC writes return the normalize issue. `fix(scope, cwd)` (or `normalize`) is exposed for the host. `configSignature` uses the store's files.

Update `opencode-engine.ts` wrappers to pass through the new status/options/`fix`.

- [ ] **Step 4: Run tests and checks**

Run: `npm test -w @morse/integration-opencode -- src/opencode-mcp.spec.ts`
Expected: PASS.

Run: `npm run check-types -w @morse/integration-opencode`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/integration-opencode
git commit -m "feat(opencode): serve MCP through the shared store"
```

---

### Task 12: OpenCode prompt store and manager

**Files:**
- Create: `packages/integration-opencode/src/engine/open-code-prompt-store.ts`
- Create: `packages/integration-opencode/src/engine/open-code-command-section.ts`
- Modify: `packages/integration-opencode/src/opencode-prompts.ts`
- Modify: `packages/integration-opencode/src/engine/open-code-engine.ts`
- Test: `packages/integration-opencode/src/engine/open-code-prompt-store.spec.ts`
- Test: `packages/integration-opencode/src/opencode-prompts.spec.ts`

**Interfaces:**
- Consumes: `CompositeResourceStore`, `FileResourceStore`, `ConfigResourceStore`, `PromptStore`.
- Produces: `OpenCodePromptStore`; `OpenCodeEngineInstance.prompts`.

- [ ] **Step 1: Write the failing store tests**

- file commands: global `<configDir>/commands/*.md`, project `<cwd>/.opencode/commands/*.md`; project and global rows both appear (`merge:'all'`);
- config commands: the global `command` key rows appear as `source:'config'`, `scope:'global'`;
- a JSONC global config lists its commands and reports a fixable issue;
- save routes by `source`; delete routes by `source`;
- renaming a file command writes the new file then deletes the old;
- a config command rename deletes the old key and inserts the new one;
- an invalid config command (`template` missing) is skipped with an issue, siblings list.

Port every case from `opencode-prompts.spec.ts` and `internal/opencode-prompts-config.spec.ts`.

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -w @morse/integration-opencode -- src/engine/open-code-prompt-store.spec.ts src/opencode-prompts.spec.ts`
Expected: FAIL — modules not found / manager not delegating.

- [ ] **Step 3: Implement**

`OpenCodeFilePromptStore extends FileResourceStore<PromptTemplate, PromptTemplateInput>` with `merge:'all'`, `.md`, dirs above, decode via the existing frontmatter parser, encode from `raw`.

`OpenCodeCommandSection extends NamedConfigSection<PromptTemplate>` key `command`; decode returns `{name, scope:'global', source:'config', entry, description}`; encode writes the `entry`; validate `template`.

`OpenCodeConfigPromptStore extends ConfigResourceStore<PromptTemplate, PromptTemplate>` for the global config only.

`OpenCodePromptStore extends CompositeResourceStore<PromptTemplate, PromptTemplateInput>` with children file then config; `list` adds `globalDir`, `projectDir`, `trusted:true`, `configPath`; `save` defaults to `source:'file'`; `remove` routes.

`OpenCodePrompts` keeps its API and delegates. Keep `composeCommandFile`/`parseCommandFile` exports.

- [ ] **Step 4: Run tests and checks**

Run: `npm test -w @morse/integration-opencode -- src/engine/open-code-prompt-store.spec.ts src/opencode-prompts.spec.ts`
Expected: PASS.

Run: `npm run check-types -w @morse/integration-opencode`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/integration-opencode
git commit -m "refactor(opencode): move prompt templates onto the shared stores"
```

---

### Task 13: OpenCode bot layout MCP migration

**Files:**
- Modify: `packages/integration-opencode/src/bot-layout.ts`
- Test: `packages/integration-opencode/src/bot-layout.spec.ts`

**Interfaces:**
- Consumes: `OpenCodeEngineDefinition.isolated(join(botRoot,'config'))`, `OpenCodeMcpStore.apply`.
- Produces: the same `openCodeConfigPath`, `openCodeBotLayout`, `writeOpenCodeBotConfig` exports; one write per save.

- [ ] **Step 1: Add the failing single-write test**

```ts
it('writes the bot config once, keeping agents, providers and instructions', () => {
  // seed opencode.json with agents.build, provider.acme, instructions
  // write a bot with mcpServers
  // read the file: all seeded keys survive and mcp has the new server
  // seed a corrupt mcp-only rewrite candidate is covered by the abort test below;
  // a second writer for this path would drop agents/provider and fail this test
});

it('aborts before writing when the existing config is corrupt', () => {
  // seed a parse-invalid opencode.json and sentinel workspace/AGENTS.md
  // expect writeOpenCodeBotConfig to throw and the workspace file unchanged
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -w @morse/integration-opencode -- src/bot-layout.spec.ts`
Expected: the new test fails on the write count or the composition.

- [ ] **Step 3: Implement**

`writeOpenCodeBotConfig`:
- `const engine = new OpenCodeEngineDefinition().isolated(join(botRoot,'config'))`.
- Read the config document once (`engine.file('config','global').read()`).
- Apply MCP via `engine.mcp!.apply(document, config.mcpServers)` (tri-state: absent leaves `mcp`, `[]` returns a value with no `mcp` key).
- Compose the rest (`$schema`, `username`, `default_agent`, `agents`, `provider`, `instructions`) exactly as today, then write once.
- Remove `readOpenCodeMcp`, `openCodeMcpEntry`, `openCodeMcpEntry` imports; `read` uses `engine.mcp!.list()` and maps entries.
- No second write for the same path.

- [ ] **Step 4: Run the tests and checks**

Run: `npm test -w @morse/integration-opencode -- src/bot-layout.spec.ts`
Expected: PASS, including every prior MCP case.

Run: `npm run check-types -w @morse/integration-opencode`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/integration-opencode
git commit -m "refactor(opencode): use the shared MCP store for bot configuration"
```

---

### Task 14: Protocol and host plumbing for issues, probe and Fix

**Files:**
- Modify: `packages/system/src/session/integration.ts`
- Modify: `packages/integration-pi/src/create-pi-rpc-adapter.ts`
- Modify: `packages/integration-opencode/src/opencode-engine.ts`
- Modify: `packages/protocol/src/wire/host.ts`
- Modify: `packages/server/src/internal/ws/session-factory.service.ts`
- Modify: `packages/extension/src/internal/vscode/chat-view-provider.ts`
- Modify: `packages/ui-angular/src/app/state/mcp-state.ts`
- Modify: `packages/ui-angular/src/app/state/prompt-templates-state.ts`
- Test: `packages/server/src/internal/ws/session-factory.service.spec.ts`
- Test: `packages/ui-angular/src/app/state/mcp-state.spec.ts`

**Interfaces:**
- Consumes: `ConfigIssue`, `ConfigMutation`, `McpStatus.issues`, the pi/OpenCode managers' `status(cwd, {probe})` and `fix`.
- Produces: `AgentExtras.fix?(request)`, host command `configFix`, `McpState.fix/probe`, `PromptTemplatesState.fix`.

- [ ] **Step 1: Write the failing host tests**

- `mcpStatus` with `{ probe: true }` passes `{ probe:true }` to the engine extras; without it passes `undefined`/false.
- `configFix` rejects a path outside the engine's resolved candidate set.
- `configFix` calls `extras.fix({ fileId, path, scope, cwd })` for a valid path.
- an engine without `fix` returns an unsupported-host error.

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -w @morse/server -- session-factory`
Expected: FAIL — the command/type does not exist.

- [ ] **Step 3: Implement the protocol/host**

- `AgentExtras.fix?(request: { fileId: string; path: string; scope: string; cwd?: string }): Promise<unknown>`.
- Add `'configFix'` to `HostCommand`.
- Server handler: resolve the engine extras (`this.router.extrasFor` via the existing `mcpFor`/new `extrasFor` helper), require `fix`, pass the args. The integration's `fix` validates `path` against its engine's `paths(fileId, scope, cwd)` (write + read fallbacks) and returns a `ConfigMutation`.
- Extension handler: add `configFix` → `UnsupportedByHostError` (its MCP/prompt capability is off today).
- pi/OpenCode adapters implement `fix` by calling the manager's `normalize` for the matching fileId.
- `McpState`: parse `issues`; add `probe(cwd)` that calls `mcpStatus` with `probe:true` and updates the cache; `refresh` calls the fast status then fires `probe` in the background (no await); `fix(cwd, issue)` calls `configFix` with the issue's `fileId`, `file`, `scope`, `cwd` and refreshes.
- `PromptTemplatesState`: parse `issues`; `fix(issue)` calls `configFix` and refreshes.

- [ ] **Step 4: Run the tests and checks**

Run: `npm test -w @morse/server -- session-factory`
Expected: PASS.

Run: `npm test -w @morse/ui-angular -- --include '**/mcp-state.spec.ts' --watch=false`
Expected: PASS, including the new probe/fix cases.

Run: `npm run check-types -w @morse/server && npm run check-types -w @morse/extension && npm run check-types -w @morse/ui-angular`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol packages/system packages/server packages/extension packages/integration-pi packages/integration-opencode packages/ui-angular
git commit -m "feat(host): expose MCP issues, probing and config fix"
```

---

### Task 15: MCP panel and prompt editor Fix UI

**Files:**
- Modify: `packages/ui-angular/src/app/features/mcp-panel/mcp-panel.ts`
- Modify: `packages/ui-angular/src/app/features/mcp-panel/mcp-panel.html`
- Modify: `packages/ui-angular/src/app/features/mcp-panel/mcp-panel.css`
- Modify: `packages/ui-angular/src/app/features/prompt-editor/prompt-editor.ts`
- Modify: `packages/ui-angular/src/app/features/prompt-editor/prompt-editor.html`
- Modify: `packages/ui-angular/src/app/features/prompt-editor/prompt-editor.css`
- Test: `packages/ui-angular/src/app/features/mcp-panel/mcp-panel.spec.ts`
- Test: `packages/ui-angular/src/app/features/prompt-editor/prompt-editor.spec.ts`

**Interfaces:**
- Consumes: `McpState.issues/fix`, `PromptTemplatesState.issues/fix`, `ConfigIssue`.
- Produces: a Fix button per fixable issue, a bounded snippet, and a "fixing…" state.

- [ ] **Step 1: Write the failing panel test**

```ts
it('shows a parse issue with a snippet and fixes it', async () => {
  // status with issues: [{ file:'/c/opencode.json', fileId:'config', scope:'global',
  //   code:'normalize', message:'uses comments', snippet:'"a": 1,', fixable:true }]
  // expect the message, the snippet, a Fix button
  // click -> configFix called with { engine, fileId:'config', path:'/c/opencode.json',
  //   scope:'global', cwd }
  // refresh called after ok
});
```

Add a negative case: `fixable:false` renders no button.

- [ ] **Step 2: Write the failing prompt-editor test**

The editor shows the list-level issues and offers Fix when `fixable`, calling `configFix`; a failed fix shows the message.

- [ ] **Step 3: Run and watch them fail**

Run: `npm test -w @morse/ui-angular -- --include '**/mcp-panel.spec.ts' --watch=false`
Expected: FAIL — no issue UI.

Run: `npm test -w @morse/ui-angular -- --include '**/prompt-editor.spec.ts' --watch=false`
Expected: FAIL — no issue UI.

- [ ] **Step 4: Implement the UI**

Panel: replace the plain `errors` block with an issues block: message, pointer (when present), `<pre class="snippet">`, and a Fix button when `fixable`; keep the legacy `errors` text when there are no issues. Add a `fixing` signal and disable the button while running. Use the existing `.errors` styling and add `.snippet`/`.fix` rules.

Prompt editor: add an issues block above the list (same component pattern) with Fix. Reuse the status-row error styling; do not add global CSS or dependencies.

- [ ] **Step 5: Run the tests and the UI checks**

Run: `npm test -w @morse/ui-angular -- --include '**/mcp-panel.spec.ts' --watch=false`
Expected: PASS.

Run: `npm test -w @morse/ui-angular -- --include '**/prompt-editor.spec.ts' --watch=false`
Expected: PASS.

Run: `npm run check-types -w @morse/ui-angular`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-angular
git commit -m "feat(ui): show config issues and offer a fix action"
```

---

### Task 16: Documentation and whole-suite verification

**Files:**
- Modify: `docs/CONFIGURATION.md`
- Create: `packages/engine-config/README.md`
- Modify: `docs/superpowers/specs/2026-11-14-bot-mcp-design.md` (mark the global-MCP non-goal superseded)
- Modify: `docs/superpowers/specs/2026-11-13-bot-mode-design.md` if it repeats engine file paths that changed
- Modify: `docs/STATUS.md` only if it tracks the current work (do not bump the version)

**Interfaces:**
- Consumes: the implemented package and commands.
- Produces: accurate docs and the final gate evidence.

- [ ] **Step 1: Write the docs**

`packages/engine-config/README.md`: the four extension steps from the design, the hierarchy, the issue/Fix contract, and the rule that engine formats stay in integration packages.

`docs/CONFIGURATION.md`: update the MCP section to state:
- both MCP managers read JSON/JSONC; `.jsonc` and project discovery for OpenCode;
- Fix normalizes a user JSONC file (comments/trailing commas dropped) and validates the path;
- pi status lists configured files and probes enabled servers; extension-registered servers are not listed;
- bot files are private `0700/0600` and normalize JSONC on write;
- prompt templates share the same foundation (pi files, OpenCode files + global `command` entries).

Mark the bot MCP design's "changes to the global MCP panel/editor are a non-goal" as superseded by this foundation (leave the historical text, add a note).

- [ ] **Step 2: Self-review the docs against the code**

Check every path, command name, field name and permission claim against the implementation. Remove anything aspirational.

- [ ] **Step 3: Run the full gates**

Run: `npm run test:fast`
Expected: PASS (protocol, engine-config, system, ui-runtime, server, ui-angular).

Run: `npm test -w @morse/integration-pi`
Expected: PASS (all tests, including bot layout and prompts).

Run: `npm test -w @morse/integration-opencode`
Expected: PASS (all tests, including JSONC and bot layout).

Run: `npm run check-types`
Expected: exit 0 for every workspace.

Run: `npm run lint`
Expected: exit 0, agent boundary OK.

Run: `npm test`
Expected: full suite green (extension, all libraries, integrations).

- [ ] **Step 4: Commit**

```bash
git add docs packages/engine-config/README.md
git commit -m "docs(engine): document the shared engine resource foundation"
```

---

## Plan self-review

- **Spec coverage:** the foundation package, the abstract hierarchy, MCP (global + bot), prompts (pi + OpenCode), JSONC/`.jsonc`, issues, Fix, probe, isolated engines, host/UI, docs and gates all have a task.
- **Type consistency:** `ConfigScope`, `ConfigIssue`, `ConfigMutation`, `McpServer`, `McpServerEntry`, `PromptTemplate`, `ConfigDocument`, `ConfigPaths`, `EngineDefinition`, `EngineInstance`, `McpStore`, `PromptStore` are defined once in Foundation Contracts and referenced by name in every later task.
- **Review Focus tests:** malformed siblings (Task 5), JSONC read/write and bot auto-normalize (Tasks 2, 9, 10, 11), corrupt-file abort (Task 9), one OpenCode bot write (Task 13), pi zero/hung/trusted status (Task 7).
- **Proportion:** test names and signatures, not implementations; bodies appear only where the algorithm is not determined by the signature (JSONC stripping, precedence merge, the bot write composition).
