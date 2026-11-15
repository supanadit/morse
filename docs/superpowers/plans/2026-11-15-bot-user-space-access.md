# Bot access to user-owned space — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Morse bot reach the reader's user-owned space (rootless Podman state, SSH keys, any absolute path) while keeping its own OpenCode config, auth and sessions isolated.

**Architecture:** Translate the wizard's tool names to OpenCode 2 permission actions (`bash → shell`, `task → subagent`), allow `external_directory` whenever file tools are enabled, and generate a V2 plugin that restores the host's real `XDG_CONFIG_HOME`/`XDG_DATA_HOME` for shell commands only. Existing bots are repaired on every host start.

**Tech Stack:** TypeScript, Node `fs`, Vitest, Angular signals/templates, OpenCode 2 plugin `shell.create.before` hook.

**Spec:** `docs/superpowers/specs/2026-11-15-bot-user-space-access-design.md`

## Global Constraints

- OpenCode permission actions are V2 names. Never write `bash`, `task` or `list` as a permission action.
- Bot engine state stays under `<bot>/config` (config) and `<bot>/sessions` (auth, database, logs, sessions).
- No new runtime dependencies.
- pi's tool list and environment are unchanged.
- The plugin path and id are fixed: `<bot>/config/opencode/plugins/morse-user-space.ts`, id `morse.user-space`.
- Do not bump versions or cut a release in this change.
- Every task runs `npm run test -w @morse/integration-opencode` (and the UI suite for Task 4); the whole plan ends with `npm run test:fast`.

## Review Focus

1. **Custom or absent host XDG/HOME:** the shell must get the host's real roots, never `undefined` or a relative path; when neither is known, leave the bot's value alone.
2. **Hand-edited permissions:** repair must not rewrite a ruleset that is not in Morse's generated shape, even if it contains `bash`.
3. **Shell-only bot:** no `external_directory` rule is added, and read-back never shows `external_directory` as a tool.
4. **No-tools bot:** only the blanket deny is written; repair stays idempotent with the plugin installed.
5. **Legacy bot:** a `bash` allow reads back as `shell` before repair, and repair translates it in place.

---

### Task 1: Bot user-space env and plugin

**Files:**
- Create: `packages/integration-opencode/src/bot-user-space.ts`
- Create: `packages/integration-opencode/src/bot-user-space.spec.ts`
- Modify: `packages/integration-opencode/src/bot-engine.ts:73-82` (`botOpenCodeEnv`)
- Modify: `packages/integration-opencode/src/bot-engine.spec.ts:259-299`
- Modify: `packages/integration-opencode/src/bot-layout.ts` (install the plugin from `writeOpenCodeBotConfig`)
- Modify: `packages/integration-opencode/src/bot-layout.spec.ts`

**Interfaces:**
- Produces:
  - `BOT_HOST_XDG_CONFIG_HOME_ENV = 'MORSE_HOST_XDG_CONFIG_HOME'`
  - `BOT_HOST_XDG_DATA_HOME_ENV = 'MORSE_HOST_XDG_DATA_HOME'`
  - `botUserSpaceEnv(botRoot: string, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv`
  - `botUserSpacePluginPath(botRoot: string): string`
  - `writeBotUserSpacePlugin(botRoot: string): void`
- Consumes: `botOpenCodeEnv` keeps its current signature and delegates to `botUserSpaceEnv`.

- [ ] **Step 1: Write the failing tests for the env helper and plugin writer**

