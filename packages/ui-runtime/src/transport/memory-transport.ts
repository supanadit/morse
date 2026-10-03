import {
  PROTOCOL_VERSION,
  type ClientToHostMessage,
  type HostCapabilities,
  type HostToClientMessage,
  type ProjectSummary,
  type SessionActivity,
  type SessionSummary,
  type SessionViewState,
  type TranscriptItem,
} from '@morse/protocol';
import { BaseHostTransport } from './host-transport.js';

const WORKSPACE = { cwd: '/mock/workspace', name: 'mock-workspace' };

const CAPABILITIES: HostCapabilities = {
  hostKind: 'server',
  scope: isWorkspaceScoped() ? 'workspace' : 'global',
  editorContext: false,
  nativeDialogs: false,
  insertIntoEditor: false,
  revealFile: false,
  filePicker: true,
  // The mock host fakes an upload inbox so the browser-only flow is exercisable
  // without running the NestJS server.
  fileUpload: true,
  // Same for the "New session" folder browser: the mock answers a tiny tree so
  // the modal can be developed with no server.
  directoryPicker: true,
};

/**
 * Scripted host used when there is no backend at all (`ng serve --mock`, tests).
 * It exists so frontend authors can iterate on the UI — and on a new framework —
 * without running VS Code or the NestJS server.
 */
