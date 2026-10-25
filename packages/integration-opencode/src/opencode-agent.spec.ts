import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSessionState } from '@morse/agent';
import { AgentUnavailableError, UnsupportedByHostError, silentLogger } from '@morse/system';
import type { OpenCodeApi, OpenCodePage } from './internal/client.js';
import type { OpenCodeEvent, OpenCodeEventListener, OpenCodeEventStream } from './internal/event-stream.js';
import type { ApiModel } from './internal/model-mapping.js';
import type { ApiMessage } from './internal/message-mapping.js';
import { OpenCodeAgent, appendPinMentions } from './opencode-agent.js';

/**
 * The session adapter against a fake server: what it sends on the wire, what it
 * seeds its state from, how it pages history past bookkeeping, and that dispose
 * detaches instead of killing a conversation the server owns. The real wire is
 * covered by the opt-in live spec; this one pins the contract cheaply.
 */

const WORKSPACE = { cwd: '/work/project', name: 'project' };

const MODELS: ApiModel[] = [
  {
    id: 'flint-40b-free',
    providerID: 'opencode',
    name: 'Flint 40B Free',
    variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
    limit: { context: 262_144, output: 65_536 },
    capabilities: { input: ['text'] },
  },
  {
    id: 'plain-model',
    providerID: 'opencode',
    name: 'Plain Model',
  },
];

function sessionInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ses_1',
    title: 'Count files',
    agent: 'build',
    model: { id: 'flint-40b-free', providerID: 'opencode', variant: 'default' },
    cost: 0.012,
    tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 10, write: 0 } },
    outcome: 'succeeded',
    time: { created: 1_000, updated: 2_000 },
    location: { directory: '/work/project' },
    ...overrides,
  };
}

type Handler = (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  query: Record<string, string | undefined> | undefined,
  body: unknown,
) => unknown;

class FakeApi {
  readonly calls: { method: string; path: string; query?: Record<string, string | undefined>; body?: unknown }[] = [];

  constructor(private readonly handler: Handler) {}

  get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    this.calls.push({ method: 'GET', path, ...(query === undefined ? {} : { query }) });
    return Promise.resolve(this.handler('GET', path, query, undefined) as T);
  }

  post<T>(path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T | undefined> {
    this.calls.push({ method: 'POST', path, ...(query === undefined ? {} : { query }), body });
    return Promise.resolve(this.handler('POST', path, query, body) as T | undefined);
  }

  page<T>(path: string, query?: Record<string, string | undefined>): Promise<OpenCodePage<T>> {
    this.calls.push({ method: 'GET', path, ...(query === undefined ? {} : { query }) });
    return Promise.resolve(this.handler('GET', path, query, undefined) as OpenCodePage<T>);
  }

  delete(path: string, query?: Record<string, string | undefined>): Promise<void> {
    this.calls.push({ method: 'DELETE', path, ...(query === undefined ? {} : { query }) });
    return Promise.resolve();
  }
}

class FakeStream {
  readonly subscriptions: { sessionID: string; listener: OpenCodeEventListener }[] = [];

  subscribe(sessionID: string, listener: OpenCodeEventListener): () => void {
    const entry = { sessionID, listener };
    this.subscriptions.push(entry);
    return () => {
      const index = this.subscriptions.indexOf(entry);
      if (index >= 0) {
        this.subscriptions.splice(index, 1);
      }
    };
  }

  emit(sessionID: string, event: OpenCodeEvent): void {
    for (const subscription of this.subscriptions.filter((entry) => entry.sessionID === sessionID)) {
      subscription.listener(event);
    }
  }
}

interface Harness {
  agent: OpenCodeAgent;
  api: FakeApi;
  stream: FakeStream;
  events: AgentEvent[];
}

