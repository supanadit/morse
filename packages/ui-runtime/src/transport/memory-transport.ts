import {
  PROTOCOL_VERSION,
  type ClientToHostMessage,
  type HostToClientMessage,
  type McpServerState,
  type McpServerStatus,
  type SessionActivity,
  type SessionSummary,
  type SessionViewState,
  type TranscriptItem,
} from '@morse/protocol';
import { BaseHostTransport } from './host-transport.js';
import {
  CAPABILITIES,
  MOCK_FILES,
  MOCK_GIT_DIFF,
  MOCK_GIT_LOG,
  MOCK_GIT_REPOS,
  MOCK_GIT_STATUS,
  MOCK_MODES,
  MOCK_PROMPTS,
  WORKSPACE,
  applyMockPromptSave,
  chunkText,
  commitsReachableFrom,
  isBlankSession,
  mockConversation,
  mockDirectoryListing,
  mockProjects,
  mockSearchResult,
  mockSessions,
  mockThinkingLevels,
  wantsDiagnosticsPreview,
} from './memory-fixtures.js';


/**
 * Scripted host used when there is no backend at all (`ng serve --mock`, tests).
 * It exists so frontend authors can iterate on the UI — and on a new framework —
 * without running VS Code or the NestJS server.
 */
export class MemoryHostTransport extends BaseHostTransport {
  readonly kind = 'memory' as const;

  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private items: TranscriptItem[] = isBlankSession() ? [] : mockConversation();
  /** Scripted working tree the mock stages/unstages against. */
  private gitFiles = MOCK_GIT_STATUS.files.map((file) => ({ ...file }));
  /** The scripted history, mutable so an amend shows up in the dev page. */
  private readonly mockLog = {
    ...MOCK_GIT_LOG,
    commits: MOCK_GIT_LOG.commits.map((commit) => ({
      ...commit,
      parents: [...commit.parents],
      refs: [...commit.refs],
    })),
  };
  /** The mock's prompt templates, mutable so save/delete round-trip in a dev page. */
  private readonly mockPrompts = MOCK_PROMPTS.map((template) => ({ ...template }));
  /** Scripted branch distance the mock pulls/pushes against. */
  private gitSync = { isRepo: true, branch: 'master', upstream: 'origin/master', ahead: 1, behind: 0 };
  /** Persisted-looking catalog; `session/new` prepends to it like a real host. */
  private sessions: SessionSummary[] = mockSessions();
  /** Registry keys of live agent processes, so several can animate at once. */
  private readonly hot = new Set<string>(this.sessions.slice(0, 2).map((s) => s.id));
  /** Terminal ids the mock shell has open, so it can echo and exit by id. */
  private readonly terminals = new Set<string>();
  /** Scripted MCP servers the mock adds/removes/toggles against. */
  private mcpServers: McpServerStatus[] = [
    {
      name: 'context7',
      scope: 'global',
      source: '/mock/.pi/agent/mcp.json',
      enabled: true,
      exposure: 'codemode',
      transport: 'http: https://mcp.context7.com/mcp',
      state: 'connected',
      tools: ['resolve-library-id', 'query-docs'],
    },
    {
      name: 'firecrawl',
      scope: 'global',
      source: '/mock/.pi/agent/mcp.json',
      enabled: true,
      exposure: 'codemode',
      transport: 'stdio: npx -y firecrawl-mcp',
      state: 'failed',
      tools: [],
      error: 'spawn npx ENOENT',
    },
    {
      name: 'openviking',
      scope: 'project',
      source: '/mock/workspace/.pi/mcp.json',
      enabled: false,
      exposure: 'codemode',
      transport: 'http: http://localhost:1933/mcp',
      state: 'disabled',
      tools: [],
    },
  ];
  /** Starts high so generated ids cannot collide with the fixture's own ids. */
  private counter = 100;
  private disposed = false;
  private streaming = false;
  /** What a frontend asked the host to keep (the `ViewState` service). */
  private persistedState: unknown;
  private state: SessionViewState = {
    workspace: WORKSPACE,
    model: { provider: 'mock', id: 'mock-1', name: 'Mock Model', contextWindow: 1_000_000, maxTokens: 32_768, input: ['text', 'image'] },
    thinkingLevel: 'low',
    availableModels: [
      { provider: 'mock', id: 'mock-1', name: 'Mock Model', contextWindow: 128_000, input: ['text', 'image'] },
      { provider: 'mock', id: 'mock-2', name: 'Mock Model (fast)', contextWindow: 262_144, input: ['text'] },
      // A second provider with the same display name: the picker must group them,
      // otherwise the user cannot tell which provider a model belongs to.
      { provider: 'mock-cloud', id: 'mock-1', name: 'Mock Model', contextWindow: 200_000, input: ['text', 'image', 'audio'] },
      { provider: 'mock-cloud', id: 'mock-3', name: 'Mock Model (pro)', contextWindow: 1_000_000, input: ['text', 'image', 'video', 'pdf'] },
    ],
    availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    availableCommands: [
      { name: 'skill:codebase-memory', description: 'Query the knowledge graph', source: 'skill' },
      { name: 'fix-tests', description: 'Fix failing tests', source: 'prompt' },
    ],
    // `?mock=1&diagnostics=1`: review the configuration-warning row and the file
    // list behind its Details button, with no pi and no server.
    ...(wantsDiagnosticsPreview()
      ? {
          diagnostics: [
            {
              level: 'warn' as const,
              text: 'Prompt template /home/u/.pi/agent/prompts/explain-path.md is not loaded by pi: Nested mappings are not allowed in compact mappings at line 1, column 14',
            },
            {
              level: 'warn' as const,
              text: 'Prompt template /home/u/.pi/agent/prompts/summarize-session.md is not loaded by pi: Nested mappings are not allowed in compact mappings at line 1, column 14',
            },
          ],
        }
      : {}),
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
    // Measured by the host, not reported by pi; the fixture shows a session
    // that has been watched for a while.
    speed: { avgTokensPerSecond: 42.7, peakTokensPerSecond: 88.9, slowestTokensPerSecond: 11.2 },
    // The fixture keeps one call running, so the host must look busy too.
    busy: this.items.some((item) => item.kind === 'tool' && item.status === 'running'),
    agentReady: !isBlankSession(),
    agentStarting: false,
    // `?empty=1` is the intentional draft, with OpenCode selected so the engine
    // and mode pills can be reviewed together; the usual fixture is a live
    // conversation with the same modes.
    ...(isBlankSession()
      ? {
          draft: true,
          engine: 'opencode',
          mode: 'build',
          availableModes: MOCK_MODES.map((mode) => ({ ...mode })),
        }
      : { mode: 'build', availableModes: MOCK_MODES.map((mode) => ({ ...mode })) }),
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
            user: null,
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
        // A payload naming a project is that project's next page; without one it
        // is the first-page list. The mock already holds every session, so it
        // answers with that project's rows and no more to load.
        if (message.payload.cwd !== undefined) {
          const sessions = this.sessions.filter(
            (session) => session.cwd === message.payload.cwd,
          );
          this.emit({
            type: 'session/list',
            payload: { cwd: message.payload.cwd, sessions, hasMore: false },
          });
          return;
        }
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
        this.notify(
          'success',
          message.payload.schedule === true
            ? 'Mock host: compaction scheduled for the end of the run.'
            : 'Mock host: context compacted.',
        );
        return;
      case 'model/set': {
        const known = this.state.availableModels.find(
          (model) =>
            model.provider === message.payload.provider && model.id === message.payload.id,
        );
        const provider = known?.provider ?? message.payload.provider;
        const id = known?.id ?? message.payload.id;
        const levels = mockThinkingLevels(provider, id);
        this.state = {
          ...this.state,
          model: known ? { ...known } : { provider, id, name: id },
          availableThinkingLevels: levels,
          // A model without the current level resets it, exactly like pi.
          thinkingLevel: levels.includes(this.state.thinkingLevel)
            ? this.state.thinkingLevel
            : (levels[0] ?? 'off'),
        };
        this.emit({ type: 'session/state', payload: this.state });
        return;
      }
      case 'thinking/set': {
        const levels = this.state.availableThinkingLevels;
        const level = levels.includes(message.payload.level)
          ? message.payload.level
          : this.state.thinkingLevel;
        this.state = { ...this.state, thinkingLevel: level };
        this.emit({ type: 'session/state', payload: this.state });
        return;
      }
      case 'engine/set': {
        // Only the draft has an engine choice; switching clears the catalogs
        // that belonged to the previous engine, as the real host does.
        if (this.state.draft !== true) {
          this.notify('warn', 'Mock host: the engine can only change before a session starts.');
          return;
        }
        const openCode = message.payload.kind === 'opencode';
        const next: SessionViewState = {
          ...this.state,
          engine: message.payload.kind,
          ...(openCode
            ? { mode: 'build', availableModes: MOCK_MODES.map((mode) => ({ ...mode })) }
            : { availableModes: [] }),
        };
        if (!openCode) {
          delete next.mode;
        }
        this.state = next;
        this.emit({ type: 'session/state', payload: this.state });
        return;
      }
      case 'mode/set': {
        const offered = this.state.availableModes ?? [];
        if (!offered.some((mode) => mode.id === message.payload.mode)) {
          this.notify('warn', 'Mock host: that mode is not offered.');
          return;
        }
        this.state = { ...this.state, mode: message.payload.mode };
        this.emit({ type: 'session/state', payload: this.state });
        return;
      }
      case 'modes/refresh':
        this.emit({ type: 'session/state', payload: this.state });
        return;
      case 'terminal/open': {
        this.terminals.add(message.payload.terminalId);
        this.emit({
          type: 'terminal/output',
          payload: {
            terminalId: message.payload.terminalId,
            data: 'Morse mock shell — no server here. Type `help` or any command.\n',
          },
        });
        return;
      }
      case 'terminal/input': {
        if (!this.terminals.has(message.payload.terminalId)) {
          return;
        }
        const command = message.payload.data.trim();
        const text =
          command === 'help'
            ? 'Commands are simulated in the mock host.\n'
            : `(mock) ${command || '\u00b7'} — 0.0s, exit 0\n`;
        this.emit({
          type: 'terminal/output',
          payload: { terminalId: message.payload.terminalId, data: text },
        });
        return;
      }
      case 'terminal/resize':
        return;
      case 'terminal/close':
        if (this.terminals.delete(message.payload.terminalId)) {
          this.emit({
            type: 'terminal/exit',
            payload: { terminalId: message.payload.terminalId, code: 0 },
          });
        }
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
        if (message.payload.command === 'searchSessions' && message.payload.requestId) {
          const query =
            typeof message.payload.args?.query === 'string'
              ? message.payload.args.query.trim().toLowerCase()
              : '';
          const sessions = this.sessions.filter(
            (session) =>
              query.length === 0 ||
              session.title.toLowerCase().includes(query) ||
              session.cwd.toLowerCase().includes(query),
          );
          this.emit({
            type: 'host/command/result',
            payload: { requestId: message.payload.requestId, ok: true, data: { sessions } },
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
        if (message.payload.command === 'updateHost' && message.payload.requestId) {
          // The mock never installs anything: it answers the shape the real host
          // answers, so the button's progress and refusal paths are reviewable.
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: {
                ok: false,
                from: '0.0.0-mock',
                message: 'The mock host does not install anything.',
              },
            },
          });
          return;
        }
        if (message.payload.command === 'promptTemplates' && message.payload.requestId) {
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: {
                templates: this.mockPrompts.map((template) => ({ ...template })),
                globalDir: '~/.pi/agent/prompts',
                projectDir: '/repo/.pi/prompts',
                trusted: true,
              },
            },
          });
          return;
        }
        if (message.payload.command === 'promptTemplateSave' && message.payload.requestId) {
          applyMockPromptSave(this.mockPrompts, message.payload.args);
          this.emit({
            type: 'host/command/result',
            payload: { requestId: message.payload.requestId, ok: true, data: { ok: true } },
          });
          return;
        }
        if (message.payload.command === 'promptTemplateDelete' && message.payload.requestId) {
          const name = typeof message.payload.args?.name === 'string' ? message.payload.args.name : '';
          const scope = message.payload.args?.scope === 'project' ? 'project' : 'global';
          const index = this.mockPrompts.findIndex(
            (template) => template.name === name && template.scope === scope,
          );
          const removed = index !== -1;
          if (removed) {
            this.mockPrompts.splice(index, 1);
          }
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: removed ? { ok: true } : { ok: false, message: `No "${name}" to delete.` },
            },
          });
          return;
        }
        if (message.payload.command === 'gitRepos' && message.payload.requestId) {
          this.emit({
            type: 'host/command/result',
            payload: { requestId: message.payload.requestId, ok: true, data: MOCK_GIT_REPOS },
          });
          return;
        }
        if (message.payload.command === 'gitLog' && message.payload.requestId) {
          const requested = message.payload.args?.ref;
          const ref =
            typeof requested === 'string' && requested.length > 0
              ? requested
              : this.mockLog.branch;
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: {
                ...this.mockLog,
                commits: commitsReachableFrom(this.mockLog.commits, ref),
              },
            },
          });
          return;
        }
        if (message.payload.command === 'searchWorkspace' && message.payload.requestId) {
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: mockSearchResult(typeof message.payload.args?.query === 'string' ? message.payload.args.query : ''),
            },
          });
          return;
        }
        if (message.payload.command === 'gitStatus' && message.payload.requestId) {
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: {
                isRepo: true,
                files: this.gitFiles,
                branch: this.gitSync.branch,
                // The demo's branch list is scripted; the checked-out branch is
                // what moves, so the panel's refs fingerprint follows a mock
                // checkout the way a real checkout moves a real one.
                refs: `mock-${this.gitSync.branch}`,
              },
            },
          });
          return;
        }
        if (
          (message.payload.command === 'gitStage' || message.payload.command === 'gitUnstage') &&
          message.payload.requestId
        ) {
          this.applyGitMutation(message.payload.command, message.payload.args?.paths);
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: { isRepo: true, files: this.gitFiles },
            },
          });
          return;
        }
        if (message.payload.command === 'gitDiff' && message.payload.requestId) {
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: { path: String(message.payload.args?.path ?? ''), diff: MOCK_GIT_DIFF },
            },
          });
          return;
        }
        if (message.payload.command === 'gitCommitFiles' && message.payload.requestId) {
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: {
                isRepo: true,
                hash: String(message.payload.args?.hash ?? ''),
                files: this.gitFiles,
              },
            },
          });
          return;
        }
        if (message.payload.command === 'gitCommitDiff' && message.payload.requestId) {
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: { path: String(message.payload.args?.path ?? ''), diff: MOCK_GIT_DIFF },
            },
          });
          return;
        }
        if (message.payload.command === 'gitSync' && message.payload.requestId) {
          this.emit({
            type: 'host/command/result',
            payload: { requestId: message.payload.requestId, ok: true, data: this.gitSync },
          });
          return;
        }
        if (
          (message.payload.command === 'gitPull' || message.payload.command === 'gitPush') &&
          message.payload.requestId
        ) {
          this.gitSync =
            message.payload.command === 'gitPull'
              ? { ...this.gitSync, ahead: this.gitSync.ahead + this.gitSync.behind, behind: 0 }
              : { ...this.gitSync, ahead: 0 };
          this.emit({
            type: 'host/command/result',
            payload: { requestId: message.payload.requestId, ok: true, data: this.gitSync },
          });
          return;
        }
        if (message.payload.command === 'gitCommit' && message.payload.requestId) {
          // Amend rewrites the newest scripted commit, so the dev page shows the
          // form's result instead of a no-op.
          const amend = message.payload.args?.amend === true;
          const text = typeof message.payload.args?.message === 'string'
            ? message.payload.args.message
            : '';
          if (amend && text.trim().length > 0) {
            const first = this.mockLog.commits[0];
            if (first !== undefined) {
              this.mockLog.commits[0] = { ...first, subject: text.trim() };
            }
          }
          this.emit({
            type: 'host/command/result',
            payload: { requestId: message.payload.requestId, ok: true, data: { ok: true } },
          });
          return;
        }
        if (message.payload.command === 'gitBranches' && message.payload.requestId) {
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: {
                isRepo: true,
                current: this.gitSync.branch,
                local: ['master', 'dev', 'feat/mock'],
                remote: ['origin/master', 'origin/dev'],
                tags: ['v0.9.5', 'v0.9.4'],
              },
            },
          });
          return;
        }
        if (message.payload.command === 'gitCheckout' && message.payload.requestId) {
          const branch = String(message.payload.args?.branch ?? '');
          if (branch.length > 0) {
            this.gitSync = { ...this.gitSync, branch };
          }
          this.emit({
            type: 'host/command/result',
            payload: { requestId: message.payload.requestId, ok: true, data: { ok: true } },
          });
          return;
        }
        if (message.payload.command === 'mcpStatus' && message.payload.requestId) {
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: { servers: this.mcpServers, errors: [] },
            },
          });
          return;
        }
        if (message.payload.command === 'mcpAdd' && message.payload.requestId) {
          const name = String(message.payload.args?.name ?? 'server');
          const isHttp = message.payload.args?.type === 'http';
          this.mcpServers = [
            ...this.mcpServers.filter((server) => server.name !== name),
            {
              name,
              scope: message.payload.args?.scope === 'project' ? 'project' : 'global',
              source: '/mock/.pi/agent/mcp.json',
              enabled: true,
              exposure: 'codemode',
              transport: isHttp
                ? `http: ${String(message.payload.args?.url ?? '')}`
                : `stdio: ${String(message.payload.args?.command ?? '')}`,
              state: 'connected',
              tools: [],
            },
          ];
          this.emit({
            type: 'host/command/result',
            payload: {
              requestId: message.payload.requestId,
              ok: true,
              data: { ok: true, path: '/mock/.pi/agent/mcp.json' },
            },
          });
          return;
        }
        if (message.payload.command === 'mcpRemove' && message.payload.requestId) {
          const name = String(message.payload.args?.name ?? '');
          const scope = message.payload.args?.scope;
          if (scope === 'project') {
            // Project scope drops the project entry/override only.
            this.mcpServers = this.mcpServers.map((server) =>
              server.name === name && server.scope === 'project'
                ? { ...server, scope: 'global', override: undefined }
                : server,
            );
          } else {
            this.mcpServers = this.mcpServers.filter((server) => server.name !== name);
          }
          this.emit({
            type: 'host/command/result',
            payload: { requestId: message.payload.requestId, ok: true, data: { ok: true } },
          });
          return;
        }
        if (message.payload.command === 'mcpSetEnabled' && message.payload.requestId) {
          const name = String(message.payload.args?.name ?? '');
          const enabled = message.payload.args?.enabled === true;
          const scope = message.payload.args?.scope;
          this.mcpServers = this.mcpServers.map((server) => {
            if (server.name !== name) {
              return server;
            }
            if (scope === 'project' && server.scope !== 'project') {
              // A user-level server toggled here gets a project override.
              return enabled
                ? { ...server, enabled: true, override: undefined }
                : { ...server, enabled: false, override: '/mock/workspace/.pi/mcp.json' };
            }
            return {
              ...server,
              enabled,
              state: enabled ? 'connected' : ('disabled' as McpServerState),
            };
          });
          this.emit({
            type: 'host/command/result',
            payload: { requestId: message.payload.requestId, ok: true, data: { ok: true } },
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

  readState(): unknown {
    return this.persistedState;
  }

  writeState(state: unknown): void {
    this.persistedState = state;
  }

  /**
   * Moves mock paths between the index and the working tree, so the panel's
   * stage/unstage round trip is reviewable without a real repository. The
   * two-letter code is rewritten the way `git status` would print it.
   */
  private applyGitMutation(command: 'gitStage' | 'gitUnstage', paths: unknown): void {
    if (!Array.isArray(paths)) {
      return;
    }
    const wanted = new Set(paths.filter((path): path is string => typeof path === 'string'));
    this.gitFiles = this.gitFiles.map((file) => {
      if (!wanted.has(file.path)) {
        return file;
      }
      const index = file.status[0] ?? ' ';
      const worktree = file.status[1] ?? ' ';
      if (command === 'gitStage') {
        const staged = worktree === '?' ? 'A' : worktree === ' ' ? index : worktree;
        return { ...file, status: `${staged} ` };
      }
      // Unstage: a newly added file becomes untracked again; anything else keeps
      // its change but moves it to the working-tree side.
      if (index === 'A') {
        return { ...file, status: '??' };
      }
      return { ...file, status: ` ${worktree === ' ' ? index : worktree}` };
    });
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