export class MemoryHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;

  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private items: TranscriptItem[] = isBlankSession() ? [] : mockConversation();
  /** Persisted-looking catalog; `session/new` prepends to it like a real host. */
  private sessions: SessionSummary[] = mockSessions();
  /** Registry keys of live agent processes, so several can animate at once. */
  private readonly hot = new Set<string>(this.sessions.slice(0, 2).map((s) => s.id));
  /** Starts high so generated ids cannot collide with the fixture's own ids. */
  private counter = 100;
  private disposed = false;
  private streaming = false;
  private state: SessionViewState = {
    workspace: WORKSPACE,
    model: { provider: 'mock', id: 'mock-1', name: 'Mock Model', contextWindow: 1_000_000, maxTokens: 32_768 },
    thinkingLevel: 'low',
    availableModels: [
      { provider: 'mock', id: 'mock-1', name: 'Mock Model', contextWindow: 128_000 },
      { provider: 'mock', id: 'mock-2', name: 'Mock Model (fast)', contextWindow: 262_144 },
      // A second provider with the same display name: the picker must group them,
      // otherwise the user cannot tell which provider a model belongs to.
      { provider: 'mock-cloud', id: 'mock-1', name: 'Mock Model', contextWindow: 200_000 },
      { provider: 'mock-cloud', id: 'mock-3', name: 'Mock Model (pro)', contextWindow: 1_000_000 },
    ],
    availableThinkingLevels: ['off', 'low', 'high'],
    availableCommands: [
      { name: 'skill:codebase-memory', description: 'Query the knowledge graph', source: 'skill' },
      { name: 'fix-tests', description: 'Fix failing tests', source: 'prompt' },
    ],
    streaming: false,
    // A realistic footer: cumulative tokens, cache split and context window.
    usage: {
      inputTokens: 56_400,
      outputTokens: 35_200,
      totalTokens: 91_600,
      cacheReadTokens: 2_800_000,
      cacheWriteTokens: 12_000,
    },
    lastUsage: {
      inputTokens: 12_400,
      outputTokens: 668,
      totalTokens: 13_068,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 0,
      reasoningTokens: 1_066,
    },
    costUsd: 0.42,
    contextUsage: { tokens: 79_000, contextWindow: 1_000_000, percent: 7.9 },
    counts: {
      userMessages: 10,
      assistantMessages: 165,
      toolCalls: 42,
      toolResults: 42,
      totalMessages: 200,
    },
    // The fixture keeps one call running, so the host must look busy too.
    busy: this.items.some((item) => item.kind === 'tool' && item.status === 'running'),
    agentReady: true,
    agentStarting: false,
  };

  connect(): void {
    this.disposed = false;
    this.emitStatus('open', 'in-memory mock host');
    this.finishFixtureRun();
    // `?autorun=1` plays a run, so a live transcript can be screenshotted (or
    // just watched) without typing.
    if (typeof location !== 'undefined' && new URL(location.href).searchParams.get('autorun')) {
      this.schedule(() => this.simulateRun('Refactor the sidebar and make it responsive.'), 1_500);
    }
  }

  /**
   * The fixture ships with one tool still running; finishing it after a few
   * seconds exercises the real behaviour — the process timeline opens while the
   * agent works and collapses once it starts writing the response.
   */
  private finishFixtureRun(): void {
    const running = this.items.find((item) => item.kind === 'tool' && item.status === 'running');
    if (!running || running.kind !== 'tool') {
      return;
    }
    this.schedule(() => {
      running.status = 'ok';
      running.durationMs = 3_100;
      this.emit({ type: 'transcript/update', payload: { ...running } });
      this.state = { ...this.state, busy: false };
      this.emit({ type: 'session/state', payload: this.state });
    }, 6_000);
  }

  send(message: ClientToHostMessage): void {
    switch (message.type) {
      case 'client/ready':
        this.emit({ type: 'transcript/replace', payload: { items: this.items } });
        this.emit({ type: 'project/list', payload: { projects: mockProjects() } });
        this.emit({ type: 'session/list', payload: { sessions: this.sessions } });
        this.emitActivity();
        this.emit({
          type: 'host/ready',
          payload: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: CAPABILITIES,
            state: this.state,
            // Echo what the client said it is, so the UI developed against this
            // host sees the same identity a real host reports (its manifest).
            ...(message.payload.frontend ? { frontend: message.payload.frontend } : {}),
          },
        });
        return;
      case 'chat/prompt':
        this.simulateRun(message.payload.text);
        return;
      case 'chat/abort':
        this.abortRun();
        return;
      case 'session/new': {
        this.items = [];
        this.emit({ type: 'transcript/replace', payload: { items: [] } });
        // A real host publishes the fresh session immediately, even before pi
        // has persisted it, otherwise the new session is nowhere in the list.
        const summary: SessionSummary = {
          id: this.nextId('session'),
          title: 'New session',
          cwd: WORKSPACE.cwd,
          updatedAt: Date.now(),
          messageCount: 0,
        };
        this.sessions = [summary, ...this.sessions];
        this.hot.add(summary.id);
        this.state = {
          ...this.state,
          sessionId: summary.id,
          sessionTitle: summary.title,
          streaming: false,
        };
        this.emit({ type: 'session/list', payload: { sessions: this.sessions } });
        this.emit({ type: 'session/state', payload: this.state });
        this.emitActivity();
        return;
      }
      case 'session/list':
        this.emit({ type: 'session/list', payload: { sessions: this.sessions } });
        return;
      case 'project/list':
        this.emit({ type: 'project/list', payload: { projects: mockProjects() } });
        return;
      case 'project/open':
      case 'session/activate':
      case 'session/load':
        this.notify('info', 'Mock host: switched session.');
        return;
      case 'session/close':
        this.notify('warn', 'Mock host: closing sessions is a no-op.');
        return;
      case 'session/compact':
        this.notify('success', 'Mock host: context compacted.');
        return;
      case 'model/set': {
        const known = this.state.availableModels.find(
          (model) =>
            model.provider === message.payload.provider && model.id === message.payload.id,
        );
        this.state = {
          ...this.state,
          model: known
            ? { ...known }
            : { provider: message.payload.provider, id: message.payload.id, name: message.payload.id },
        };
        this.emit({ type: 'session/state', payload: this.state });
        return;
      }
      case 'thinking/set':
        this.state = { ...this.state, thinkingLevel: message.payload.level };
        this.emit({ type: 'session/state', payload: this.state });
        return;
      case 'interaction/respond':
        this.emit({
          type: 'interaction/dismiss',
          payload: { requestId: message.payload.requestId },
        });
        return;
      case 'host/command':
        if (message.payload.command === 'listFiles' && message.payload.requestId) {
          this.emit({
            type: 'host/command/result',
            payload: { requestId: message.payload.requestId, ok: true, data: { files: MOCK_FILES } },
          });
          return;
        }
        if (message.payload.command === 'uploadFile' && message.payload.requestId) {
          const name =
            typeof message.payload.args?.name === 'string'
              ? message.payload.args.name
              : 'upload.bin';
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: { path: `.morse/uploads/${name}`, name, bytes: 0 },
            },
          });
          return;
        }
        if (message.payload.command === 'listDirectories' && message.payload.requestId) {
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: mockDirectoryListing(message.payload.args?.path),
            },
          });
          return;
        }
        this.notify('warn', `The mock host does not implement "${message.payload.command}".`);
        return;
      default:
        return;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abortRun();
    this.emitStatus('closed');
  }

  /**
   * A scripted run that follows pi's real shape: thinking -> tool -> thinking ->
   * tool -> answer, with `streaming` staying true for the whole run. Fixtures
   * that skip phases hide real bugs (a progress indicator that blinks per step,
   * for instance), so the phases are all here.
   */
  private simulateRun(prompt: string): void {
    if (this.streaming) {
      this.notify('warn', 'A mock run is already streaming.');
      return;
    }
    this.streaming = true;
    this.appendItem({
      kind: 'user',
      id: this.nextId('user'),
      at: Date.now(),
      text: prompt,
    });
    this.emit({ type: 'session/state', payload: { ...this.state, streaming: true } });
    this.emitActivity();

    let delay = 0;

    const plan = [
      {
        thinking: 'Let me find where the sidebar is built before I touch anything.',
        tool: {
          name: 'bash',
          title: 'bash: ls packages/ui-angular/src/app',
          output: 'app.css  app.html  app.ts  chat/  core/  nav/',
        },
      },
      {
        thinking: 'Found it. Now check the navigation component and the styles it relies on.',
        tool: {
          name: 'read',
          title: 'read: packages/ui-angular/src/app/nav/session-nav.ts',
          output: '1  import { Component } from "@angular/core";\n2  ... 38 lines',
        },
      },
    ];

    for (const step of plan) {
      const assistantId = this.nextId('assistant');
      this.schedule(() => {
        this.appendItem({
          kind: 'assistant',
          id: assistantId,
          at: Date.now(),
          text: '',
          thinking: '',
          streaming: true,
          model: this.state.model?.name,
        });
      }, delay);
      delay += 40;

      for (const chunk of chunkText(step.thinking)) {
        const part = chunk;
        this.schedule(() => {
          this.emit({
            type: 'transcript/delta',
            payload: { id: assistantId, thinking: part },
          });
        }, delay);
        delay += 55;
      }

      // The assistant message ends and its tool call starts running.
      const toolId = this.nextId('tool');
      this.schedule(() => {
        this.updateItem({
          kind: 'assistant',
          id: assistantId,
          at: Date.now(),
          text: '',
          thinking: step.thinking,
          streaming: false,
          model: this.state.model?.name,
        });
        this.appendItem({
          kind: 'tool',
          id: toolId,
          at: Date.now(),
          name: step.tool.name,
          title: step.tool.title,
          status: 'running',
        });
      }, delay);
      delay += 900;

      const started = delay;
      this.schedule(() => {
        this.updateItem({
          kind: 'tool',
          id: toolId,
          at: Date.now(),
          name: step.tool.name,
          title: step.tool.title,
          status: 'ok',
          output: step.tool.output,
          durationMs: started,
        });
      }, delay);
      delay += 200;
    }

    const reply =
      `Mock host received: "${prompt}".\n\n` +
      'This response is produced in the browser, with no pi process and no server, ' +
      'so you can iterate on the frontend (or a new frontend framework) freely.';
    const assistantId = this.nextId('assistant');
    this.schedule(() => {
      this.appendItem({
        kind: 'assistant',
        id: assistantId,
        at: Date.now(),
        text: '',
        thinking: '',
        streaming: true,
        model: this.state.model?.name,
      });
    }, delay);
    delay += 40;

    for (const chunk of chunkText(reply)) {
      const part = chunk;
      this.schedule(() => {
        this.emit({ type: 'transcript/delta', payload: { id: assistantId, text: part } });
      }, delay);
      delay += 55;
    }

    // Only a settled run clears the flag, exactly like the real host.
    this.schedule(() => {
      this.streaming = false;
      this.updateItem({
        kind: 'assistant',
        id: assistantId,
        at: Date.now(),
        text: reply,
        thinking: '',
        streaming: false,
        model: this.state.model?.name,
      });
      this.emit({ type: 'session/state', payload: { ...this.state, streaming: false } });
      this.emitActivity();
    }, delay + 80);
  }

  private appendItem(item: TranscriptItem): void {
    this.items = [...this.items, item];
    this.emit({ type: 'transcript/append', payload: item });
  }

  private updateItem(item: TranscriptItem): void {
    this.items = this.items.map((existing) => (existing.id === item.id ? item : existing));
    this.emit({ type: 'transcript/update', payload: item });
  }

  private abortRun(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    if (this.streaming) {
      this.streaming = false;
      this.emitActivity();
    }
  }

  private notify(level: 'info' | 'warn' | 'error' | 'success', text: string): void {
    this.emit({ type: 'notice', payload: { level, text, at: Date.now() } });
  }

  private schedule(action: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) {
        action();
      }
    }, delayMs);
    this.timers.add(timer);
  }

  private nextId(kind: string): string {
    this.counter += 1;
    return `mock-${kind}-${this.counter}`;
  }

  /**
   * The live sessions, so the navigator's multi-active shape is exercisable
   * without a real host. In production every entry comes from an actual hot
   * agent process; here it is the `hot` set.
   */
  private emitActivity(): void {
    const sessions: SessionActivity[] = this.sessions
      .filter((session) => this.hot.has(session.id))
      .slice(0, 4)
      .map((session) => ({
        sessionKey: session.id,
        streaming: this.streaming,
        busy: false,
        agentReady: true,
        agentStarting: false,
      }));
    this.emit({ type: 'session/activity', payload: { sessions } });
  }

  private emit(message: HostToClientMessage): void {
    this.emitMessage(message);
  }
}

