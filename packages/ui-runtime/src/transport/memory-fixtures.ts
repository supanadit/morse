/**
 * Everything the mock host serves: scripted sessions, projects, git history,
 * files, prompts and the small URL switches a dev page uses to reveal a feature.
 * Data only; the transport that answers with it stays in `memory-transport.ts`.
 */
import type {
  GitCommit,
  HostCapabilities,
  PromptTemplateInfo,
  ProjectSummary,
  SessionSummary,
  ThinkingLevel,
  TranscriptItem,
  WorkspaceSearchResult,
} from '@morse/protocol';

export const WORKSPACE = { cwd: '/mock/workspace', name: 'mock-workspace' };

export const CAPABILITIES: HostCapabilities = {
  hostKind: 'server',
  scope: isWorkspaceScoped() ? 'workspace' : 'global',
  editorContext: false,
  nativeDialogs: false,
  insertIntoEditor: false,
  revealFile: false,
  // Two engines, so the draft's engine picker is reviewable with no server.
  engines: [
    { kind: 'pi', label: 'pi', default: true },
    { kind: 'opencode', label: 'OpenCode' },
  ],
  filePicker: true,
  // The mock can draw the browser-only git panel from a scripted history, so
  // the panel and its graph are reviewable without a server or a real repo.
  gitPanel: true,
  // Same for the search panel: a scripted answer draws the grouped rows, the
  // highlights and the ripgrep notice with no filesystem behind them.
  searchPanel: true,
  // The mock host fakes an upload inbox so the browser-only flow is exercisable
  // without running the NestJS server.
  fileUpload: true,
  // Same for the "New session" folder browser: the mock answers a tiny tree so
  // the modal can be developed with no server.
  directoryPicker: true,
  // The mock fakes a tiny shell so the bottom panel and its terminal are
  // reviewable without the NestJS server.
  terminal: true,
  // Same for the MCP manager: a scripted server list lets the indicator and the
  // panel be developed with no `pi` call.
  mcp: true,
  // The prompt-template editor reads and writes `.md` files; the mock serves a
  // scripted pair so the editor and its tester can be developed with no disk.
  promptEditor: true,
  // Off by default: a dev page must not reach the internet unless it was asked
  // for. `?mock=1&update=1` turns it on, and `?newer=<version>` (frontend side)
  // fakes the published version, so the notice is reviewable before a release.
  updateCheck: isUpdateCheckWanted(),
  // A representative installed pi version, so the pi notice can be reviewed too
  // (`?mock=1&update=1`, or `?newer-pi=<version>` without a request).
  ...(isUpdateCheckWanted() ? { piVersion: '1.0.3' } : {}),
  // `?mock=1&self-update=1` makes the mock claim it can install its own update,
  // so the footer's update button is reviewable without a real NestJS host.
  ...(isSelfUpdateWanted() ? { selfUpdate: true } : {}),
};

/** `?mock=1&self-update=1`: let the mock offer the one-click update button. */
function isSelfUpdateWanted(): boolean {
  if (typeof location === 'undefined') {
    return false;
  }
  return new URL(location.href, 'http://localhost/').searchParams.get('self-update') === '1';
}

/** `?mock=1&update=1`: let the release check run against the real registry. */
function isUpdateCheckWanted(): boolean {
  if (typeof location === 'undefined') {
    return false;
  }
  return new URL(location.href, 'http://localhost/').searchParams.get('update') === '1';
}

/** `?mock=1&diagnostics=1`: show pi's configuration-warning row in the mock host. */
export function wantsDiagnosticsPreview(): boolean {
  if (typeof location === 'undefined') {
    return false;
  }
  return new URL(location.href, 'http://localhost/').searchParams.get('diagnostics') === '1';
}

/**
 * Mock reasoning levels per model, so switching models visibly changes the
 * thinking picker — the behaviour a real pi reports per current model.
 */
export const MOCK_THINKING: Record<string, ThinkingLevel[]> = {
  'mock/mock-1': ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'mock/mock-2': ['off', 'low', 'high'],
  'mock-cloud/mock-1': ['off', 'medium', 'high'],
  'mock-cloud/mock-3': ['off'],
};

