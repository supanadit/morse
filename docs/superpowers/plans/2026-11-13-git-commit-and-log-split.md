# Commit Sidebar and Bottom Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move git history out of the right column into a `Git Log` tab in the bottom panel, leave the column to branch/commit work, and back the log with ref-scoped history and amend.

**Architecture:** `GitPanelState`/`GitRepoState` remain the single git data source. A new `GitLogView` joins the bottom panel's chip registry and reads that state; `git-panel` drops its History half and its internal splitters. The host gains an optional `ref` on `gitLog` and `amend` on `gitCommit`.

**Tech Stack:** Angular 20 signals/OnPush, Vitest + TestBed, NestJS host command handlers, SVG lane graph from `@morse/ui-runtime`.

**Spec:** `docs/superpowers/specs/2026-11-13-git-commit-and-log-split-design.md`

## Global Constraints

- Bottom-panel view id is exactly `git-log`, label `Git Log`; it appears only when `capabilities.gitPanel === true`.
- `gitLog` args add optional `ref`; all `git log` options must precede the revision, with `--end-of-options` immediately before the ref.
- `gitCommit` args add optional `amend` boolean; amend with an empty message runs `--no-edit`, non-amend with an empty message keeps today's refusal.
- The branch tree scopes history only; it never checks out a branch.
- Commit and Push stands down while Amend is checked.
- No stash, worktrees, console, issue association, AI actions, avatars or email.
- The right column keeps the repo accordion, branch picker, sync, commit form and file staging; it loses History and every Changes/History splitter.
- Retire `PaneId` (`changes`, `detail`) from `LayoutState` once their splitters go.
- The design's reference product name stays out of every document, plan and commit message.
- Focused UI tests run from the repo root: `npm test -w @morse/ui-angular -- --watch=false --include='<glob>'`.
- Focused host tests: `npm test -w @morse/server -- src/internal/workspace/git-log.spec.ts`.
- Full gate: `npm run test:fast`.

## Review Focus

- **A stale or deleted branch ref.** Selecting it must fail visibly, not show a blank or another branch's history. Pinned in Task 1 (host refuses) and Task 4 (view error state).
- **Amend with an empty message.** It must keep the previous message; a normal empty commit must still refuse. Pinned in Task 2 and Task 8.
- **Switching repositories.** The picker must reset the ref, selection and loaded pages so repo A's commits never render under repo B. Pinned in Task 4.
- **Changing ref while a page is in flight.** The old page must be discarded, never appended to the new ref's list. Pinned in Task 3.
- **An unborn repository (no commits).** The log must show its empty state without crashing or offering paging. Pinned in Task 4.

---

### Task 1: Scope `gitLog` to a ref

**Files:**
- Modify: `packages/server/src/internal/workspace/git-log.ts`
- Modify: `packages/server/src/internal/ws/session-factory.service.ts`
- Test: `packages/server/src/internal/workspace/git-log.spec.ts` (create)