Create `packages/integration-opencode/src/bot-user-space.spec.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOT_HOST_XDG_CONFIG_HOME_ENV,
  BOT_HOST_XDG_DATA_HOME_ENV,
  botUserSpaceEnv,
  botUserSpacePluginPath,
  writeBotUserSpacePlugin,
} from './bot-user-space.js';

describe('botUserSpaceEnv', () => {
  it('redirects both XDG roots into the bot and carries the host roots separately', () => {
    const botRoot = '/bots/forge';

    const env = botUserSpaceEnv(botRoot, { PATH: '/usr/bin', HOME: '/home/u' });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      XDG_CONFIG_HOME: join(botRoot, 'config'),
      XDG_DATA_HOME: join(botRoot, 'sessions'),
      [BOT_HOST_XDG_CONFIG_HOME_ENV]: '/home/u/.config',
      [BOT_HOST_XDG_DATA_HOME_ENV]: '/home/u/.local/share',
    });
  });

  it('keeps a custom host XDG value as the shell value', () => {
    const env = botUserSpaceEnv('/bots/forge', {
      XDG_CONFIG_HOME: '/home/u/.xdg/config',
      XDG_DATA_HOME: '/home/u/.xdg/data',
    });

    expect(env[BOT_HOST_XDG_CONFIG_HOME_ENV]).toBe('/home/u/.xdg/config');
    expect(env[BOT_HOST_XDG_DATA_HOME_ENV]).toBe('/home/u/.xdg/data');
    expect(env['XDG_CONFIG_HOME']).toBe('/bots/forge/config');
    expect(env['XDG_DATA_HOME']).toBe('/bots/forge/sessions');
  });

  it('omits the host roots when neither XDG nor HOME is set', () => {
    const env = botUserSpaceEnv('/bots/forge', { PATH: '/usr/bin' });

    expect(env).not.toHaveProperty(BOT_HOST_XDG_CONFIG_HOME_ENV);
    expect(env).not.toHaveProperty(BOT_HOST_XDG_DATA_HOME_ENV);
  });
});

describe('writeBotUserSpacePlugin', () => {
  let botRoot: string;

  beforeEach(() => {
    botRoot = mkdtempSync(join(tmpdir(), 'morse-bot-user-space-'));
  });

  afterEach(() => {
    rmSync(botRoot, { recursive: true, force: true });
  });

  it('writes the V2 shell hook into the bot config directory', () => {
    writeBotUserSpacePlugin(botRoot);

    const path = botUserSpacePluginPath(botRoot);
    expect(path).toBe(join(botRoot, 'config', 'opencode', 'plugins', 'morse-user-space.ts'));
    const source = readFileSync(path, 'utf8');
    expect(source).toContain('Plugin.define');
    expect(source).toContain('id: "morse.user-space"');
    expect(source).toContain('ctx.shell.hook("create.before"');
    expect(source).toContain(BOT_HOST_XDG_CONFIG_HOME_ENV);
    expect(source).toContain(BOT_HOST_XDG_DATA_HOME_ENV);
    expect(source).toContain('event.env.XDG_CONFIG_HOME = configHome');
    expect(source).toContain('event.env.XDG_DATA_HOME = dataHome');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('is idempotent', () => {
    writeBotUserSpacePlugin(botRoot);
    const first = readFileSync(botUserSpacePluginPath(botRoot), 'utf8');

    writeBotUserSpacePlugin(botRoot);

    expect(readFileSync(botUserSpacePluginPath(botRoot), 'utf8')).toBe(first);
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm run test -w @morse/integration-opencode -- src/bot-user-space.spec.ts`

Expected: FAIL — `./bot-user-space.js` cannot be resolved.

- [ ] **Step 3: Implement `bot-user-space.ts`**

Exact shapes:

```ts
export const BOT_HOST_XDG_CONFIG_HOME_ENV = 'MORSE_HOST_XDG_CONFIG_HOME';
export const BOT_HOST_XDG_DATA_HOME_ENV = 'MORSE_HOST_XDG_DATA_HOME';

export function botUserSpaceEnv(
  botRoot: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const home = base['HOME'];
  const configHome = base['XDG_CONFIG_HOME'] ?? (home === undefined ? undefined : join(home, '.config'));
  const dataHome =
    base['XDG_DATA_HOME'] ?? (home === undefined ? undefined : join(home, '.local', 'share'));
  return {
    ...base,
    XDG_CONFIG_HOME: join(botRoot, 'config'),
    XDG_DATA_HOME: join(botRoot, 'sessions'),
    ...(configHome === undefined ? {} : { [BOT_HOST_XDG_CONFIG_HOME_ENV]: configHome }),
    ...(dataHome === undefined ? {} : { [BOT_HOST_XDG_DATA_HOME_ENV]: dataHome }),
  };
}
```

`writeBotUserSpacePlugin` writes this exact source (a template literal so the env names stay in sync):