export function mockThinkingLevels(provider: string, id: string): ThinkingLevel[] {
  return MOCK_THINKING[`${provider}/${id}`] ?? ['off', 'low', 'high'];
}

/** OpenCode-shaped modes for the mock, so the pill and its live switch are visible. */
export const MOCK_MODES = [
  { id: 'build', name: 'Build', description: 'The default agent. Executes tools.', default: true },
  { id: 'plan', name: 'Plan', description: 'Think before acting.' },
];

/**
 * The search panel's scripted answer: the query echoed into two files, so
 * typing redraws real-looking rows — grouping, counts and a highlight that
 * lands on the word. `engine: 'node'` on purpose: it is what keeps the panel's
 * "install ripgrep" notice visible in the mock too.
 */
export function mockSearchResult(query: string): WorkspaceSearchResult {
  const term = query.trim();
  if (term.length === 0) {
    return { files: [], total: 0, truncated: false, engine: 'node' };
  }
  return {
    files: [
      {
        path: 'src/mock.ts',
        count: 1,
        lines: [
          { line: 7, text: `// ${term} appears in this scripted line`, columns: [4] },
        ],
      },
      {
        path: 'README.md',
        count: 1,
        lines: [{ line: 3, text: `Searching for ${term} without a disk.`, columns: [15] }],
      },
    ],
    total: 2,
    truncated: false,
    engine: 'node',
  };
}

/**
 * A scripted git history with a branch and a merge, so the panel's list and the
 * lane graph are both exercisable under `?mock=1`. Synthetic hashes; nothing is
 * read from disk.
 */
export const MOCK_GIT_LOG = {
  isRepo: true,
  root: '/mock/workspace',
  branch: 'main',
  commits: [
    mockCommit('f1a2b3c4', 'Add the git panel to the browser host', ['e2f3a4b5'], ['HEAD -> main'], 2),
    mockCommit('e2f3a4b5', 'Merge branch feature/graph', ['d3e4f5a6', 'c4d5e6f7'], ['origin/main'], 5),
    mockCommit('d3e4f5a6', 'Wire the graph lanes', ['b5c6d7e8'], [], 8),
    mockCommit('c4d5e6f7', 'Fix the lane colours in light mode', ['b5c6d7e8'], [], 11),
    mockCommit('b5c6d7e8', 'Bump the protocol version', ['a6b7c8d9'], ['tag: v0.8.0'], 26),
    mockCommit('a6b7c8d9', 'Initial commit', [], [], 52),
  ],
};

export function mockCommit(
  hash: string,
  subject: string,
  parents: string[],
  refs: string[],
  ageHours: number,
): GitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    refs,
    author: 'Morse Dev',
    date: new Date(Date.now() - ageHours * 3_600_000).toISOString(),
    subject,
  };
}

/** The scripted commits an ancestry walk from `ref`'s tip keeps, newest first. */
export function commitsReachableFrom(commits: GitCommit[], ref: string): GitCommit[] {
  const tip = commits.find((commit) =>
    commit.refs.some(
      (name) => name === ref || name.endsWith(` -> ${ref}`) || name === `tag: ${ref}`,
    ),
  );
  if (tip === undefined) {
    return commits;
  }
  const kept = new Set<string>([tip.hash]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const commit of commits) {
      if (!kept.has(commit.hash)) {
        continue;
      }
      for (const parent of commit.parents) {
        if (!kept.has(parent)) {
          kept.add(parent);
          grew = true;
        }
      }
    }
  }
  return commits.filter((commit) => kept.has(commit.hash));
}

/**
 * A scripted pair of repositories — the project's own plus a nested checkout — so
 * the panel's multi-repository accordion is reviewable under `?mock=1`. Other git
 * commands ignore the `repo` argument in the mock and answer the same scripted
 * data, which is enough to exercise the sections and their folds.
 */
export const MOCK_GIT_REPOS = {
  isRepo: true,
  repos: [
    {
      path: '',
      root: '/mock/workspace',
      name: 'mock-workspace',
      current: true,
      branch: 'master',
    },
    {
      path: 'packages/morse-web',
      root: '/mock/workspace/packages/morse-web',
      name: 'morse-web',
      current: false,
      branch: 'feat/web-repos',
    },
  ],
};