async function harness(
  options: {
    handler?: Handler;
    sessionId?: string;
  } = {},
): Promise<Harness> {
  const handler: Handler = options.handler ?? defaultHandler();
  const api = new FakeApi(handler);
  const stream = new FakeStream();
  const agent = await OpenCodeAgent.open({
    api: api as unknown as OpenCodeApi,
    stream: stream as unknown as OpenCodeEventStream,
    workspace: WORKSPACE,
    logger: silentLogger,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return { agent, api, stream, events };
}

function defaultHandler(): Handler {
  return (method, path) => {
    if (method === 'POST' && path === '/session') {
      return sessionInfo();
    }
    if (method === 'GET' && path.includes('/message/')) {
      return { id: 'msg_1', type: 'user', time: { created: 1 }, text: 'the dropped prompt' };
    }
    if (method === 'GET' && path.endsWith('/message')) {
      return { data: [] };
    }
    if (method === 'GET' && (path.endsWith('/form') || path.endsWith('/permission'))) {
      return [];
    }
    if (method === 'GET' && /^\/session\/ses_[^/]+$/.test(path)) {
      const id = path.split('/')[2] ?? 'ses_1';
      return sessionInfo({ id });
    }
    if (method === 'GET' && path === '/model') {
      return MODELS;
    }
    if (method === 'GET' && path === '/command') {
      return [
        { name: 'init', description: 'guided AGENTS.md setup' },
        { name: 'review', description: 'review changes' },
      ];
    }
    if (method === 'GET' && path === '/skill') {
      return [{ id: 'opencode', name: 'OpenCode', description: 'Use for OpenCode questions' }];
    }
    if (method === 'POST' && path.endsWith('/prompt')) {
      return { delivery: 'steer' };
    }
    if (method === 'POST' && path.endsWith('/model')) {
      return undefined;
    }
    if (method === 'POST' && path.endsWith('/fork')) {
      return sessionInfo({ id: 'ses_2' });
    }
    if (method === 'POST' && path.endsWith('/interrupt')) {
      return { interrupted: false };
    }
    if (method === 'POST' && path.endsWith('/compact')) {
      return { id: 'msg_c', type: 'compaction', status: 'completed' };
    }
    return undefined;
  };
}

describe('OpenCodeAgent', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const path of created.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('creates its engine session eagerly and seeds state from the server record', async () => {
    const { agent, api } = await harness();

    expect(api.calls[0]).toMatchObject({ method: 'POST', path: '/session', body: { location: { directory: WORKSPACE.cwd } } });
    const state = await agent.state();
    expect(state).toMatchObject({
      sessionId: 'ses_1',
      sessionTitle: 'Count files',
      workspace: { cwd: '/work/project' },
      model: { provider: 'opencode', id: 'flint-40b-free', name: 'Flint 40B Free' },
      thinkingLevel: 'medium',
      availableThinkingLevels: ['low', 'medium', 'high'],
      streaming: false,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      costUsd: 0.012,
    });
    expect(state.availableCommands.map((command) => command.name)).toEqual([
      'init',
      'review',
      'OpenCode',
    ]);
    expect(state.availableCommands.map((command) => command.source)).toEqual(['prompt', 'prompt', 'skill']);
    await agent.dispose();
  });

  it('resumes by id instead of creating a second session', async () => {
    const { agent, api } = await harness({ sessionId: 'ses_9' });
    expect(api.calls.some((call) => call.method === 'POST' && call.path === '/session')).toBe(false);
    expect(api.calls[0]).toMatchObject({ method: 'GET', path: '/session/ses_9' });
    expect((await agent.state()).sessionId).toBe('ses_9');
    await agent.dispose();
  });

  it('queues a follow-up, steers a new prompt, and reports each disposition', async () => {
    const { agent, api } = await harness();

    expect(await agent.prompt('hello', 'new')).toBe('started');
    expect(await agent.prompt('later', 'followUp')).toBe('started');
    const prompts = api.calls.filter((call) => call.path.endsWith('/prompt'));
    expect(prompts[0]?.body).toEqual({ text: 'hello' });
    expect(prompts[1]?.body).toEqual({ text: 'later', delivery: 'queue' });
    await agent.dispose();
  });

  it('turns pins into mention lines instead of losing them', async () => {
    const text = appendPinMentions('look here', [
      { path: 'src/app.ts', startLine: 4, endLine: 9, note: 'the bug' },
      { path: 'README.md' },
    ]);
    expect(text).toBe(
      'look here\n\n@src/app.ts:4-9\n  > the bug\n@README.md',
    );
    expect(appendPinMentions('', [{ path: 'a.ts' }])).toBe('@a.ts');
  });

  it('writes image attachments as files the server can read, and cleans them up', async () => {
    const { agent, api } = await harness();
    const image = { data: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png' };

    await agent.prompt('look', 'new', [image]);
    const prompt = api.calls.find((call) => call.path.endsWith('/prompt'));
    const files = (prompt?.body as { files?: { uri: string }[] } | undefined)?.files;
    expect(files).toHaveLength(1);
    const uri = files?.[0]?.uri ?? '';
    expect(uri.startsWith('file:')).toBe(true);
    const path = decodeURIComponent(new URL(uri).pathname);
    expect(existsSync(path)).toBe(true);
    created.push(path);

    await agent.dispose();
    expect(existsSync(path)).toBe(false);
  });

  it('moves the model and its declared level to the wire, and refuses an undeclared one', async () => {
    const { agent, api } = await harness();

    await agent.setThinkingLevel('high');
    expect(api.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/session/ses_1/model',
      body: { model: { id: 'flint-40b-free', providerID: 'opencode', variant: 'high' } },
    });
    expect((await agent.state()).thinkingLevel).toBe('high');

    await agent.setModel({ provider: 'opencode', id: 'plain-model', name: 'Plain Model' });
    expect(api.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/session/ses_1/model',
      body: { model: { id: 'plain-model', providerID: 'opencode' } },
    });
    const state = await agent.state();
    expect(state.availableThinkingLevels).toEqual([]);
    // The old level does not pretend to apply to a model with no variants.
    expect(state.thinkingLevel).toBe('off');

    await expect(agent.setThinkingLevel('high')).rejects.toBeInstanceOf(UnsupportedByHostError);
    await agent.dispose();
  });

  it('pages history past a bookkeeping-only page and returns each page oldest-first', async () => {
    const user: ApiMessage = { id: 'msg_u', type: 'user', time: { created: 1 }, text: 'count them' };
    const assistant: ApiMessage = {
      id: 'msg_a',
      type: 'assistant',
      time: { created: 2 },
      content: [{ type: 'text', text: '5' }],
    };
    const { agent } = await harness({
      handler: (method, path, query) => {
        if (method === 'GET' && path.endsWith('/message')) {
          if (query?.['cursor'] === undefined) {
            // The newest page is only bookkeeping, with a cursor to keep going.
            return {
              data: [
                { id: 'msg_idle', type: 'idle', time: { created: 3 } },
                { id: 'msg_switch', type: 'model-switched', time: { created: 3 } },
              ],
              cursor: { next: 'older' },
            };
          }
          if (query?.['cursor'] === 'older') {
            return { data: [assistant, user], cursor: { next: 'oldest' } };
          }
          return { data: [] };
        }
        return defaultHandler()(method, path, query, undefined);
      },
    });

    const page = await agent.history({ limit: 10 });
    expect(page.entries.map((entry) => entry.role)).toEqual(['user', 'assistant']);
    expect(page.entries.at(-1)).toMatchObject({ role: 'assistant', text: '5' });
    expect(page.hasOlder).toBe(true);
    expect(page.before).toBe('oldest');
    await agent.dispose();
  });

  it('lists forkable prompts in conversation order', async () => {
    const messages: ApiMessage[] = [
      { id: 'msg_3', type: 'user', time: { created: 3 }, text: 'third' },
      { id: 'msg_2', type: 'assistant', time: { created: 2 }, content: [] },
      { id: 'msg_1', type: 'user', time: { created: 1 }, text: 'first' },
    ];
    const { agent } = await harness({
      handler: (method, path, query) =>
        method === 'GET' && path.endsWith('/message')
          ? { data: messages, cursor: {} }
          : defaultHandler()(method, path, query, undefined),
    });
    expect(await agent.forkMessages()).toEqual([
      { entryId: 'msg_1', text: 'first' },
      { entryId: 'msg_3', text: 'third' },
    ]);
    await agent.dispose();
  });

  it('forks onto the new engine session and moves its stream subscription there', async () => {
    const { agent, api, stream } = await harness();
    expect(stream.subscriptions.map((entry) => entry.sessionID)).toEqual(['ses_1']);

    const forked = await agent.fork('msg_1');
    expect(forked).toEqual({ text: 'the dropped prompt', cancelled: false });
    expect(api.calls.find((call) => call.path.endsWith('/fork'))?.body).toEqual({ before: 'msg_1' });
    expect((await agent.state()).sessionId).toBe('ses_2');
    expect(stream.subscriptions.map((entry) => entry.sessionID)).toEqual(['ses_2']);
    await agent.dispose();
  });

  it('compacts without custom instructions but says they were not sent', async () => {
    const { agent, api, events } = await harness();
    await agent.compact('focus on the parser');
    expect(api.calls.find((call) => call.path.endsWith('/compact'))).toBeDefined();
    expect(events.find((event) => event.type === 'agent/notice')).toMatchObject({
      level: 'warn',
      text: expect.stringContaining('does not accept custom compaction instructions'),
    });
    await agent.dispose();
  });

  it('interrupts a running turn through the server endpoint', async () => {
    const { agent, api } = await harness();
    await agent.abort();
    expect(api.calls.at(-1)).toMatchObject({ method: 'POST', path: '/session/ses_1/interrupt' });
    await agent.dispose();
  });

  it('detaches on dispose without interrupting or deleting the server session', async () => {
    const { agent, api, stream } = await harness();
    const before = api.calls.length;
    await agent.dispose();
    expect(stream.subscriptions).toEqual([]);
    expect(api.calls.slice(before).filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('folds streamed events into transcript events and state', async () => {
    const { agent, stream, events } = await harness();

    stream.emit('ses_1', {
      type: 'session.execution.started',
      data: { sessionID: 'ses_1' },
      created: 10,
    });
    stream.emit('ses_1', {
      type: 'session.text.delta',
      data: { sessionID: 'ses_1', delta: 'hello' },
      created: 11,
    });
    stream.emit('ses_1', {
      type: 'session.step.streamed',
      data: { sessionID: 'ses_1' },
      created: 12,
    });
    stream.emit('ses_1', {
      type: 'session.execution.succeeded',
      data: { sessionID: 'ses_1' },
      created: 13,
    });

    expect(events.map((event) => event.type)).toEqual([
      'agent/run-start',
      'agent/state',
      'agent/delta',
      'agent/message',
      'agent/run-end',
      'agent/state',
    ]);
    const state = await agent.state();
    expect(state.streaming).toBe(false);
    await agent.dispose();
  });

  it('reports a stream death as fatal and clears streaming', async () => {
    const { agent, stream, events } = await harness();
    stream.emit('ses_1', {
      type: 'stream.fatal',
      data: { sessionID: 'ses_1', message: 'The OpenCode event stream is unavailable.' },
      created: 20,
    });
    expect(events.find((event) => event.type === 'agent/fatal')).toMatchObject({
      message: 'The OpenCode event stream is unavailable.',
    });
    expect((await agent.state()).streaming).toBe(false);
    await agent.dispose();
  });

  it('ignores a reply to a request it never showed', async () => {
    const { agent, api } = await harness();
    const before = api.calls.length;
    await agent.respondToInteraction({ requestId: 'unknown', cancelled: true });
    expect(api.calls.slice(before)).toEqual([]);
    await agent.dispose();
  });

  it('shows an OpenCode form as a multi-field interaction and replies with its keyed values', async () => {
    const { agent, stream, events, api } = await harness();
    stream.emit('ses_1', {
      type: 'form.created',
      data: {
        form: {
          id: 'frm_1',
          sessionID: 'ses_1',
          title: 'Set up the task',
          metadata: { message: 'Answer what applies' },
          fields: [
            { key: 'name', title: 'Name', type: 'string', required: true },
            { key: 'retries', title: 'Retries', type: 'integer', minimum: 1, maximum: 9, default: 3 },
            {
              key: 'mode',
              title: 'Mode',
              type: 'string',
              options: [{ value: 'fast', label: 'Fast' }],
            },
            { key: 'notes', title: 'Notes', type: 'string', when: [{ key: 'mode', op: 'eq', value: 'fast' }] },
          ],
        },
      },
      created: 30,
    });

    const interaction = events.find((event) => event.type === 'agent/interaction');
    expect(interaction?.type === 'agent/interaction' ? interaction.request.kind : undefined).toBe('form');
    const request = interaction?.type === 'agent/interaction' ? interaction.request : undefined;
    expect(request?.kind === 'form' ? request.fields.map((field) => field.type) : []).toEqual([
      'text',
      'integer',
      'select',
      'text',
    ]);
    expect(request?.kind === 'form' ? request.fields[2]?.options?.[0]?.value : undefined).toBe('fast');
    expect(request?.kind === 'form' ? request.fields[3]?.when : undefined).toEqual({
      field: 'mode',
      equals: 'fast',
    });

    await agent.respondToInteraction({
      requestId: 'frm_1',
      values: { name: 'Ada', retries: 3, mode: 'fast' },
    });
    expect(api.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/session/ses_1/form/frm_1/reply',
      body: { answer: { name: 'Ada', retries: 3, mode: 'fast' } },
    });
    await agent.dispose();
  });

  it('cancels a form by deleting it, which the server distinguishes from an empty answer', async () => {
    const { agent, stream, api } = await harness();
    stream.emit('ses_1', {
      type: 'form.created',
      data: { form: { id: 'frm_2', sessionID: 'ses_1', title: 'Name?', fields: [{ key: 'a', title: 'A', type: 'string' }] } },
      created: 31,
    });

    await agent.respondToInteraction({ requestId: 'frm_2', cancelled: true });
    expect(api.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/session/ses_1/form/frm_2',
      query: { message: 'Cancelled in Morse.' },
    });
    await agent.dispose();
  });

  it('asks a permission as once/always/reject and sends exactly the decision made', async () => {
    const { agent, stream, events, api } = await harness();
    stream.emit('ses_1', {
      type: 'permission.asked',
      data: {
        id: 'per_1',
        sessionID: 'ses_1',
        action: 'shell',
        resources: ['ls -la /tmp'],
      },
      created: 40,
    });

    const interaction = events.find((event) => event.type === 'agent/interaction');
    const request = interaction?.type === 'agent/interaction' ? interaction.request : undefined;
    expect(request).toMatchObject({
      requestId: 'per_1',
      kind: 'select',
      title: 'Allow shell?',
      message: 'ls -la /tmp',
      options: [
        { value: 'once', label: 'Allow once' },
        { value: 'always', label: 'Always allow' },
        { value: 'reject', label: 'Reject' },
      ],
    });

    await agent.respondToInteraction({ requestId: 'per_1', value: 'always' });
    expect(api.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/session/ses_1/permission/per_1/reply',
      body: { decision: 'always' },
    });
    await agent.dispose();
  });

  it('polls the pending lists at execution boundaries and never shows one request twice', async () => {
    let formLists = 0;
    const { agent, stream, events } = await harness({
      handler: (method, path, query, body) => {
        if (method === 'GET' && path.endsWith('/form')) {
          formLists += 1;
          return formLists === 1
            ? [{ id: 'frm_late', sessionID: 'ses_1', title: 'Late form', fields: [{ key: 'a', title: 'A', type: 'string' }] }]
            : [];
        }
        return defaultHandler()(method, path, query, body);
      },
    });

    stream.emit('ses_1', { type: 'session.execution.started', data: { sessionID: 'ses_1' }, created: 50 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.emit('ses_1', { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' }, created: 51 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const forms = events.filter(
      (event) => event.type === 'agent/interaction' && event.request.kind === 'form',
    );
    expect(forms).toHaveLength(1);
    expect(formLists).toBeGreaterThanOrEqual(2);
    await agent.dispose();
  });

  it('fails a session the server does not return', async () => {
    await expect(
      harness({
        handler: () => undefined,
      }),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
  });
});