**Interfaces:**
- Produces: `readGitLog(cwd: string, requestedMax?: number, requestedSkip?: number, repo?: string, ref?: string): Promise<GitLog>`.
- Produces: `gitLog` accepts `args.ref?: string`.
- Uses: the private `isBranchName` guard as the ref guard; no leading `-`, whitespace, `..`, `@{`, `~^:?*[\`.

- [ ] **Step 1: Write the failing host tests**

Create `git-log.spec.ts` with a temp repo fixture:

```ts
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGitLog } from './git-log';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'morse-log-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  commit('init');
  git(root, 'checkout', '-q', '-b', 'feat');
  commit('feat one');
  git(root, 'checkout', '-q', 'main');
  commit('main two');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function commit(subject: string): void {
  appendFileSync(join(root, 'file.txt'), `${subject}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', subject);
}

describe('readGitLog ref', () => {
  it('keeps every branch when no ref is named', async () => {
    const log = await readGitLog(root);
    expect(log.commits.map((c) => c.subject)).toEqual(
      expect.arrayContaining(['init', 'feat one', 'main two']),
    );
  });

  it('returns only the named ref history', async () => {
    const log = await readGitLog(root, 50, 0, undefined, 'feat');
    expect(log.commits.map((c) => c.subject)).toEqual(['feat one', 'init']);
  });

  it('refuses an option-shaped ref', async () => {
    await expect(readGitLog(root, 50, 0, undefined, '--all')).rejects.toThrow(
      /usable git ref/,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @morse/server -- src/internal/workspace/git-log.spec.ts`
Expected: FAIL — the fifth argument is ignored, so `feat` returns every branch.

- [ ] **Step 3: Implement the ref**

In `readGitLog`, add the parameter and build the selection:

```ts
const named = ref?.trim();
if (named !== undefined && named.length > 0 && !isBranchName(named)) {
  throw new Error('That is not a usable git ref.');
}
const options = [
  '--date-order',
  `--skip=${skip}`,
  `--max-count=${max}`,
  `--pretty=format:${PRETTY_FORMAT}`,
];
const selection = named ? ['--end-of-options', named] : ['--all'];
const raw = await gitText(['log', ...options, ...selection], work);
```

In `session-factory.service.ts`'s `gitLog` case:

```ts
const ref = typeof args?.ref === 'string' ? args.ref : undefined;
return readGitLog(cwd, max, skip, repoArg(args), ref);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @morse/server -- src/internal/workspace/git-log.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/internal/workspace/git-log.ts \
  packages/server/src/internal/ws/session-factory.service.ts \
  packages/server/src/internal/workspace/git-log.spec.ts
git commit -m "feat(server): scope git history to a named ref"
```

---

### Task 2: Amend the last commit

**Files:**
- Modify: `packages/server/src/internal/workspace/git-log.ts`
- Modify: `packages/server/src/internal/ws/session-factory.service.ts`
- Test: `packages/server/src/internal/workspace/git-log.spec.ts`

**Interfaces:**
- Produces: `commitGit(cwd: string, message: string, repo?: string, amend?: boolean): Promise<GitMutation>`.
- Produces: `gitCommit` accepts `args.amend?: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `git-log.spec.ts` (add `writeFileSync` to the `node:fs` import):

```ts
import { commitGit } from './git-log';

describe('commitGit amend', () => {
  it('rewrites the last commit and keeps the count', async () => {
    writeFileSync(join(root, 'next.txt'), 'next');
    git(root, 'add', '.');

    const result = await commitGit(root, 'main two amended', undefined, true);

    expect(result.ok).toBe(true);
    expect(git(root, 'log', '-1', '--pretty=%s').trim()).toBe('main two amended');
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('2');
  });

  it('keeps the old message when amend is given no message', async () => {
    const result = await commitGit(root, '   ', undefined, true);

    expect(result.ok).toBe(true);
    expect(git(root, 'log', '-1', '--pretty=%s').trim()).toBe('main two');
  });

  it('still refuses an empty message without amend', async () => {
    expect(await commitGit(root, '   ')).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @morse/server -- src/internal/workspace/git-log.spec.ts`
Expected: FAIL — amend is ignored; the subject and count do not change as asserted.

- [ ] **Step 3: Implement amend**

Change the signature and the command:

```ts
const args = ['commit'];
if (amend) {
  args.push('--amend');
}
if (text.length > 0) {
  args.push('-m', text);
} else if (amend) {
  args.push('--no-edit');
} else {
  return { ok: false, message: 'A commit needs a message.' };
}
const result = await gitExec(args, work, 60_000);
```

In the `gitCommit` case:

```ts
const amend = args?.amend === true;
return commitGit(cwd, message, repoArg(args), amend);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @morse/server -- src/internal/workspace/git-log.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/internal/workspace/git-log.ts \
  packages/server/src/internal/ws/session-factory.service.ts \
  packages/server/src/internal/workspace/git-log.spec.ts
git commit -m "feat(server): amend the last commit from the commit form"
```

---

### Task 3: Track the log ref and amend in `GitRepoState`

**Files:**
- Modify: `packages/ui-angular/src/app/services/git-panel-state.ts`
- Test: `packages/ui-angular/src/app/features/git-panel/git-panel.spec.ts`
- Test: `packages/ui-runtime/src/transport/memory-transport.spec.ts` (create)
- Modify: `packages/ui-runtime/src/transport/memory-transport.ts`

**Interfaces:**
- Produces: `GitRepoState.logRef: Signal<string | undefined>`; `GitRepoState.setLogRef(ref: string | undefined): void`.
- Produces: `GitRepoState.commit(message: string, amend?: boolean): Promise<boolean>`.
- Consumes: Task 1's `ref` argument and Task 2's `amend`.

- [ ] **Step 1: Write the failing state tests**

In `git-panel.spec.ts`'s `GitPanelState paging` describe, add a fake that records commands (reuse the existing `fake` shape, adding `refresh: vi.fn()` to `workspace`):

```ts
it('reloads from the first page when a ref is selected', async () => {
  // ... configure the fake exactly like the paging test, then:
  state.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const repo = state.repos()[0]!;

  repo.setLogRef('feat');
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fake.requestHostCommand).toHaveBeenLastCalledWith('gitLog', {
    max: 250,
    skip: 0,
    ref: 'feat',
  });
  expect(repo.commits().map((c) => c.subject)).toEqual(['feat c']);

  repo.setLogRef(undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fake.requestHostCommand).toHaveBeenLastCalledWith('gitLog', { max: 250, skip: 0 });
});

it('forwards amend to the host', async () => {
  state.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const repo = state.repos()[0]!;

  await repo.commit('rewrite', true);

  expect(fake.requestHostCommand).toHaveBeenCalledWith(
    'gitCommit',
    { message: 'rewrite', amend: true },
    60_000,
  );
});
```

The fake's `gitLog` branch must answer `args.ref === 'feat'` with one commit and otherwise
with the page; its `gitCommit` branch must answer `{ ok: true }` so the success path runs.
Also add `refresh: vi.fn()` to the fake `workspace`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @morse/ui-angular -- --watch=false --include='src/app/features/git-panel/git-panel.spec.ts'`
Expected: FAIL — `setLogRef` does not exist and `commit` sends no `amend`.

- [ ] **Step 3: Implement**

In `GitRepoState`:

```ts
private readonly refSignal = signal<string | undefined>(undefined);
readonly logRef = this.refSignal.asReadonly();

setLogRef(ref: string | undefined): void {
  if (ref === this.refSignal()) {
    return;
  }
  this.refSignal.set(ref);
  this.items.set([]);
  this.meta.set(undefined);
  this.refresh();
}
```

In `page(skip)`, spread the ref into the args:

```ts
const named = this.refSignal();
const raw = await this.morse.requestHostCommand('gitLog', {
  max: GIT_PAGE_SIZE,
  skip,
  ...(named === undefined ? {} : { ref: named }),
  ...(this.args() ?? {}),
});
```

Change `commit(message: string, amend = false)` and pass `{ message, amend, ...this.args() }`.

In the memory transport's `gitLog` handler, filter the scripted log by reachability from the ref tip when `args.ref` is set; in the `gitCommit` handler, when `args.amend === true` and a message is present, replace the first commit's subject so `?mock=1` shows the rewritten commit. Add a `memory-transport.spec.ts`:

```ts
import { createMorseClient } from '../../client.js';
import { MemoryHostTransport } from '../memory-transport.js';

it('scopes the mock log to the named ref', async () => {
  const client = createMorseClient({ transport: new MemoryHostTransport() });
  const log = (await client.actions.hostCommand('gitLog', { ref: 'origin/main' })) as {
    commits: Array<{ subject: string }>;
  };
  expect(log.commits.map((c) => c.subject)).not.toContain('Add the git panel to the browser host');
  client.dispose();
});

it('shows an amended message in the mock log', async () => {
  const client = createMorseClient({ transport: new MemoryHostTransport() });
  await client.actions.hostCommand('gitCommit', { message: 'rewritten', amend: true });
  const log = (await client.actions.hostCommand('gitLog', {})) as {
    commits: Array<{ subject: string }>;
  };
  expect(log.commits[0]?.subject).toBe('rewritten');
  client.dispose();
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @morse/ui-angular -- --watch=false --include='src/app/features/git-panel/git-panel.spec.ts'`
Run: `npm test -w @morse/ui-runtime -- src/transport/memory-transport.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/services/git-panel-state.ts \
  packages/ui-angular/src/app/features/git-panel/git-panel.spec.ts \
  packages/ui-runtime/src/transport/memory-transport.ts \
  packages/ui-runtime/src/transport/memory-transport.spec.ts
git commit -m "feat(ui): track the git log ref and amend in state"
```

---

### Task 4: The `GitLogView` component

**Files:**
- Create: `packages/ui-angular/src/app/features/git-log/git-log.ts`
- Create: `packages/ui-angular/src/app/features/git-log/git-log.html`
- Create: `packages/ui-angular/src/app/features/git-log/git-log.css`
- Test: `packages/ui-angular/src/app/features/git-log/git-log.spec.ts`

**Interfaces:**
- Consumes: `GitPanelState.repos`, `.current`, `.refresh`, `.stateFor(path)`; `GitRepoState.commits`, `.branches`, `.branch`, `.loading`, `.error`, `.hasMore`, `.loadMore()`, `.loadBranches()`, `.setLogRef()`, `.logRef`.
- Produces: `GitLogView`, selector `morse-git-log`.
- Consumes the graph helpers moved from `git-panel.ts`: `layoutGraph`, `path`, `x`, `color`, `rowColor`, `commitTitle`, `refKind`, `refLabel`, `continuing`.

- [ ] **Step 1: Write the failing tests**

Create `git-log.spec.ts` with a real `GitPanelState` over a fake `MorseService`.
It needs `TestBed`, `signal`, `MorseService`, `GitLogView`, and this helper:

```ts
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
```

```ts
function fakeHost() {
  const branches = {
    isRepo: true,
    current: 'main',
    local: ['main', 'feat'],
    remote: ['origin/main'],
    tags: ['v1'],
  };
  return {
    workspace: signal({ cwd: '/r', name: 'r' }),
    capabilities: signal({ hostKind: 'server', gitPanel: true, filePicker: true }),
    requestHostCommand: vi.fn((command: string, args?: Record<string, unknown>) => {
      if (command === 'gitRepos') {
        return Promise.resolve({
          isRepo: true,
          repos: [
            { path: '', root: '/r', name: 'r', current: true, branch: 'main' },
            { path: 'nested', root: '/r/nested', name: 'nested', current: false, branch: 'feat' },
          ],
        });
      }
      if (command === 'gitSync') return Promise.resolve({ isRepo: true, ahead: 0, behind: 0 });
      if (command === 'gitStatus') return Promise.resolve({ isRepo: true, files: [] });
      if (command === 'gitBranches') return Promise.resolve(branches);
      if (command === 'gitCommitFiles') {
        return Promise.resolve({
          isRepo: true,
          hash: String(args?.hash ?? ''),
          files: [{ path: 'src/a.ts', status: 'M' }],
        });
      }
      const ref = String(args?.ref ?? '');
      const nested = args?.repo === 'nested';
      const commits = nested
        ? [{ hash: 'n1', shortHash: 'n1', parents: [], refs: ['feat'], author: 'Grace', date: new Date().toISOString(), subject: 'nested work' }]
        : ref === 'feat'
          ? [{ hash: 'f1', shortHash: 'f1', parents: [], refs: ['feat'], author: 'Ada', date: new Date().toISOString(), subject: 'feat work' }]
          : [
              { hash: 'm1', shortHash: 'm1', parents: [], refs: ['HEAD -> main'], author: 'Ada', date: new Date().toISOString(), subject: 'main work' },
              { hash: 'm0', shortHash: 'm0', parents: ['m1'], refs: [], author: 'Grace', date: new Date().toISOString(), subject: 'docs work' },
            ];
      return Promise.resolve({ isRepo: true, root: '/r', branch: 'main', commits });
    }),
  };
}

async function render(options: { failLog?: boolean; empty?: boolean } = {}) {
  const host = fakeHost();
  if (options.failLog) {
    host.requestHostCommand.mockImplementation(() => Promise.resolve(undefined));
  }
  if (options.empty) {
    const gitLog = host.requestHostCommand.getMockImplementation()!;
    host.requestHostCommand.mockImplementation((command, args) =>
      command === 'gitLog'
        ? Promise.resolve({ isRepo: true, root: '/r', branch: 'main', commits: [] })
        : gitLog(command, args),
    );
  }
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [GitLogView],
    providers: [{ provide: MorseService, useValue: host }],
  });
  const fixture = TestBed.createComponent(GitLogView);
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  return fixture;
}
```

Tests:

```ts
it('lists the current branch and filters by a selected ref', async () => {
  const fixture = await render();
  expect(fixture.nativeElement.querySelector('.commit .subject')?.textContent).toContain('main work');
  // The tree offers every ref kind the host returned.
  expect(fixture.nativeElement.querySelector('[data-ref="origin/main"]')).not.toBeNull();
  expect(fixture.nativeElement.querySelector('[data-ref="v1"]')).not.toBeNull();

  (fixture.nativeElement.querySelector('[data-ref="feat"]') as HTMLElement).click();
  fixture.detectChanges();
  await flush();

  expect(fixture.nativeElement.querySelector('.commit .subject')?.textContent).toContain('feat work');
});

it('filters by text and author', async () => {
  const fixture = await render();
  const text = fixture.nativeElement.querySelector('.filter-text') as HTMLInputElement;
  text.value = 'main';
  text.dispatchEvent(new Event('input'));
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelectorAll('.commit')).toHaveLength(1);

  text.value = '';
  text.dispatchEvent(new Event('input'));
  const author = fixture.nativeElement.querySelector('.filter-author') as HTMLSelectElement;
  author.value = 'Grace';
  author.dispatchEvent(new Event('change'));
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelectorAll('.commit')).toHaveLength(1);
  expect(fixture.nativeElement.querySelector('.commit .subject')?.textContent).toContain(
    'docs work',
  );
});

it('shows a commit’s files in the details pane', async () => {
  const fixture = await render();
  (fixture.nativeElement.querySelector('.commit') as HTMLElement).click();
  fixture.detectChanges();
  await flush();
  expect(fixture.nativeElement.querySelector('.details')?.textContent).toContain('src/a.ts');
});

it('resets the ref and selection when the repository changes', async () => {
  const fixture = await render();
  (fixture.nativeElement.querySelector('[data-ref="feat"]') as HTMLElement).click();
  fixture.detectChanges();
  await flush();
  expect(fixture.nativeElement.querySelector('.commit .subject')?.textContent).toContain('feat work');

  (fixture.nativeElement.querySelector('.repo-picker') as HTMLSelectElement).value = 'nested';
  fixture.nativeElement.querySelector('.repo-picker').dispatchEvent(new Event('change'));
  fixture.detectChanges();
  await flush();

  expect(fixture.nativeElement.querySelector('.commit .subject')?.textContent).toContain('nested work');
  expect(fixture.nativeElement.querySelector('.details')).toBeNull();
});

it('shows an error when the host cannot read the ref', async () => {
  const fixture = await render({ failLog: true });
  expect(fixture.nativeElement.querySelector('.hint.error')?.textContent).toContain('git history');
});

it('says when the selected ref has no commits', async () => {
  const fixture = await render({ empty: true });
  expect(fixture.nativeElement.querySelector('.empty')?.textContent).toContain('No commits');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @morse/ui-angular -- --watch=false --include='src/app/features/git-log/git-log.spec.ts'`
Expected: FAIL to resolve `./git-log`.

- [ ] **Step 3: Build the component**

Layout:

```html
<section class="log">
  <aside class="tree">
    <!-- HEAD, Local, Remote, Tags; rows carry data-ref="feat" / data-ref="origin/main" -->
  </aside>
  <div class="main">
    <div class="toolbar">
      <input class="filter-text" placeholder="Text or hash" />
      <select class="filter-author"><option value="">All authors</option></select>
      <span class="count">{{ rows().length }} commits</span>
    </div>
    <ul class="commits">…rows with graph svg, .subject, .ref, .author, .when, .hash…</ul>
  </div>
  <aside class="details">…files for the selected commit, or the empty line…</aside>
</section>
```

- `selectedPath` defaults to `git.current()?.info.path`; `selectedRepo` computed from `git.stateFor`.
- On mount and on `selectedPath`, call `git.refresh()` if `!git.loaded()`, then `selectedRepo()?.loadBranches()`.
- `rows` = `repo.commits()` filtered by message/hash and author; `entries` = `layoutGraph(filtered)` paired with commits and trimmed refs.
- `selectRef(ref)` calls `repo.setLogRef(ref)` and clears `selectedCommit`.
- `selectCommit(hash)` loads `gitCommitFiles` into a per-hash map; render the files with `morse-tree`.
- Paging: `(scroll)="onScroll($event)"` calls `repo.loadMore()` near the bottom.
- Move `path/x/color/rowColor/commitTitle/refKind/refLabel/continuing` and the graph CSS from `git-panel` into this component; the sidebar stops using them in Task 6.
- Container query at 720px: `.details` is a third column; below it, the details sit under the list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @morse/ui-angular -- --watch=false --include='src/app/features/git-log/git-log.spec.ts'`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/features/git-log
git commit -m "feat(ui): add the git log view"
```

---

### Task 5: Add the Log tab to the bottom panel

**Files:**
- Modify: `packages/ui-angular/src/app/features/bottom-panel/bottom-panel.ts`
- Modify: `packages/ui-angular/src/app/features/bottom-panel/bottom-panel.html`
- Test: `packages/ui-angular/src/app/features/bottom-panel/bottom-panel.spec.ts`

**Interfaces:**
- Consumes: `GitLogView` (Task 4), `MorseService.capabilities()?.gitPanel`.
- Produces: bottom-panel view `{ id: 'git-log', label: 'Git Log', component: GitLogView }`.

- [ ] **Step 1: Write the failing tests**

Extend the spec's `morseStub` with `capabilities: signal<{ gitPanel?: boolean }>({})` and a `setup({ gitPanel })` option. Add:

```ts
it('offers the log only where the host has git', () => {
  const { host } = setup({ gitPanel: false });
  expect([...host.querySelectorAll('.chip')].map((c) => c.textContent?.trim())).toEqual(['Terminal']);
});

it('opens the git log beside the terminal', async () => {
  const { fixture, host } = setup({ gitPanel: true });
  expect([...host.querySelectorAll('.chip')].map((c) => c.textContent?.trim())).toEqual([
    'Terminal',
    'Git Log',
  ]);

  const logChip = [...host.querySelectorAll('.chip-label')][1] as HTMLElement;
  logChip.click();
  fixture.detectChanges();
  await fixture.whenStable();

  expect(host.querySelector('morse-git-log')).not.toBeNull();
});
```

The stub also needs `workspace: signal({ cwd: '/w', name: 'w' })` so `GitPanelState` can read it when the Log mounts.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @morse/ui-angular -- --watch=false --include='src/app/features/bottom-panel/bottom-panel.spec.ts'`
Expected: FAIL — only Terminal is registered.

- [ ] **Step 3: Implement**

In `bottom-panel.ts`, keep `VIEWS` as the terminal entry and add a computed:

```ts
protected readonly views = computed<readonly BottomPanelView[]>(() => {
  const list: BottomPanelView[] = [
    { id: 'terminal', label: 'Terminal', component: TerminalView },
  ];
  if (this.morse.capabilities()?.gitPanel === true) {
    list.push({ id: 'git-log', label: 'Git Log', component: GitLogView });
  }
  return list;
});
```

Template: `@for (view of views(); track view.id)` and `componentFor` reads `views()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @morse/ui-angular -- --watch=false --include='src/app/features/bottom-panel/bottom-panel.spec.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/features/bottom-panel
git commit -m "feat(ui): add the git log tab to the bottom panel"
```

---

### Task 6: Leave only Changes in the right column

**Files:**
- Modify: `packages/ui-angular/src/app/features/git-panel/git-panel.ts`
- Modify: `packages/ui-angular/src/app/features/git-panel/git-panel.html`
- Modify: `packages/ui-angular/src/app/features/git-panel/git-panel.css`
- Modify: `packages/ui-angular/src/app/features/git-panel/git-panel.spec.ts`
- Modify: `packages/ui-angular/src/app/state/layout-state.ts`
- Modify: `packages/ui-angular/src/app/state/layout-state.spec.ts`
- Modify: `packages/ui-angular/src/app/state/shell-state.ts`
- Modify: `packages/ui-angular/src/app/state/shell-state.spec.ts`
- Modify: `packages/ui-angular/src/app/shell/app.ts`
- Modify: `packages/ui-angular/src/app/shell/app.html`
- Modify: `packages/ui-angular/src/app/ui/splitter/splitter.spec.ts`

**Interfaces:**
- Produces: `LayoutState` without `PaneId`; `SizeId` is `RegionId`.
- Produces: `ShellState` without `gitHistoryCollapsed`.
- Produces: `GitPanel` without history markup or the Changes/History splitters.

- [ ] **Step 1: Write the failing tests**

In `git-panel.spec.ts`, add:

```ts
it('leaves history to the bottom panel', async () => {
  const { fixture } = setup(LOG);
  await settle(fixture);
  expect(fixture.nativeElement.querySelector('.history')).toBeNull();
  expect(fixture.nativeElement.querySelector('.commit')).toBeNull();
  expect(fixture.nativeElement.querySelector('.divider')).toBeNull();
});
```

Delete the history-specific tests (`renders commits…`, `caps a long ref…`, `folds a commit's extra branches…`, the full tooltip, `unfolds a commit…`, `shows the full commit when expanded`, and the two resize/fold tests). Their coverage moves to Task 4.

In `layout-state.spec.ts`, delete the `changes`/`detail` pane cases and assert `regions()` only. In `splitter.spec.ts`, switch the host to a region (`'left'`, `edge="right"`, `min=220`) and drag with `clientX`, keeping the same directive coverage.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @morse/ui-angular -- --watch=false --include='src/app/features/git-panel/git-panel.spec.ts' --include='src/app/state/layout-state.spec.ts' --include='src/app/ui/splitter/splitter.spec.ts'`
Expected: FAIL — the history pane and pane sizes still exist.

- [ ] **Step 3: Remove the split**

- `git-panel.html`: drop the history `morse-pane`, the `.divider` and `.detail-divider` splitter blocks, and the `changes-collapsed`/`history-collapsed` classes. The repo detail contains only the Changes pane.
- `git-panel.ts`: remove `historyCollapsed`, `toggleHistory`, `changesHeight`, `detailHeight`, the graph helpers and the history parts of `RepoView` (`entries`, `graphWidth`, `CommitEntry`, `CommitFilesState`). Keep the accordion, branch picker, sync, commit and stage logic.
- `layout-state.ts`: delete `PaneId`, `PANE_MIN/MAX`, `isPane`, the `panes` signal, `SIZE_KEYS` pane entries, `size()`'s pane branch, and `changesSize`/`detailSize`. `SizeId` becomes `RegionId`.
- `shell-state.ts`: remove `gitHistoryCollapsed`, its key and reader.
- `app.ts`/`app.html`: remove `changesHeight`, `detailHeight` and their style bindings.
- CSS: delete the detail sizing rules, the `.divider` rules and the collapsed-section rules; the detail flows under the repo header.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @morse/ui-angular -- --watch=false --include='src/app/features/git-panel/git-panel.spec.ts' --include='src/app/state/layout-state.spec.ts' --include='src/app/ui/splitter/splitter.spec.ts' --include='src/app/state/shell-state.spec.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/features/git-panel \
  packages/ui-angular/src/app/state/layout-state.ts packages/ui-angular/src/app/state/layout-state.spec.ts \
  packages/ui-angular/src/app/state/shell-state.ts packages/ui-angular/src/app/state/shell-state.spec.ts \
  packages/ui-angular/src/app/shell/app.ts packages/ui-angular/src/app/shell/app.html \
  packages/ui-angular/src/app/ui/splitter/splitter.spec.ts
git commit -m "refactor(ui): leave the git column to changes alone"
```

---

### Task 7: Checkbox change list, filter and staged count

**Files:**
- Create: `packages/ui-angular/src/app/features/git-panel/change-list.ts`
- Create: `packages/ui-angular/src/app/features/git-panel/change-list.html`
- Create: `packages/ui-angular/src/app/features/git-panel/change-list.css`
- Create: `packages/ui-angular/src/app/features/git-panel/change-list.spec.ts`
- Modify: `packages/ui-angular/src/app/features/git-panel/git-panel.ts`
- Modify: `packages/ui-angular/src/app/features/git-panel/git-panel.html`
- Modify: `packages/ui-angular/src/app/features/git-panel/git-panel.spec.ts`

**Interfaces:**
- Produces: `ChangeGroupView { id: 'staged' | 'unstaged'; label: string; rows: ChangeView[]; collapsed: boolean }`.
- Produces: `ChangeList` inputs `groups`, outputs `toggleRow: ChangeView` and `toggleGroup: ChangeGroupView`.
- Produces: `GitPanel`'s `changeFilter` input and `stagedCount` title text.

- [ ] **Step 1: Write the failing tests**

`change-list.spec.ts`:

```ts
it('checks staged rows and unchecks unstaged ones', () => {
  const { host } = render([
    { id: 'staged', label: 'Staged', collapsed: false, rows: [{ path: 'a.ts', kind: 'M' }] },
    { id: 'unstaged', label: 'Unstaged', collapsed: false, rows: [{ path: 'b.ts', kind: 'M' }] },
  ]);
  const checks = [...host.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[];
  expect(checks.map((c) => c.checked)).toEqual([true, false]);
});

it('asks to stage an unchecked row and unstage a checked one', () => {
  const { host, toggled } = render([...]);
  (host.querySelectorAll('.change-row input')[1] as HTMLInputElement).click();
  expect(toggled.at(-1)).toMatchObject({ path: 'b.ts', staged: false });
});
```

In `git-panel.spec.ts`:

```ts
it('filters the change rows and counts the staged ones', async () => {
  const { fixture } = setup(LOG, {
    status: {
      isRepo: true,
      files: [
        { path: 'a.ts', status: 'M ' },
        { path: 'b.ts', status: ' M' },
      ],
    },
  });
  await settle(fixture);
  const host = fixture.nativeElement as HTMLElement;
  const filter = host.querySelector('.changes-filter') as HTMLInputElement;
  filter.value = 'a.ts';
  filter.dispatchEvent(new Event('input'));
  fixture.detectChanges();

  expect(host.querySelectorAll('.change-row')).toHaveLength(1);
  expect(host.querySelector('.changes .pane-meta')?.textContent).toContain('1 of 2 staged');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @morse/ui-angular -- --watch=false --include='src/app/features/git-panel/change-list.spec.ts' --include='src/app/features/git-panel/git-panel.spec.ts'`
Expected: FAIL — no `ChangeList`, no filter, no title count.

- [ ] **Step 3: Implement**

- `ChangeList` renders `group.label` with a fold caret, a count, a group checkbox/action, then rows: `input[type=checkbox]`, file icon, name, badge. The checkbox is checked in the staged group and unchecked in unstaged; clicking emits `{ path, staged }` so the panel calls `stage()` or `unstage()`.
- The panel filters `changesFor` by `changeFilter` (case-insensitive path contains), builds the two groups, and shows `x of y staged` in the Changes pane title (`meta`). Empty filter results say "No files match".
- Remove `morse-tree` from the changes section; keep it for the Log's commit files.
- Keep the staged/unstaged fold signals; the group header toggles them.
- Update the `groupByTitle` / `groupFileNames` helpers and the stage/unstage tests in
  `git-panel.spec.ts` to the new `.change-row` markup.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @morse/ui-angular -- --watch=false --include='src/app/features/git-panel/change-list.spec.ts' --include='src/app/features/git-panel/git-panel.spec.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/features/git-panel
git commit -m "feat(ui): add checkbox change rows and a file filter"
```

---

### Task 8: Amend, multi-line message, Commit and Push

**Files:**
- Modify: `packages/ui-angular/src/app/features/git-panel/git-panel.ts`
- Modify: `packages/ui-angular/src/app/features/git-panel/git-panel.html`
- Modify: `packages/ui-angular/src/app/features/git-panel/git-panel.css`
- Test: `packages/ui-angular/src/app/features/git-panel/git-panel.spec.ts`

**Interfaces:**
- Consumes: `GitRepoState.commit(message, amend)` (Task 3), `.push()`.
- Produces: `amend` signal; `submitCommit()` uses it; `commitAndPush()` commits then pushes.

- [ ] **Step 1: Write the failing tests**

```ts
it('amends with an empty message and stands Commit and Push down', async () => {
  const { fixture, fake } = setup(LOG, {
    status: { isRepo: true, files: [{ path: 'a.ts', status: 'M ' }] },
    mutation: { ok: true },
  });
  await settle(fixture);
  const host = fixture.nativeElement as HTMLElement;

  (host.querySelector('.amend input') as HTMLInputElement).click();
  fixture.detectChanges();
  expect((host.querySelector('.commit-push') as HTMLButtonElement).disabled).toBe(true);

  (host.querySelector('.commit-button') as HTMLButtonElement).click();
  await settle(fixture);

  expect(fake.requestHostCommand).toHaveBeenCalledWith(
    'gitCommit',
    { message: '', amend: true },
    60_000,
  );
});

it('commits and pushes in one action', async () => {
  const { fixture, fake } = setup(LOG, {
    status: { isRepo: true, files: [{ path: 'a.ts', status: 'M ' }] },
    mutation: { ok: true },
  });
  await settle(fixture);
  const host = fixture.nativeElement as HTMLElement;

  const input = host.querySelector('.commit-input') as HTMLTextAreaElement;
  input.value = 'ship it';
  input.dispatchEvent(new Event('input'));
  (host.querySelector('.commit-push') as HTMLButtonElement).click();
  await settle(fixture);

  expect(fake.requestHostCommand).toHaveBeenCalledWith(
    'gitCommit',
    { message: 'ship it', amend: false },
    60_000,
  );
  expect(fake.requestHostCommand).toHaveBeenCalledWith('gitPush', undefined, 180_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @morse/ui-angular -- --watch=false --include='src/app/features/git-panel/git-panel.spec.ts'`
Expected: FAIL — no amend control, no push button, the input is single-line.

- [ ] **Step 3: Implement**

- Replace the commit input with a `textarea.commit-input`; `Ctrl/Cmd+Enter` calls `submitCommit()`.
- Add an `Amend` checkbox bound to `amend`; `submitCommit()` calls `state.commit(message, amend())` and skips the client-side empty check when amend is on. `canCommit` becomes `amend() || (staged and message)` — an amend may rewrite only the message, with nothing staged.
- Add a `Commit and Push` button (class `commit-push`) that runs `commit(..., amend())` then `push()` on success; disable it while `amend()` is true, with a title explaining that amend rewrites the last commit.
- Keep the existing refusal message for non-amend empty messages.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @morse/ui-angular -- --watch=false --include='src/app/features/git-panel/git-panel.spec.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui-angular/src/app/features/git-panel
git commit -m "feat(ui): amend and commit-and-push from the git column"
```

---

### Task 9: Full gate and docs

**Files:**
- Test: whole repo

- [ ] **Step 1: Run the full gate**

Run: `npm run test:fast`
Expected: every workspace passes, including the new server, state, log, panel and change-list specs.

- [ ] **Step 2: Commit the design and plan if they are still untracked**

```bash
git add docs/superpowers/specs/2026-11-13-git-commit-and-log-split-design.md \
  docs/superpowers/plans/2026-11-13-git-commit-and-log-split.md
git commit -m "docs: plan the commit sidebar and bottom log"
```

- [ ] **Step 3: Confirm the tree is clean**

Run: `git status --short`
Expected: no output.