/** A scripted working-tree status, so the Explorer's git badges are reviewable. */
export const MOCK_GIT_STATUS = {
  isRepo: true,
  files: [
    { path: 'README.md', status: ' M' },
    { path: 'package.json', status: ' M' },
    { path: 'packages/protocol/src/wire.ts', status: 'A ' },
    { path: 'packages/ui-angular/src/app/core/markdown.ts', status: '??' },
  ],
};

/** A scripted unified diff, so the preview's diff modes are reviewable. */
export const MOCK_GIT_DIFF = [
  'diff --git a/README.md b/README.md',
  'index 1111111..2222222 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,4 +1,5 @@',
  ' # Morse',
  ' ',
  '-An old line',
  '+A new line',
  '+A line that was added',
  ' A line that stayed',
  '',
].join('\n');

/** A small stand-in workspace, so the file picker can be exercised without a host. */
export const MOCK_FILES = [
  'AGENTS.md',
  'README.md',
  'package.json',
  'packages/core/src/chat/service.ts',
  'packages/core/src/domain.ts',
  'packages/core/src/session/service.ts',
  'packages/host/src/session-controller.ts',
  'packages/protocol/src/wire.ts',
  'packages/ui-angular/src/app/app.ts',
  'packages/ui-angular/src/app/chat/chat-composer/chat-composer.ts',
  'packages/ui-angular/src/app/core/markdown.ts',
  'packages/ui-runtime/src/client.ts',
];

/** Two scripted prompt templates, so the editor and its argument tester work under `?mock=1`. */
export const MOCK_PROMPTS: PromptTemplateInfo[] = [
  {
    name: 'review',
    scope: 'global',
    path: '~/.pi/agent/prompts/review.md',
    description: 'Review staged git changes',
    argumentHint: '[focus]',
    body: 'Review the staged changes. Focus on ${1:-correctness, security, and error handling}.',
    raw: '---\ndescription: Review staged git changes\nargument-hint: "[focus]"\n---\nReview the staged changes. Focus on ${1:-correctness, security, and error handling}.\n',
  },
  {
    name: 'test',
    scope: 'project',
    path: '/repo/.pi/prompts/test.md',
    description: 'Run the tests for a path',
    argumentHint: '<path>',
    body: 'Run the test suite for $1.',
    raw: '---\ndescription: Run the tests for a path\nargument-hint: "<path>"\n---\nRun the test suite for $1.\n',
  },
];

/** Upsert a template from the editor's save args, with a crude frontmatter strip. */
export function applyMockPromptSave(
  prompts: PromptTemplateInfo[],
  args: Record<string, unknown> | undefined,
): void {
  const name = typeof args?.name === 'string' ? args.name : '';
  if (name.length === 0) {
    return;
  }
  const scope = args?.scope === 'project' ? 'project' : 'global';
  const originalName = typeof args?.originalName === 'string' ? args.originalName : undefined;
  const originalScope =
    args?.originalScope === 'project' || args?.originalScope === 'global'
      ? args.originalScope
      : undefined;
  if (
    originalName !== undefined &&
    originalScope !== undefined &&
    (originalName !== name || originalScope !== scope)
  ) {
    const old = prompts.findIndex((t) => t.name === originalName && t.scope === originalScope);
    if (old !== -1) {
      prompts.splice(old, 1);
    }
  }
  const raw = typeof args?.raw === 'string' ? args.raw : '';
  const info: PromptTemplateInfo = {
    name,
    scope,
    path:
      scope === 'project'
        ? `/repo/.pi/prompts/${name}.md`
        : `~/.pi/agent/prompts/${name}.md`,
    body: raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim(),
    raw,
  };
  const description = /^description:[ \t]*(.+)$/m.exec(raw)?.[1]?.trim().replace(/^"|"$/g, '');
  if (description) {
    info.description = description;
  }
  const hint = /^argument-hint:[ \t]*(.+)$/m.exec(raw)?.[1]?.trim().replace(/^"|"$/g, '');
  if (hint) {
    info.argumentHint = hint;
  }
  const index = prompts.findIndex((t) => t.name === name && t.scope === scope);
  if (index === -1) {
    prompts.push(info);
  } else {
    prompts[index] = info;
  }
}