```ts
import { Plugin } from "@opencode/plugin"

const configHome = process.env.MORSE_HOST_XDG_CONFIG_HOME
const dataHome = process.env.MORSE_HOST_XDG_DATA_HOME

export default Plugin.define({
  id: "morse.user-space",
  async setup(ctx) {
    await ctx.shell.hook("create.before", (event) => {
      if (configHome !== undefined) event.env.XDG_CONFIG_HOME = configHome
      if (dataHome !== undefined) event.env.XDG_DATA_HOME = dataHome
    })
  },
})
```

Use an atomic private write: create `<bot>/config/opencode/plugins` (`0o700`), write a temp file beside the target with mode `0o600`, `chmodSync` it, rename; on a rename failure write in place with mode `0o600` and remove the temp; remove the temp in every catch before rethrowing.

- [ ] **Step 4: Delegate `botOpenCodeEnv` and update its tests**

In `bot-engine.ts`, replace the body of `botOpenCodeEnv` with `return botUserSpaceEnv(botRoot, base);` and update its doc comment to say the host's real roots travel as `MORSE_HOST_XDG_*` for the shell plugin.

Update `bot-engine.spec.ts`'s three `botOpenCodeEnv` tests:

```ts
expect(env).toEqual({
  PATH: '/usr/bin',
  HOME: '/home/u',
  XDG_CONFIG_HOME: join(botRoot, 'config'),
  XDG_DATA_HOME: join(botRoot, 'sessions'),
  MORSE_HOST_XDG_CONFIG_HOME: '/home/u/.config',
  MORSE_HOST_XDG_DATA_HOME: '/home/u/.local/share',
});
```

The inherited-custom-XDG test asserts `MORSE_HOST_XDG_CONFIG_HOME`/`MORSE_HOST_XDG_DATA_HOME` are `/home/u/.config` and `/home/u/.local/share` while both bot roots are still redirected. The default-env test asserts the host values equal `process.env.XDG_CONFIG_HOME`/`XDG_DATA_HOME` (or the `HOME` fallbacks) and that the base object is unchanged.

- [ ] **Step 5: Install the plugin from `writeOpenCodeBotConfig`**

Import `writeBotUserSpacePlugin` and call it immediately before `writeJsonAtomic(document.path, next)` in `writeOpenCodeBotConfig`. Add this test to `bot-layout.spec.ts`:

```ts
it('installs the user-space shell plugin beside the config', () => {
  writeOpenCodeBotConfig(botRoot, config);

  expect(existsSync(botUserSpacePluginPath(botRoot))).toBe(true);
});
```

Import `botUserSpacePluginPath` from `./bot-user-space.js`.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npm run test -w @morse/integration-opencode`

Expected: PASS for `bot-user-space.spec.ts`, `bot-engine.spec.ts` and `bot-layout.spec.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/integration-opencode/src/bot-user-space.ts packages/integration-opencode/src/bot-user-space.spec.ts packages/integration-opencode/src/bot-engine.ts packages/integration-opencode/src/bot-engine.spec.ts packages/integration-opencode/src/bot-layout.ts packages/integration-opencode/src/bot-layout.spec.ts
git commit -m "feat(bots): generate the user-space shell plugin"
```

---

### Task 2: Translate tools to OpenCode 2 permission actions

**Files:**
- Modify: `packages/integration-opencode/src/bot-layout.ts` (`permissionRules`, `openCodeBotLayout.read`)
- Test: `packages/integration-opencode/src/bot-layout.spec.ts`

**Interfaces:**
- Consumes: `writeOpenCodeBotConfig(botRoot, config)` and `openCodeBotLayout.read(botRoot)` from Task 1.
- Produces: no new exports. The generated ruleset is the contract later tasks repair.

- [ ] **Step 1: Write the failing permission tests**

Replace the existing "allows exactly the tools the reader chose" test with:

```ts
it('translates the wizard tools to OpenCode 2 permission actions', () => {
  writeOpenCodeBotConfig(botRoot, {
    ...config,
    tools: ['read', 'bash', 'task', 'list', 'webfetch'],
  });

  const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
    agents: Record<string, Record<string, unknown>>;
  };
  expect(file.agents['morse']?.['permissions']).toEqual([
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'shell', resource: '*', effect: 'allow' },
    { action: 'subagent', resource: '*', effect: 'allow' },
    { action: 'webfetch', resource: '*', effect: 'allow' },
    { action: 'external_directory', resource: '*', effect: 'allow' },
  ]);
  expect(openCodeBotLayout.read(botRoot).tools).toEqual([
    'read',
    'shell',
    'subagent',
    'webfetch',
  ]);
});