/** A small stand-in workspace, so the file picker can be exercised without a host. */
const MOCK_FILES = [
  'AGENTS.md',
  'README.md',
  'package.json',
  'packages/core/src/chat/service.ts',
  'packages/core/src/domain.ts',
  'packages/core/src/session/service.ts',
  'packages/host-runtime/src/session-controller.ts',
  'packages/protocol/src/wire.ts',
  'packages/ui-angular/src/app/app.ts',
  'packages/ui-angular/src/app/chat/chat-composer/chat-composer.ts',
  'packages/ui-angular/src/app/core/markdown.ts',
  'packages/ui-runtime/src/client.ts',
];

/** A tiny directory tree so the browser-only "choose a folder" modal is usable
 *  under `?mock=1`. Paths are synthetic; nothing is read from disk. */
const MOCK_TREE: Record<string, { name: string; path: string }[]> = {
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

function mockDirectoryListing(rawPath: unknown): unknown {
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

function chunkText(text: string): string[] {
  return text.match(/.{1,14}/g) ?? [];
}

function isWorkspaceScoped(): boolean {
  // `?scope=workspace` makes the mock host behave like the VS Code webview
  // (scoped to one folder) — handy while working on the UI.
  if (typeof location === 'undefined') {
    return false;
  }
  return new URL(location.href).searchParams.get('scope') === 'workspace';
}

function isBlankSession(): boolean {
  // `?empty=1` starts the mock with a blank transcript, so the empty-state hero
  // (and the cold-start handoff into it) can be seen without running pi.
  if (typeof location === 'undefined') {
    return false;
  }
  return new URL(location.href).searchParams.get('empty') === '1';
}

function mockSessions(): SessionSummary[] {
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

function mockProjects(): ProjectSummary[] {  const byPath = new Map<string, ProjectSummary>();
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
function mockConversation(): TranscriptItem[] {
  const now = Date.now();
  const plan = [
    'Plan:',
    '',
    '1. **Navigation** — projects → sessions, collapsible, with a search box.',
    '2. **Header** — session title, scope, status badge, `Compact`.',
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
