import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@morse/agent';
import { silentLogger } from '@morse/system';
import { connectOpenCode, type OpenCodeConnection } from './internal/connection.js';
import { OpenCodeApi } from './internal/client.js';
import { OpenCodeEventStream } from './internal/event-stream.js';
import { OpenCodeAgent } from './opencode-agent.js';
import { createOpenCodeEngine } from './opencode-engine.js';

/**
 * The adapter against a real OpenCode server (2.1.4).
 *
 * Opt-in, because it needs a server and a model that answers:
 *
 *   MORSE_OPENCODE_URL=http://127.0.0.1:4096 MORSE_OPENCODE_PASSWORD=… \
 *     npm run test -w @morse/integration-opencode
 *
 * Every session it creates is deleted again, so a disposable server stays clean.
 */

const url = process.env.MORSE_OPENCODE_URL;
const password = process.env.MORSE_OPENCODE_PASSWORD;
const live = url !== undefined && password !== undefined ? describe : describe.skip;

const WORKSPACE = { cwd: process.cwd(), name: 'live' };

async function until(predicate: () => boolean, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition never became true');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

live('OpenCodeAgent (live server)', () => {
  let connection: OpenCodeConnection;
  let api: OpenCodeApi;
  let stream: OpenCodeEventStream;
  const createdSessions: string[] = [];

  beforeAll(async () => {
    connection = await connectOpenCode({ url, password });
    api = new OpenCodeApi(connection);
    stream = new OpenCodeEventStream(connection, { logger: silentLogger });
  });

  afterAll(async () => {
    for (const sessionId of createdSessions.splice(0)) {
      await api.delete(`/session/${encodeURIComponent(sessionId)}`).catch(() => undefined);
    }
    await stream.close();
    await connection.close();
  });

  it('creates a session, streams a turn, pages its history and lists its prompts', async () => {
    const agent = await OpenCodeAgent.open({
      api,
      stream,
      workspace: WORKSPACE,
      logger: silentLogger,
    });
    const engineId = agent.engineSessionId;
    createdSessions.push(engineId);

    const initial = await agent.state();
    expect(initial.sessionId).toBe(engineId);
    expect(initial.availableModels.length).toBeGreaterThan(0);
    expect(initial.thinkingLevel).not.toBeUndefined();

    // A fresh session takes the server's default model, which may be a provider
    // this machine cannot answer with. Pick a local model that declares variants
    // so the turn is deterministic and the level path is exercised too.
    const models = await api.get<{ id: string; providerID: string; variants?: unknown[] }[]>('/model', {
      directory: WORKSPACE.cwd,
    });
    const answering =
      models.find((model) => model.id === 'flint-40b-free') ??
      models.find((model) => (model.variants?.length ?? 0) > 0);
    expect(answering).toBeDefined();
    await agent.setModel({ provider: answering!.providerID, id: answering!.id, name: answering!.id });
    const levels = (await agent.state()).availableThinkingLevels;
    if (levels.length > 0) {
      await agent.setThinkingLevel(levels[0]!);
    }

    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    const disposition = await agent.prompt('Reply with exactly: live-answer', 'new');
    expect(disposition).toBe('started');
    await until(() => events.some((event) => event.type === 'agent/run-end'));

    expect(events.some((event) => event.type === 'agent/run-start')).toBe(true);
    expect(events.some((event) => event.type === 'agent/delta' && event.channel === 'text')).toBe(true);
    const answer = events.find(
      (event): event is Extract<AgentEvent, { type: 'agent/message' }> => event.type === 'agent/message',
    );
    expect(answer?.text.toLowerCase()).toContain('live-answer');
    expect(events.find((event) => event.type === 'agent/run-end')).toMatchObject({ reason: 'settled' });

    const history = await agent.history({ limit: 20 });
    expect(history.entries.some((entry) => entry.role === 'user' && entry.text.includes('live-answer'))).toBe(true);
    expect(history.entries.some((entry) => entry.role === 'assistant' && entry.text.length > 0)).toBe(true);

    const forks = await agent.forkMessages();
    expect(forks.at(-1)?.text).toContain('live-answer');

    await agent.dispose();
  }, 240_000);

  it('moves model and thinking level through the variants the model declares', async () => {
    const models = await api.get<{ id: string; providerID: string; variants?: unknown[] }[]>('/model', {
      directory: WORKSPACE.cwd,
    });
    const withVariants = models.find((model) => (model.variants?.length ?? 0) >= 2);
    expect(withVariants).toBeDefined();

    const agent = await OpenCodeAgent.open({ api, stream, workspace: WORKSPACE, logger: silentLogger });
    createdSessions.push(agent.engineSessionId);

    await agent.setModel({ provider: withVariants!.providerID, id: withVariants!.id, name: withVariants!.id });
    const levels = (await agent.state()).availableThinkingLevels;
    expect(levels.length).toBeGreaterThan(0);
    const level = levels.includes('high') ? 'high' : levels[0]!;
    await agent.setThinkingLevel(level);
    expect((await agent.state()).thinkingLevel).toBe(level);

    await agent.dispose();
  }, 240_000);

  it('scans and lists the server\'s sessions, deletes one through the catalog, and keeps an attached server', async () => {
    const engine = await createOpenCodeEngine({ url, password, logger: silentLogger });
    expect(engine.kind).toBe('opencode');
    expect(engine.owned).toBe(false);

    // A session created outside the engine's own factory is still reported.
    const outside = await api.post<{ id: string }>('/session', {
      location: { directory: WORKSPACE.cwd },
    });
    const outsideId = outside?.id ?? '';
    expect(outsideId.length).toBeGreaterThan(0);
    createdSessions.push(outsideId);

    const reported = await engine.scan?.();
    expect(reported?.some((session) => session.sessionId === outsideId)).toBe(true);
    const listed = await engine.catalog.list();
    expect(listed.some((session) => session.id === outsideId && session.cwd === WORKSPACE.cwd)).toBe(true);

    await engine.catalog.remove(outsideId);
    const afterDelete = await engine.scan?.();
    expect(afterDelete?.some((session) => session.sessionId === outsideId)).toBe(false);

    await engine.dispose();
    // Attached: the user's server is still answering after Morse's engine is gone.
    const response = await fetch(`${url}/api/session`, {
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      },
    });
    expect(response.ok).toBe(true);
  }, 240_000);

  it('surfaces a real form as one interaction and sends its keyed answer', async () => {
    const agent = await OpenCodeAgent.open({ api, stream, workspace: WORKSPACE, logger: silentLogger });
    const sessionId = agent.engineSessionId;
    createdSessions.push(sessionId);
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    const form = await api.post<{ id: string }>(`/session/${encodeURIComponent(sessionId)}/form`, {
      title: 'Set up the task',
      metadata: { message: 'Answer what applies' },
      fields: [
        { key: 'name', title: 'Name', type: 'string', required: true, placeholder: 'Ada' },
        { key: 'retries', title: 'Retries', type: 'integer', minimum: 1, maximum: 9, default: 3 },
        {
          key: 'mode',
          title: 'Mode',
          type: 'string',
          options: [
            { value: 'fast', label: 'Fast' },
            { value: 'careful', label: 'Careful', description: 'slower' },
          ],
        },
        { key: 'notes', title: 'Notes', type: 'string', when: [{ key: 'mode', op: 'eq', value: 'fast' }] },
        {
          key: 'targets',
          title: 'Targets',
          type: 'multiselect',
          options: [
            { value: 'linux', label: 'Linux' },
            { value: 'macos', label: 'macOS' },
          ],
        },
        { key: 'confirmIt', title: 'Confirm', type: 'boolean' },
      ],
    });
    expect(form?.id).toBeDefined();

    await until(() =>
      events.some(
        (event) => event.type === 'agent/interaction' && event.request.requestId === form!.id,
      ),
    );
    const interaction = events.find(
      (event) => event.type === 'agent/interaction' && event.request.requestId === form!.id,
    );
    const request = interaction?.type === 'agent/interaction' ? interaction.request : undefined;
    expect(request?.kind).toBe('form');
    if (request?.kind !== 'form') {
      throw new Error('not a form');
    }
    expect(request.title).toBe('Set up the task');
    expect(request.message).toBe('Answer what applies');
    expect(request.fields.map((field) => field.type)).toEqual([
      'text',
      'integer',
      'select',
      'text',
      'multiselect',
      'boolean',
    ]);
    expect(request.fields[1]).toMatchObject({ min: 1, max: 9, defaultValue: 3, required: true });
    expect(request.fields[3]?.when).toEqual({ field: 'mode', equals: 'fast' });

    await agent.respondToInteraction({
      requestId: form!.id,
      values: { name: 'Ada', retries: 3, mode: 'fast', targets: ['linux'], confirmIt: true },
    });
    await until(async () => {
      const pending = await api.get<{ id: string }[]>(`/session/${encodeURIComponent(sessionId)}/form`);
      return pending.length === 0;
    });

    await agent.dispose();
  }, 240_000);

  it('asks a real permission as once/always/reject and sends the decision', async () => {
    // A session whose rules ask before the shell runs, so the server actually
    // creates a pending request instead of allowing the call outright.
    const session = await api.post<{ id: string }>('/session', {
      location: { directory: WORKSPACE.cwd },
      permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
    });
    const sessionId = session?.id ?? '';
    expect(sessionId.length).toBeGreaterThan(0);
    createdSessions.push(sessionId);

    const agent = await OpenCodeAgent.open({
      api,
      stream,
      workspace: WORKSPACE,
      sessionId,
      logger: silentLogger,
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    // The request's source names the tool call it belongs to; a synthetic
    // message gives it a real message id without spending a model turn.
    const synthetic = await api.post<{ id: string }>(
      `/session/${encodeURIComponent(sessionId)}/synthetic`,
      { text: 'permission check' },
    );
    const created = await api.post<{ id: string; effect: string }>(
      `/session/${encodeURIComponent(sessionId)}/permission`,
      {
        action: 'shell',
        resources: ['ls -la /tmp'],
        source: { type: 'tool', messageID: synthetic?.id ?? 'msg_permission_check', id: 'call_live_test' },
      },
    );
    expect(created?.effect).toBe('ask');

    await until(() =>
      events.some(
        (event) => event.type === 'agent/interaction' && event.request.requestId === created.id,
      ),
    );
    const interaction = events.find(
      (event) => event.type === 'agent/interaction' && event.request.requestId === created.id,
    );
    const request = interaction?.type === 'agent/interaction' ? interaction.request : undefined;
    expect(request).toMatchObject({
      kind: 'select',
      options: [
        { value: 'once', label: 'Allow once' },
        { value: 'always', label: 'Always allow' },
        { value: 'reject', label: 'Reject' },
      ],
    });

    await agent.respondToInteraction({ requestId: created.id, value: 'reject' });
    await until(async () => {
      const pending = await api.get<{ id: string }[]>(
        `/session/${encodeURIComponent(sessionId)}/permission`,
      );
      return pending.length === 0;
    });
    await agent.dispose();
  }, 240_000);

  it('forks before a past prompt onto a new engine session and compacts with a warning', async () => {
    const agent = await OpenCodeAgent.open({ api, stream, workspace: WORKSPACE, logger: silentLogger });
    createdSessions.push(agent.engineSessionId);
    const events: AgentEvent[] = [];
    agent.subscribe((event) => events.push(event));

    await agent.prompt('Reply with exactly: first-live', 'new');
    await until(() => events.some((event) => event.type === 'agent/run-end'));
    events.length = 0;
    await agent.prompt('Reply with exactly: second-live', 'new');
    await until(() => events.some((event) => event.type === 'agent/run-end'));

    const prompts = await agent.forkMessages();
    expect(prompts.map((entry) => entry.text)).toEqual(
      expect.arrayContaining(['Reply with exactly: first-live', 'Reply with exactly: second-live']),
    );
    const target = prompts.at(-1)!;
    const before = agent.engineSessionId;
    const forked = await agent.fork(target.entryId);
    expect(forked.cancelled).toBe(false);
    expect(forked.text).toContain('second-live');
    const after = agent.engineSessionId;
    expect(after).not.toBe(before);
    createdSessions.push(after);
    expect((await agent.state()).sessionId).toBe(after);

    // The new branch ends before the forked prompt.
    const history = await agent.history({ limit: 20 });
    expect(history.entries.some((entry) => entry.role === 'user' && entry.text.includes('second-live'))).toBe(false);

    const notices: AgentEvent[] = [];
    agent.subscribe((event) => notices.push(event));
    await agent.compact('focus on the parser');
    expect(
      notices.some(
        (event) =>
          event.type === 'agent/notice' &&
          event.level === 'warn' &&
          event.text.includes('does not accept custom compaction instructions'),
      ),
    ).toBe(true);

    await agent.dispose();
  }, 300_000);
});