it('adds external access only when a file tool is chosen', () => {
  writeOpenCodeBotConfig(botRoot, { ...config, tools: ['shell'] });
  let file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
    agents: Record<string, Record<string, unknown>>;
  };
  expect(file.agents['morse']?.['permissions']).toEqual([
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'shell', resource: '*', effect: 'allow' },
  ]);

  writeOpenCodeBotConfig(botRoot, { ...config, tools: ['read'] });
  file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
    agents: Record<string, Record<string, unknown>>;
  };
  expect(file.agents['morse']?.['permissions']).toContainEqual({
    action: 'external_directory',
    resource: '*',
    effect: 'allow',
  });
  expect(openCodeBotLayout.read(botRoot).tools).toEqual(['read']);
});

it('keeps only the deny when no tools are chosen', () => {
  writeOpenCodeBotConfig(botRoot, { ...config, tools: [] });

  const file = JSON.parse(readFileSync(openCodeConfigPath(botRoot), 'utf8')) as {
    agents: Record<string, Record<string, unknown>>;
  };
  expect(file.agents['morse']?.['permissions']).toEqual([
    { action: '*', resource: '*', effect: 'deny' },
  ]);
  expect(openCodeBotLayout.read(botRoot).tools).toEqual([]);
});

it('reads a legacy bash allow back as shell, without external_directory as a tool', () => {
  writeOpenCodeBotConfig(botRoot, config);
  const path = openCodeConfigPath(botRoot);
  const file = JSON.parse(readFileSync(path, 'utf8')) as {
    agents: Record<string, Record<string, unknown>>;
  };
  file.agents['morse']!['permissions'] = [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'bash', resource: '*', effect: 'allow' },
    { action: 'external_directory', resource: '*', effect: 'allow' },
  ];
  writeFileSync(path, JSON.stringify(file));

  expect(openCodeBotLayout.read(botRoot).tools).toEqual(['shell']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @morse/integration-opencode -- src/bot-layout.spec.ts`

Expected: FAIL — the ruleset still contains `bash`/`list`, no `external_directory`, and read-back returns the raw actions.

- [ ] **Step 3: Implement the mapping**

In `bot-layout.ts`:

```ts
const TOOL_ACTION_RENAMES: Record<string, string> = {
  bash: 'shell',
  task: 'subagent',
  write: 'edit',
  patch: 'edit',
};

const DROPPED_TOOL_ACTIONS = new Set(['list']);
const FILE_TOOL_ACTIONS = new Set(['read', 'edit', 'glob', 'grep']);

function actionFor(tool: string): string | undefined {
  if (tool === '*' || DROPPED_TOOL_ACTIONS.has(tool)) {
    return undefined;
  }
  return TOOL_ACTION_RENAMES[tool] ?? tool;
}
```

`permissionRules` keeps the blanket deny first, collects a `Set` of `actionFor(tool)` values, writes one allow per action, then appends `{ action: 'external_directory', resource: '*', effect: 'allow' }` when at least one collected action is in `FILE_TOOL_ACTIONS`.

In `openCodeBotLayout.read`, when reading `own['permissions']`, keep only `effect === 'allow'` rules, skip `external_directory` and `*`, skip dropped actions, map the rest through `TOOL_ACTION_RENAMES`, and de-duplicate with a `Set`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm run test -w @morse/integration-opencode -- src/bot-layout.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/integration-opencode/src/bot-layout.ts packages/integration-opencode/src/bot-layout.spec.ts
git commit -m "fix(bots): use OpenCode 2 permission actions"
```

---

### Task 3: Repair existing bots on start

**Files:**
- Modify: `packages/integration-opencode/src/bot-layout.ts` (`openCodeBotLayout.repair`, new `migratePermissions`/`migrateRules`)
- Test: `packages/integration-opencode/src/bot-layout.spec.ts`

**Interfaces:**
- Consumes: `TOOL_ACTION_RENAMES`, `DROPPED_TOOL_ACTIONS`, `FILE_TOOL_ACTIONS`, `writeBotUserSpacePlugin`.
- Produces: `repair(botRoot)` now translates generated rulesets and installs the plugin. `reconcileBotData` already calls it on every start; no change there.

- [ ] **Step 1: Write the failing repair tests**

Add:

```ts
it('repairs a generated ruleset from the bash era and installs the plugin', () => {
  writeOpenCodeBotConfig(botRoot, { ...config, tools: ['read'] });
  const path = openCodeConfigPath(botRoot);
  const file = JSON.parse(readFileSync(path, 'utf8')) as {
    agents: Record<string, Record<string, unknown>>;
  };
  file.agents['morse']!['permissions'] = [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'bash', resource: '*', effect: 'allow' },
    { action: 'list', resource: '*', effect: 'allow' },
  ];
  writeFileSync(path, JSON.stringify(file));

  openCodeBotLayout.repair?.(botRoot);

  const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
    agents: Record<string, Record<string, unknown>>;
  };
  expect(repaired.agents['morse']?.['permissions']).toEqual([
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'shell', resource: '*', effect: 'allow' },
    { action: 'external_directory', resource: '*', effect: 'allow' },
  ]);
  expect(existsSync(botUserSpacePluginPath(botRoot))).toBe(true);
});

it('leaves a hand-authored ruleset alone', () => {
  writeOpenCodeBotConfig(botRoot, config);
  const path = openCodeConfigPath(botRoot);
  const file = JSON.parse(readFileSync(path, 'utf8')) as {
    agents: Record<string, Record<string, unknown>>;
  };
  const rules = [
    { action: 'bash', resource: 'git *', effect: 'allow' },
    { action: 'read', resource: 'src/**', effect: 'allow' },
  ];
  file.agents['morse']!['permissions'] = rules;
  writeFileSync(path, JSON.stringify(file));

  openCodeBotLayout.repair?.(botRoot);

  const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
    agents: Record<string, Record<string, unknown>>;
  };
  expect(repaired.agents['morse']?.['permissions']).toEqual(rules);
});

it('is idempotent across repairs', () => {
  writeOpenCodeBotConfig(botRoot, { ...config, tools: ['read', 'bash'] });
  const path = openCodeConfigPath(botRoot);
  const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  (file['agents'] as Record<string, Record<string, unknown>>)['morse']!['permissions'] = [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: '*', effect: 'allow' },
    { action: 'bash', resource: '*', effect: 'allow' },
  ];
  writeFileSync(path, JSON.stringify(file));

  openCodeBotLayout.repair?.(botRoot);
  const first = readFileSync(path, 'utf8');
  openCodeBotLayout.repair?.(botRoot);

  expect(readFileSync(path, 'utf8')).toBe(first);
});
```

In the two existing legacy-repair tests (persona file, deprecated `agent` key), add `expect(existsSync(botUserSpacePluginPath(botRoot))).toBe(true);` so the new install step is pinned there too.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @morse/integration-opencode -- src/bot-layout.spec.ts`

Expected: FAIL — `bash`/`list` remain, `external_directory` is missing, and the plugin does not exist after repair.

- [ ] **Step 3: Restructure `repair` and add the ruleset migration**

Make `repair` do all of the following in one pass, then write once:

1. Read the config (unchanged `configObject` guard).
2. If the legacy persona file exists, fold it into `agents.morse.system`, set `default_agent`, clear `instructions`, and schedule the legacy file/dir removal. Otherwise, if `file.agent` exists, merge it into `file.agents` and delete `file.agent`.
3. Call `migratePermissions(file)`.
4. `writeBotUserSpacePlugin(botRoot)`.
5. `writeJsonAtomic(path, file)` only when steps 2 or 3 changed something.
6. After the write, remove the legacy persona file and `<bot>/config/opencode/instructions` if step 2 scheduled it.

`migratePermissions(file): boolean` finds the default agent (`file.default_agent`, else `morse`) in `file.agents`, reads its `permissions` array, and returns false unless the **first rule** is exactly `{ action: '*', resource: '*', effect: 'deny' }` (Morse's generated shape). It then maps every rule through `TOOL_ACTION_RENAMES`, drops `DROPPED_TOOL_ACTIONS`, de-duplicates byte-identical rules, and appends `{ action: 'external_directory', resource: '*', effect: 'allow' }` when at least one allow rule uses a `FILE_TOOL_ACTIONS` action and no `external_directory` rule exists. Return true only when `JSON.stringify(next) !== JSON.stringify(rules)`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm run test -w @morse/integration-opencode -- src/bot-layout.spec.ts`

Expected: PASS, including the two legacy-repair tests.

- [ ] **Step 5: Commit**

```bash
git add packages/integration-opencode/src/bot-layout.ts packages/integration-opencode/src/bot-layout.spec.ts
git commit -m "fix(bots): repair OpenCode permissions and install the shell plugin"
```

---

### Task 4: Offer OpenCode 2 tools in the bot wizard

**Files:**
- Modify: `packages/ui-angular/src/app/features/bot-wizard/bot-wizard.ts` (`ENGINE_TOOLS`, `DEFAULT_TOOLS`)
- Modify: `packages/ui-angular/src/app/features/bot-wizard/bot-wizard.html` (tools note)
- Test: `packages/ui-angular/src/app/features/bot-wizard/bot-wizard.spec.ts`

**Interfaces:**
- Consumes: the V2 action names from Task 2.
- Produces: the wizard sends `shell`/`subagent` (never `bash`/`task`/`list`) for OpenCode.

- [ ] **Step 1: Write the failing wizard tests**

Replace the existing OpenCode tool test with:

```ts
it('offers OpenCode 2 tool names, with shell on by default', async () => {
  const { fixture, host, morse } = await render();
  walkToReview(fixture, host, morse, 'opencode');
  const rail = [...host.querySelectorAll('.wizard-step')] as HTMLElement[];
  (rail[5]?.querySelector('button') as HTMLButtonElement).click();
  tick(fixture);

  const boxes = [...host.querySelectorAll('.tool input[type="checkbox"]')] as HTMLInputElement[];
  expect(boxes.map((box) => box.getAttribute('data-tool'))).toEqual([
    'read',
    'edit',
    'glob',
    'grep',
    'shell',
    'subagent',
    'webfetch',
    'websearch',
    'todowrite',
  ]);
  expect(boxes.filter((box) => box.checked).map((box) => box.getAttribute('data-tool'))).toEqual([
    'read',
    'edit',
    'glob',
    'grep',
    'shell',
  ]);
});

it('sends shell, not bash or list, when the OpenCode checklist changes', async () => {
  const { fixture, host, morse } = await render();
  walkToReview(fixture, host, morse, 'opencode');
  const rail = [...host.querySelectorAll('.wizard-step')] as HTMLElement[];
  (rail[5]?.querySelector('button') as HTMLButtonElement).click();
  tick(fixture);

  const websearch = [...host.querySelectorAll('.tool input[type="checkbox"]')].find(
    (box) => box.getAttribute('data-tool') === 'websearch',
  ) as HTMLInputElement;
  websearch.checked = true;
  websearch.dispatchEvent(new Event('change'));
  tick(fixture);

  (rail[6]?.querySelector('button') as HTMLButtonElement).click();
  tick(fixture);
  const create = vi.spyOn(morse, 'createBot');
  button(host, '.wizard-foot .primary').click();
  tick(fixture);

  expect(create.mock.calls[0]?.[0]).toMatchObject({
    tools: ['read', 'edit', 'glob', 'grep', 'shell', 'websearch'],
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @morse/ui-angular`

Expected: FAIL — the OpenCode list still offers `list`/`bash`/`task`.

- [ ] **Step 3: Update the tool list, defaults and note**

In `bot-wizard.ts`:

```ts
opencode: [
  { name: 'read' },
  { name: 'edit' },
  { name: 'glob' },
  { name: 'grep' },
  { name: 'shell', hint: 'run shell commands' },
  { name: 'subagent', hint: 'launch subagents' },
  { name: 'webfetch', hint: 'fetch a URL' },
  { name: 'websearch', hint: 'search the web' },
  { name: 'todowrite' },
],
```

```ts
const DEFAULT_TOOLS: Record<string, string[]> = {
  pi: ['read', 'bash', 'edit', 'write'],
  opencode: ['read', 'edit', 'glob', 'grep', 'shell'],
};
```

In `bot-wizard.html`, append to the `.tools-note` after the existing copy:

```html
A bot runs as you: its file tools reach your home directory and its shell can run any command.
Its engine config, auth and sessions stay in its own folder.
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm run test -w @morse/ui-angular`

Expected: PASS, including the existing pi tool test.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/features/bot-wizard/bot-wizard.ts packages/ui-angular/src/app/features/bot-wizard/bot-wizard.html packages/ui-angular/src/app/features/bot-wizard/bot-wizard.spec.ts
git commit -m "feat(bots): offer OpenCode 2 tool names"
```

---

### Task 5: Document what a bot can reach

**Files:**
- Modify: `docs/CONFIGURATION.md` (after the bot MCP section)
- Modify: `docs/ARCHITECTURE.md` (bot mode)
- Modify: `docs/STATUS.md` (Bot mode bullets)
- Modify: `docs/DATA-COMPATIBILITY.md` (opencode repair bullet)

- [ ] **Step 1: Write the docs**

In `CONFIGURATION.md`, add a **What a bot can reach** subsection after the bot MCP section. Include:

- A bot is not a container: it runs as the host's user from `<bot>/workspace`, and its file tools reach the reader's home directory; the shell tool can run any command the reader can.
- Engine state stays in the bot's tree: OpenCode's config (`<bot>/config`), and auth, database, sessions and logs (`<bot>/sessions`); each bot's workspace is its own directory.
- The server runs with redirected XDG roots and passes the real ones as `MORSE_HOST_XDG_CONFIG_HOME`/`MORSE_HOST_XDG_DATA_HOME`; `<bot>/config/opencode/plugins/morse-user-space.ts` restores them for shell commands only, so rootless Podman, `systemctl --user` and `~/.ssh` work. If OpenCode cannot load that plugin, shell commands keep the bot's XDG roots (empty user tools) and the failure appears in the bot's OpenCode log.
- MCP servers keep the bot environment.

In `ARCHITECTURE.md`, add a short **What a bot can reach** subsection under the bot-mode material, cross-referencing `CONFIGURATION.md` for the env detail.

In `STATUS.md`, add a Bot mode bullet: bots run as the reader; file tools reach the home directory; shell runs user commands; engine config stays in `<bot>/config`, auth and sessions in `<bot>/sessions`.

In `DATA-COMPATIBILITY.md`, extend the opencode repair bullet: a generated ruleset is translated to OpenCode 2 action names (`bash → shell`, `task → subagent`), `list` is dropped, `external_directory` is added, and the user-space plugin is installed; a ruleset not in Morse's generated shape is left alone.

- [ ] **Step 2: Verify the docs mention the exact paths and variables**

Run: `grep -n "morse-user-space\|MORSE_HOST_XDG" docs/CONFIGURATION.md docs/ARCHITECTURE.md docs/STATUS.md docs/DATA-COMPATIBILITY.md`

Expected: the plugin path appears in `CONFIGURATION.md` and at least one of the env names appears beside it.

- [ ] **Step 3: Commit**

```bash
git add docs/CONFIGURATION.md docs/ARCHITECTURE.md docs/STATUS.md docs/DATA-COMPATIBILITY.md
git commit -m "docs: explain bot access to user-owned space"
```

---

### Task 6: Full verification

**Files:** none (fix anything the runs surface).

- [ ] **Step 1: Type-check the touched packages**

Run:

```bash
npm run check-types -w @morse/integration-opencode
npm run check-types -w @morse/ui-angular
```

Expected: both exit 0.

- [ ] **Step 2: Run the integration and UI suites**

Run:

```bash
npm run test -w @morse/integration-opencode
npm run test -w @morse/ui-angular
```

Expected: PASS.

- [ ] **Step 3: Run the project's fast suite**

Run: `npm run test:fast`

Expected: PASS.

- [ ] **Step 4: Manual acceptance check after the host restarts**

Rebuild and restart the host the way this checkout runs (`npm run build:web`, then start the server again), open the **Podman Manager** bot and send:

```
Run podman ps -a and report the output.
```

Expected: the bot uses the shell tool (no "no shell/execute tool" reply) and lists the same containers as the reader's own `podman ps -a`. If the checkout is not the running host, record that the automated checks passed and ask the reader to run this check after restarting; do not claim the behavior is verified from unit tests alone.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "test(bots): verify user-space access end to end"
```

(Skip if Step 5 required no changes.)