/** A tiny directory tree so the browser-only "choose a folder" modal is usable
 *  under `?mock=1`. Paths are synthetic; nothing is read from disk. */
export const MOCK_TREE: Record<string, { name: string; path: string }[]> = {
  '/mock': [
    { name: 'home', path: '/mock/home' },
    { name: 'projects', path: '/mock/projects' },
    { name: 'workspace', path: '/mock/workspace' },
  ],
  '/mock/home': [{ name: 'projects', path: '/mock/home/projects' }],
  '/mock/home/projects': [],
  '/mock/projects': [
    { name: 'morse', path: '/mock/projects/morse' },
    { name: 'other', path: '/mock/projects/other' },
  ],
  '/mock/projects/morse': [{ name: 'packages', path: '/mock/projects/morse/packages' }],
  '/mock/projects/other': [],
  '/mock/projects/morse/packages': [],
  '/mock/workspace': [],
};

export function mockDirectoryListing(rawPath: unknown): unknown {
  const path =
    typeof rawPath === 'string' && rawPath.trim().length > 0 ? rawPath.trim() : WORKSPACE.cwd;
  const parent = path === '/mock' ? undefined : path.slice(0, path.lastIndexOf('/')) || '/';
  return {
    path,
    parent,
    directories: MOCK_TREE[path] ?? [],
    isGitRepo: path === '/mock/projects/morse',
    canOpen: true,
    roots: [
      { name: 'mock', path: '/mock' },
      { name: 'workspace', path: WORKSPACE.cwd },
    ],
  };
}

export function chunkText(text: string): string[] {
  return text.match(/.{1,14}/g) ?? [];
}

export function isWorkspaceScoped(): boolean {
  // `?scope=workspace` makes the mock host behave like the VS Code webview
  // (scoped to one folder) — handy while working on the UI.
  if (typeof location === 'undefined') {
    return false;
  }
  return new URL(location.href).searchParams.get('scope') === 'workspace';
}

export function isBlankSession(): boolean {
  // `?empty=1` starts the mock with a blank transcript, so the empty-state hero
  // (and the cold-start handoff into it) can be seen without running pi.
  if (typeof location === 'undefined') {
    return false;
  }
  return new URL(location.href).searchParams.get('empty') === '1';
}

export function mockSessions(): SessionSummary[] {
  const now = Date.now();
  const here: SessionSummary[] = [
    {
      id: '/mock/morse/2026-01-01_ui-overhaul.jsonl',
      title: 'Sidebar overhaul: projects, sessions, composer',
      cwd: WORKSPACE.cwd,
      updatedAt: now - 60_000,
      messageCount: 12,
    },
    {
      id: '/mock/morse/2026-01-01_scrollbar.jsonl',
      title: 'Improve native scrollbar: compact and themed',
      cwd: WORKSPACE.cwd,
      updatedAt: now - 7 * 60_000,
      messageCount: 6,
    },
  ];
  if (isWorkspaceScoped()) {
    return here;
  }
  return [
    ...here,
    {
      id: '/mock/morse/2026-01-01_providers.jsonl',
      title: 'Add provider picker with context sizes',
      cwd: '/mock/morse',
      updatedAt: now - 20 * 60_000,
      messageCount: 24,
    },
    {
      id: '/mock/morse/2026-01-01_greeting.jsonl',
      title: 'Greeting',
      cwd: '/mock/morse',
      updatedAt: now - 3 * 60 * 60_000,
      messageCount: 2,
    },
    {
      id: '/mock/eigen-morph/2026-01-01_manifest.jsonl',
      title: 'Manifest report-worker untuk production',
      cwd: '/mock/eigen-morph',
      updatedAt: now - 26 * 60 * 60_000,
      messageCount: 31,
    },
  ];
}

export function mockProjects(): ProjectSummary[] {  const byPath = new Map<string, ProjectSummary>();
  for (const session of mockSessions()) {
    const existing = byPath.get(session.cwd);
    if (existing) {
      existing.sessionCount += 1;
      existing.lastUsedAt = Math.max(existing.lastUsedAt, session.updatedAt);
      continue;
    }
    byPath.set(session.cwd, {
      path: session.cwd,
      name: session.cwd.split('/').filter(Boolean).at(-1) ?? session.cwd,
      sessionCount: 1,
      lastUsedAt: session.updatedAt,
    });
  }
  return [...byPath.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt);
}

/**
 * A realistic sample conversation (markdown, thinking, a five-action tool turn
 * and a notice) so the UI can be developed and screenshotted with content that
 * looks like the real thing.
 */
export function mockConversation(): TranscriptItem[] {
  const now = Date.now();
  const plan = [
    'Plan:',
    '',
    '1. **Navigation** — projects → sessions, collapsible, with a session search and a project filter.',
    '2. **Header** — session title, scope, status badge, `Compact`, and the sidebar fold.',
    '3. **Composer** — model + thinking + send in one control row.',
    '',
    'Two shapes, because the hosts differ: the browser host is *global* (many projects), VS Code is scoped to the folders it has open.',
    '',
    '```ts',
    'export class SessionNav {',
    "  protected readonly scope = computed(() => this.morse.capabilities()?.scope ?? 'global');",
    '',
    '  protected readonly groups = computed(() => {',
    '    return this.scope() === "global"',
    '      ? this.projects().map((project) => ({ ... }))',
    '      : [{ path: this.workspace().cwd, name: this.workspace().name, sessions }];',
    '  });',
    '}',
    '```',
    '',
    'And a small overview of what each scope renders:',
    '',
    '| Host | Scope | Navigation shape |',
    '|---|---|---|',
    '| NestJS browser | `global` | projects → sessions |',
    '| VS Code | `workspace` | one group (open folders) |',
    '',
    'See `docs/FRONTENDS.md` for the rule that frontends must read capabilities instead of guessing.',
  ].join('\n');

  return [
    {
      kind: 'user',
      id: 'mock-seed-user-1',
      at: now - 150_000,
      text: 'Refactor the sidebar to match the reference, make it responsive, and render markdown properly.',
    },
    {
      kind: 'tool',
      id: 'mock-seed-tool-1',
      at: now - 140_000,
      name: 'bash',
      title: 'bash: ls packages/ui-angular/src/app',
      status: 'ok',
      output: 'app.css  app.html  app.ts  chat/  core/  nav/',
      durationMs: 12,
    },
    {
      kind: 'tool',
      id: 'mock-seed-tool-2',
      at: now - 138_000,
      name: 'read',
      title: 'read: packages/ui-angular/src/app/app.css',
      status: 'ok',
      output: '42 lines, 4 media queries',
      durationMs: 8,
    },
    {
      kind: 'tool',
      id: 'mock-seed-tool-3',
      at: now - 130_000,
      name: 'edit',
      title: 'edit: packages/ui-angular/src/app/nav/session-nav.ts',
      status: 'ok',
      output: '+26 -7',
      durationMs: 190,
    },
    {
      kind: 'tool',
      id: 'mock-seed-tool-4',
      at: now - 128_000,
      name: 'edit',
      title: 'edit: packages/ui-angular/src/app/app.css',
      status: 'ok',
      output: '+18 -4',
      durationMs: 140,
    },
    {
      kind: 'tool',
      id: 'mock-seed-tool-5',
      at: now - 1_800,
      name: 'bash',
      title: 'bash: npm run build:ui',
      status: 'running',
      output: 'Application bundle generation complete. [1.2 seconds]',
    },
    {
      kind: 'assistant',
      id: 'mock-seed-assistant-1',
      at: now - 100_000,
      text: plan,
      thinking:
        'The webview is narrow, so the navigation has to become a drawer below ~760px instead of a second column.',
      streaming: false,
      model: 'Mock Model',
    },
    {
      kind: 'notice',
      id: 'mock-seed-notice-1',
      at: now - 60_000,
      level: 'info',
      text: 'Everything is wired through the same wire protocol — try ?scope=workspace to see the VS Code shape.',
    },
  ];
}
