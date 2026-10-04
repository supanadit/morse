import { describe, expect, it, vi } from 'vitest';
import {
  AgentUnavailableError,
  ChatService,
  SessionRegistry,
  silentLogger,
  type AgentEventListener,
  type AgentForkMessage,
  type AgentGateway,
  type AgentGatewayFactory,
  type AgentHistoryEntry,
  type AgentSessionState,
  type PromptDisposition,
} from '@morse/core';
import {
  PROTOCOL_VERSION,
  type HostToClientMessage,
  type SessionSummary,
  type SessionViewState,
  type TranscriptItem,
} from '@morse/protocol';
import { HostSessionController } from './session-controller.js';
import { SessionTranscriptStore } from './transcript-store.js';
import type { HostScopeOptions } from './session-controller.js';

/**
 * The bug these tests lock down: a reload (webview reload, browser refresh)
 * built a fresh `HostSessionController` that never reattached the session the
 * host was already showing, so the panel came back blank until the reader
 * picked the session by hand. And because a failed command leaked onto the
 * wire `error` channel, the frontend blamed the handshake — its "Offline"
 * banner offered Reload, whose reload is exactly what blanked the panel.
 */

const WORKSPACE = { cwd: '/tmp/morse-fake', name: 'morse-fake' };

const CAPABILITIES = {
  hostKind: 'server',
  scope: 'global',
  editorContext: false,
  nativeDialogs: false,
  insertIntoEditor: false,
  revealFile: false,
} as const;

/** A compaction the test holds in its hands: resolve/reject at will. */
interface CompactHold {
  finish(): void;
  fail(error: Error): void;
}

/** A hand-driven gateway: no pi process, no prompt ever reaches a model. */
function fakeGateway(
  options: {
    compactError?: Error;
    sessionId?: string;
    /** When set, `compact()` parks on a promise this hold can settle later. */
    hold?: CompactHold;
    /** What `history()` reports for a cold resume, oldest first. */
    historyEntries?: AgentHistoryEntry[];
    /** What `forkMessages()` offers for the fork point lookup. */
    forkMessages?: AgentForkMessage[];
    /** A committed fork: the prompt it re-opened and the new session id. */
    fork?: { text: string; sessionId: string };
    /** Counts palette-driven command re-reads; omitted means the adapter can't. */
    refreshCommands?: () => Promise<void>;
  } = {},
): AgentGateway {
  let sessionId = options.sessionId;
  const state = {
    workspace: WORKSPACE,
    thinkingLevel: 'off' as const,
    availableModels: [],
    availableThinkingLevels: [],
    availableCommands: [],
    streaming: false,
  };
  return {
    subscribe(_listener: AgentEventListener) {
      return () => undefined;
    },
    state: () => Promise.resolve({ ...state, ...(sessionId ? { sessionId } : {}) }),
    history: () =>
      Promise.resolve({ entries: options.historyEntries ?? [], hasOlder: false }),
    prompt: () => Promise.resolve<PromptDisposition>('started'),
    forkMessages: () => Promise.resolve(options.forkMessages ?? []),
    fork: () => {
      if (options.fork) {
        sessionId = options.fork.sessionId;
        return Promise.resolve({ text: options.fork.text, cancelled: false });
      }
      return Promise.resolve({ text: '', cancelled: true });
    },
    abort: () => Promise.resolve(),
    setModel: () => Promise.reject(new Error('no agent under test here')),
    setThinkingLevel: () => Promise.resolve(),
    compact: () =>
      options.hold
        ? new Promise<void>((resolve, reject) => {
            let hold = options.hold!;
            hold.finish = resolve;
            hold.fail = reject;
          })
        : Promise.reject(options.compactError ?? new Error('compact failed')),
    respondToInteraction: () => Promise.resolve(),
    ...(options.refreshCommands ? { refreshCommands: options.refreshCommands } : {}),
    dispose: () => Promise.resolve(),
  };
}

interface FreshClient {
  controller: HostSessionController;
  messages: HostToClientMessage[];
}

interface Harness extends FreshClient {
  registry: SessionRegistry;
  chat: ChatService;
  transcripts: SessionTranscriptStore;
  /** Session ids a test deleted, in order. */
  removed: string[];
  /** Spawns over the whole harness: a warm reattach never adds one. */
  spawns(): number;
  /** Session-less draft probes: how often the draft asked pi for its catalog. */
  probes(): number;
  replaces(): TranscriptItem[][];
  lastState(): SessionViewState | undefined;
  /** A reconnecting client: same registry and transcripts, a fresh sink. */
  reload(): FreshClient;
}

function connect(
  registry: SessionRegistry,
  chat: ChatService,
  transcripts: SessionTranscriptStore,
  sink: HostToClientMessage[],
  scope?: HostScopeOptions,
  agentHint?: string,
): HostSessionController {
  return new HostSessionController({
    services: { registry, chat },
    capabilities: CAPABILITIES,
    emit: (message) => sink.push(message),
    logger: silentLogger,
    transcripts,
    // Both shipping hosts pass this: a load must not create a session.
    autoOpen: false,
    ...(scope ? { scope } : {}),
    // Both shipping hosts pass this too: the one line a user can act on.
    ...(agentHint ? { agentHint } : {}),
  });
}

function harness(options: {
  compactError?: Error;
  hold?: CompactHold;
  forkMessages?: AgentForkMessage[];
  fork?: { text: string; sessionId: string };
  /** The factory refuses instead of returning a gateway: "pi is not installed". */
  spawnError?: Error;
  /** The draft probe refuses too: the same missing pi, seen before any prompt. */
  probeError?: Error;
  agentHint?: string;
  refreshCommands?: () => Promise<void>;
  /** Persisted sessions the catalog reports, so a test can seed a real title. */
  catalogSessions?: SessionSummary[];
} = {}): Harness {
  const messages: HostToClientMessage[] = [];
  const gateway = fakeGateway({
    compactError: options.compactError,
    sessionId: 'sess-1',
    ...(options.hold ? { hold: options.hold } : {}),
    ...(options.historyEntries ? { historyEntries: options.historyEntries } : {}),
    ...(options.forkMessages ? { forkMessages: options.forkMessages } : {}),
    ...(options.fork ? { fork: options.fork } : {}),
    ...(options.refreshCommands ? { refreshCommands: options.refreshCommands } : {}),
  });
  const spawns = { count: 0 };
  const probes = { count: 0 };
  const factory: AgentGatewayFactory = {
    create: () => {
      spawns.count += 1;
      return options.spawnError
        ? Promise.reject(options.spawnError)
        : Promise.resolve(gateway);
    },
    ...(options.probeError
      ? {
          probeDefaults: () => {
            probes.count += 1;
            return Promise.reject(options.probeError);
          },
        }
      : {}),
  };
  const removed: string[] = [];
  const registry = new SessionRegistry({
    factory,
    catalog: {
      list: () => Promise.resolve(options.catalogSessions ?? []),
      remove: (id) => {
        removed.push(id);
        return Promise.resolve();
      },
    },
    defaultWorkspace: WORKSPACE,
    logger: silentLogger,
  });
  const chat = new ChatService({ agent: registry, logger: silentLogger });
  const transcripts = new SessionTranscriptStore();
  const scope: HostScopeOptions = { kind: 'workspace', roots: [WORKSPACE.cwd] };
  const controller = connect(registry, chat, transcripts, messages, scope, options.agentHint);
  return {
    messages,
    registry,
    chat,
    transcripts,
    controller,
    removed,
    spawns: () => spawns.count,
    probes: () => probes.count,
    replaces: () => messages
      .filter(
        (message): message is Extract<HostToClientMessage, { type: 'transcript/replace' }> =>
          message.type === 'transcript/replace',
      )
      .map((message) => message.payload.items),
    lastState: () => lastStateOf(messages),
    reload() {
      const reloaded: HostToClientMessage[] = [];
      return {
        controller: connect(registry, chat, transcripts, reloaded, scope, options.agentHint),
        messages: reloaded,
      };
    },
  };
}

function lastStateOf(messages: HostToClientMessage[]): SessionViewState | undefined {
  // `host/ready` wraps its state; a `session/state` payload IS the state.
  const state = messages
    .filter((message) => message.type === 'host/ready' || message.type === 'session/state')
    .map((message) =>
      message.type === 'host/ready'
        ? (message.payload as { state?: SessionViewState }).state
        : message.payload,
    )
    .at(-1);
  return state;
}

function lastReplaceOf(messages: HostToClientMessage[]): TranscriptItem[] {
  const replace = messages
    .filter(
      (message): message is Extract<HostToClientMessage, { type: 'transcript/replace' }> =>
        message.type === 'transcript/replace',
    )
    .at(-1);
  return replace?.payload.items ?? [];
}

/** The conversation the "previous" connection showed: one user prompt. */
async function withOpenSession(h: Harness): Promise<void> {
  await h.controller.start();
  await h.controller.handleClientMessage({ type: 'chat/prompt', payload: { text: 'hello' } });
}

describe('HostSessionController.start (reload reattach)', () => {
  it('reattaches the active session without spawning: a reload replays the conversation', async () => {
    const h = harness();
    await withOpenSession(h);
    expect(h.transcripts.items('sess-1')).toHaveLength(1);

    const reattach = h.reload();
    await reattach.controller.start();

    const replayed = lastReplaceOf(reattach.messages);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(reattach.messages.some((message) => message.type === 'session/state')).toBe(true);
    expect(h.lastState()).toMatchObject({ agentReady: true, sessionId: 'sess-1' });
    // The warm session was reused: the reconnect spawned nothing.
    expect(h.spawns()).toBe(1);
  });

  it('names a session from its first prompt when pi reports no session name', async () => {
    const h = harness();
    await withOpenSession(h);

    // The prompt itself does not re-emit the state (a real agent's next event
    // would); activating the session is that nudge. The title must come from the
    // prompt, not fall back to the workspace name.
    await h.controller.handleClientMessage({
      type: 'session/activate',
      payload: { sessionId: 'sess-1', cwd: WORKSPACE.cwd },
    });
    expect(h.lastState()?.sessionTitle).toBe('hello');
  });

  it('prefers the catalog title over the first prompt', async () => {
    // The sidebar reads the catalog title, so the panel must show the same one —
    // not the first prompt, which can be a one-word follow-up like "commit".
    const h = harness({
      catalogSessions: [
        { id: 'sess-1', title: 'Tambahkan fitur copy', cwd: WORKSPACE.cwd, updatedAt: 1, messageCount: 4 },
      ],
    });
    await withOpenSession(h);
    await h.controller.handleClientMessage({
      type: 'session/activate',
      payload: { sessionId: 'sess-1', cwd: WORKSPACE.cwd },
    });

    expect(h.lastState()?.sessionTitle).toBe('Tambahkan fitur copy');
  });

  it('stays on the empty draft when the host has no active session — nothing spawns', async () => {
    const h = harness();
    await h.controller.start();

    expect(h.replaces().at(-1)).toEqual([]);
    expect(h.lastState()).toMatchObject({ agentReady: false });
    expect(h.spawns()).toBe(0);
  });

  it('does not resurrect a session the user closed — closing forgets the active key', async () => {
    const h = harness();
    await withOpenSession(h);
    const sessionId = String(h.lastState()?.sessionId);
    await h.controller.handleClientMessage({ type: 'session/close', payload: { sessionId } });

    const reattach = h.reload();
    await reattach.controller.start();

    expect(lastStateOf(reattach.messages)).toMatchObject({ agentReady: false });
    expect(lastReplaceOf(reattach.messages)).toEqual([]);
    expect(h.spawns()).toBe(1);
  });
});

describe('HostSessionController compaction', () => {
  it('a running compaction is busy: it drives the Working indicator and the navigator pulse, then releases', async () => {
    const hold: CompactHold = { finish: () => {}, fail: () => {} };
    const h = harness({ hold });
    await withOpenSession(h);
    h.messages.length = 0;

    // Send compact without settling it yet; the state the host is streaming
    // while it runs is what the composer and navigator render.
    const pending = h.controller.handleClientMessage({ type: 'session/compact', payload: {} });
    expect(lastStateOf(h.messages)).toMatchObject({ busy: true });

    hold.finish();
    await pending;
    // Released: the composer hands back even though nothing else is running.
    expect(lastStateOf(h.messages)).toMatchObject({ busy: false, streaming: false });
  });

  it('a failed compaction also releases the busy state', async () => {
    const hold: CompactHold = { finish: () => {}, fail: () => {} };
    const h = harness({ hold });
    await withOpenSession(h);
    h.messages.length = 0;

    const pending = h.controller.handleClientMessage({ type: 'session/compact', payload: {} });
    hold.fail(new Error('pi rejected "compact": Already compacted'));
    await pending;

    expect(lastStateOf(h.messages)).toMatchObject({ busy: false });
    // The failure is a transcript row, as before.
    expect(h.messages.some((message) => message.type === 'error')).toBe(false);
    const appends = h.messages
      .filter((message): message is Extract<HostToClientMessage, { type: 'transcript/append' }> =>
        message.type === 'transcript/append',
      )
      .map((message) => message.payload);
    expect(String(appends.at(-1)?.text)).toContain('Already compacted');
  });
});

describe('HostSessionController seeding', () => {
  it('a cold resume seeds the full history — the compaction boundary is a marker row, not a shrink', async () => {
    const h = harness({
      historyEntries: [
        { role: 'user', text: 'build me a tree', at: 1_000 },
        { role: 'assistant', text: 'sure', thinking: '', at: 2_000 },
        { role: 'compaction', summary: '## Summary\n\nBuilt a tree.', tokensBefore: 150_000, at: 3_000 },
        { role: 'user', text: 'now paint it', at: 5_000 },
      ],
    });
    await h.controller.start(); // draft: no session, nothing seeded yet
    h.messages.length = 0;

    // Activating the recorded session spawns (cold), then seeds from history.
    await h.controller.handleClientMessage({
      type: 'session/activate',
      payload: { sessionId: 'sess-1', cwd: WORKSPACE.cwd },
    });
    // Seeding runs detached from the activation; wait for the page to land.
    await vi.waitFor(() => expect(h.transcripts.items('sess-1')).toHaveLength(4));

    const items = h.transcripts.items('sess-1');
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'compaction', 'user']);
    const marker = items.find((item) => item.kind === 'compaction');
    expect(marker).toMatchObject({ summary: expect.stringContaining('Built a tree.') });
    // The whole pre-compaction conversation is still on screen: nothing was
    // dropped just because the agent's context was summarized.
    expect(items.some((item) => item.kind === 'user' && item.at === 1_000)).toBe(true);
  });
});

describe('HostSessionController failures', () => {
  it('classifies a missing agent so the frontend can offer the install command', async () => {
    const error = new AgentUnavailableError('The pi coding agent was not found.', {
      remedy: { install: 'npm install -g @earendil-works/pi-coding-agent' },
    });
    const h = harness({ spawnError: error, agentHint: 'Set "morse.pi.path" or install the pi CLI.' });
    await h.controller.start();

    // The draft's first prompt is what makes the host spawn pi — and fail.
    await h.controller.handleClientMessage({ type: 'chat/prompt', payload: { text: 'hello' } });

    const state = h.lastState();
    expect(state?.agentReady).toBe(false);
    expect(state?.agentError).toBe('The pi coding agent was not found.');
    // The frontend renders `agentFailure` as a screen (install command, host hint);
    // the message alone would leave it guessing which help to show.
    expect(state?.agentFailure).toEqual({
      code: 'agent-unavailable',
      install: 'npm install -g @earendil-works/pi-coding-agent',
      hint: 'Set "morse.pi.path" or install the pi CLI.',
    });
  });

  it('keeps the host hint but invents no code for a failure it cannot classify', async () => {
    const h = harness({ spawnError: new Error('EACCES'), agentHint: 'Check the pi path.' });
    await h.controller.start();
    await h.controller.handleClientMessage({ type: 'chat/prompt', payload: { text: 'hello' } });

    // An unknown failure must not be dressed up as "not installed": the frontend
    // would offer the wrong remedy.
    expect(h.lastState()?.agentFailure).toEqual({ hint: 'Check the pi path.' });
  });

  it('reports a missing pi on load, before any prompt is sent', async () => {
    const error = new AgentUnavailableError('The pi coding agent was not found.', {
      remedy: { install: 'npm install -g @earendil-works/pi-coding-agent' },
    });
    const h = harness({ probeError: error, agentHint: 'Install the pi CLI.' });
    await h.controller.start();

    // The probe is fired without blocking the handshake, so the state lands a
    // beat after the handshake — exactly like the model pickers do.
    const state = await vi.waitFor(() => {
      const current = h.lastState();
      expect(current?.agentFailure).toBeDefined();
      return current as SessionViewState;
    });
    expect(state.agentReady).toBe(false);
    expect(state.agentFailure).toEqual({
      code: 'agent-unavailable',
      install: 'npm install -g @earendil-works/pi-coding-agent',
      hint: 'Install the pi CLI.',
    });
    // The empty draft carried the truth to the reader; nothing was recorded and
    // no prompt was needed to discover the agent is gone.
    expect(h.spawns()).toBe(0);
  });

  it('keeps a transient draft-probe failure out of the panel', async () => {
    const h = harness({ probeError: new Error('probe timed out'), agentHint: 'Install the pi CLI.' });
    await h.controller.start();
    await vi.waitFor(() => expect(h.probes()).toBe(1));

    // Only "the agent is not there" is the reader's problem. A timeout or a
    // protocol slip leaves the pickers empty and waits for a real spawn to say so.
    expect(h.lastState()?.agentFailure).toBeUndefined();
    expect(h.lastState()?.agentError).toBeUndefined();
  });

  it('re-probes the draft on the next attempt, so Retry can reach a freshly installed pi', async () => {
    const h = harness({
      probeError: new AgentUnavailableError('The pi coding agent was not found.'),
      agentHint: 'Install the pi CLI.',
    });
    await h.controller.start();
    await vi.waitFor(() => expect(h.lastState()?.agentFailure).toBeDefined());
    expect(h.probes()).toBe(1);

    // "New session" (the setup screen's Retry) rebuilds the draft; the failed
    // probe must not be cached, or Retry could never succeed after installing pi.
    await h.controller.handleClientMessage({ type: 'session/new', payload: {} });
    expect(h.probes()).toBe(2);
  });

  it('a rejected compact lands in the transcript — never on the wire error channel', async () => {
    const h = harness({ compactError: new Error('pi rejected "compact": Already compacted') });
    await withOpenSession(h);
    h.messages.length = 0;

    await h.controller.handleClientMessage({ type: 'session/compact', payload: {} });

    // The frontend renders the wire `error` as its "Offline — the host
    // wouldn't take this frontend" banner. A command failure on a healthy
    // socket must not look like a dead connection.
    expect(h.messages.some((message) => message.type === 'error')).toBe(false);
    const appends = h.messages
      .filter((message): message is Extract<HostToClientMessage, { type: 'transcript/append' }> =>
        message.type === 'transcript/append',
      )
      .map((message) => message.payload);
    const lastErrorRow = appends.at(-1) as
      | { kind: string; level: NoticeLevel; text: string }
      | undefined;
    expect(lastErrorRow).toMatchObject({ kind: 'notice', level: 'error' });
    expect(lastErrorRow?.text).toContain('Already compacted');
  });

  it('a draft refusal reports as a notice — the wire error stays handshake-only', async () => {
    const h = harness();
    await h.controller.start();
    h.messages.length = 0;

    // Activating a session outside the workspace roots is refused while the
    // host is still on the draft: nothing has a transcript to attach to.
    await h.controller.handleClientMessage({
      type: 'session/activate',
      payload: { sessionId: 'other', cwd: '/nowhere/outside' },
    });

    expect(h.messages.some((message) => message.type === 'error')).toBe(false);
    expect(h.messages.some((message) => message.type === 'notice')).toBe(true);
    // Nothing spawned for the refused target.
    expect(h.spawns()).toBe(0);
  });

  it('a refused handshake still raises the wire error — the offline banner keeps its job', async () => {
    const h = harness();
    await h.controller.start();
    h.messages.length = 0;

    await h.controller.handleClientMessage({
      type: 'client/ready',
      payload: { protocolVersion: PROTOCOL_VERSION + 999 },
    });

    expect(h.messages.some((message) => message.type === 'error')).toBe(true);
  });
});

/**
 * Deleting is not closing: the stored conversation has to go as well, and only
 * the host knows which filesystem it may touch (a server allow-list, a VS Code
 * window). The controller therefore asks the registry — process, then catalog —
 * and reports the outcome instead of letting a row vanish silently.
 */
describe('HostSessionController session/delete', () => {
  it('disposes the process, removes the stored session and refreshes the list', async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.handleClientMessage({ type: 'chat/prompt', payload: { text: 'hello' } });
    const sessionId = h.lastState()?.sessionId ?? '';
    expect(sessionId).not.toBe('');
    h.messages.length = 0;

    await h.controller.handleClientMessage({ type: 'session/delete', payload: { sessionId } });

    // The file goes through the catalog port, the process through the registry.
    expect(h.removed).toEqual([sessionId]);
    expect(h.registry.hotKeys()).toEqual([]);
    // The reader is told what happened instead of watching the row vanish.
    expect(
      h.messages.some(
        (message) => message.type === 'notice' && message.payload.text.includes('deleted'),
      ),
    ).toBe(true);
    expect(h.messages.some((message) => message.type === 'error')).toBe(false);
  });
});

/**
 * A fork is the branch half of edit: pi re-parents the conversation before a
 * past prompt and the old branch stays resumable. Nothing is sent, so the host
 * hands the forked prompt back to the composer instead.
 */
describe('HostSessionController chat/fork', () => {
  it('branches before the message and seeds the composer instead of sending', async () => {
    const h = harness({
      forkMessages: [{ entryId: 'entry-1', text: 'hello' }],
      fork: { text: 'hello', sessionId: 'sess-2' },
    });
    await withOpenSession(h);
    // The prompt landed under the first session, so there is something to fork.
    expect(h.transcripts.items('sess-1').some((item) => item.kind === 'user')).toBe(true);
    h.messages.length = 0;

    await h.controller.handleClientMessage({
      type: 'chat/fork',
      payload: { itemId: 'morse-user-1' },
    });

    const seed = h.messages.find(
      (message): message is Extract<HostToClientMessage, { type: 'composer/seed' }> =>
        message.type === 'composer/seed',
    );
    expect(seed?.payload).toEqual({ text: 'hello' });

    // No prompt was sent, and the transcript re-homed onto the empty new branch.
    expect(h.transcripts.items('sess-1')).toEqual([]);
    expect(h.transcripts.items('sess-2')).toEqual([]);
  });
});

/**
 * The bug these tests lock down: the hot-session LRU retired the coldest entry
 * even while it was answering, so a host running more sessions than the limit —
 * several projects in parallel, which is the browser host's whole point — killed
 * the agent that was mid-answer instead of an idle one.
 */
/**
 * The bug these tests lock down: the navigator builds its project groups from
 * `project/list` and drops every session whose cwd is not in it. The list was
 * only ever sent on a handshake or an explicit request, so a brand-new project —
 * and every session inside a project missing from the last list — stayed
 * invisible until the user hit refresh.
 */
describe('HostSessionController project list', () => {
  it('refreshes project/list with every session list, so a new project appears without a refresh', async () => {
    const messages: HostToClientMessage[] = [];
    const catalogSessions = [
      {
        id: 'sess-other',
        title: 'Other work',
        cwd: '/work/other',
        updatedAt: 5,
        messageCount: 1,
      },
    ];
    const registry = new SessionRegistry({
      factory: { create: () => Promise.resolve(fakeGateway({ sessionId: 'sess-other' })) },
      catalog: { list: () => Promise.resolve(catalogSessions) },
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });
    const chat = new ChatService({ agent: registry, logger: silentLogger });
    const controller = new HostSessionController({
      services: { registry, chat },
      capabilities: CAPABILITIES,
      emit: (message) => messages.push(message),
      logger: silentLogger,
      transcripts: new SessionTranscriptStore(),
      autoOpen: false,
      scope: { kind: 'global' },
    });
    await controller.start();
    messages.length = 0;

    // The navigator asks for sessions after a change; the project list has to
    // ride along or the group has nothing to place the session in.
    await controller.handleClientMessage({ type: 'session/list', payload: {} });

    const paths = messages
      .filter(
        (message): message is Extract<HostToClientMessage, { type: 'project/list' }> =>
          message.type === 'project/list',
      )
      .at(-1)
      ?.payload.projects.map((project) => project.path);
    expect(paths).toContain('/work/other');
  });

  it('re-reads commands when the palette asks, and skips a host that cannot', async () => {
    const refreshed: number[] = [];
    const h = harness({
      refreshCommands: () => {
        refreshed.push(1);
        return Promise.resolve();
      },
    });
    await h.controller.start();
    // A draft has no gateway yet; the first prompt spawns the active one.
    await h.controller.handleClientMessage({ type: 'chat/prompt', payload: { text: 'hi' } });

    await h.controller.handleClientMessage({ type: 'commands/refresh', payload: {} });

    expect(refreshed).toHaveLength(1);

    // A gateway without the optional method: the message is a no-op, not an error.
    const plain = harness();
    await plain.controller.start();
    await plain.controller.handleClientMessage({ type: 'chat/prompt', payload: { text: 'hi' } });
    await expect(
      plain.controller.handleClientMessage({ type: 'commands/refresh', payload: {} }),
    ).resolves.toBeUndefined();
  });

  it('tells host commands which workspace the client is viewing, not the registry\'s active session', async () => {
    const seen: { command: string; cwd: string }[] = [];
    const messages: HostToClientMessage[] = [];
    const registry = new SessionRegistry({
      factory: { create: () => Promise.resolve(fakeGateway()) },
      catalog: { list: () => Promise.resolve([]) },
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });
    const chat = new ChatService({ agent: registry, logger: silentLogger });
    const controller = new HostSessionController({
      services: { registry, chat },
      capabilities: CAPABILITIES,
      emit: (message) => messages.push(message),
      logger: silentLogger,
      transcripts: new SessionTranscriptStore(),
      autoOpen: false,
      scope: { kind: 'global' },
      onHostCommand: (command, _args, context) => {
        seen.push({ command, cwd: context?.cwd ?? '' });
        return Promise.resolve({ files: [] });
      },
    });
    await controller.start();

    // A draft for another project: no session is opened, so the registry still
    // has no active key to read a cwd from. The browser host used to fall back to
    // the default workspace and cache the wrong `@` list.
    await controller.handleClientMessage({ type: 'session/new', payload: { cwd: '/work/other' } });
    await controller.handleClientMessage({
      type: 'host/command',
      payload: { command: 'listFiles', requestId: 'r1' },
    });

    expect(seen.at(-1)).toEqual({ command: 'listFiles', cwd: '/work/other' });
  });
});

describe('SessionRegistry hot limit', () => {
  /** Session ids in spawn order, with a live state a test can flip. */
  function registryWith(hotLimit: number) {
    const records = new Map<string, AgentSessionState>();
    const disposed: string[] = [];
    let spawned = 0;
    const factory: AgentGatewayFactory = {
      create: () => {
        spawned += 1;
        const sessionId = `sess-${spawned}`;
        const record: AgentSessionState = {
          workspace: WORKSPACE,
          thinkingLevel: 'off',
          availableModels: [],
          availableThinkingLevels: [],
          availableCommands: [],
          streaming: false,
          sessionId,
        };
        records.set(sessionId, record);
        return Promise.resolve({
          ...fakeGateway({ sessionId }),
          // The registry caches the state it opened with: hand it the same live
          // object so flipping `streaming` here is what the registry reads.
          state: () => Promise.resolve(record),
          dispose: () => {
            disposed.push(sessionId);
            return Promise.resolve();
          },
        });
      },
    };
    const registry = new SessionRegistry({
      factory,
      catalog: { list: () => Promise.resolve([]) },
      defaultWorkspace: WORKSPACE,
      hotLimit,
      logger: silentLogger,
    });
    return { registry, records, disposed };
  }

  it('retires the coldest idle session when the limit is exceeded', async () => {
    const { registry, disposed } = registryWith(1);
    const first = await registry.open({ workspace: WORKSPACE });
    const second = await registry.open({ workspace: WORKSPACE });

    expect(disposed).toEqual([first.key]);
    expect(registry.hotKeys()).toEqual([second.key]);
  });

  it('never retires a session that is answering, even over the limit', async () => {
    const { registry, records, disposed } = registryWith(2);
    const running = await registry.open({ workspace: WORKSPACE });
    const idle = await registry.open({ workspace: WORKSPACE });
    // The oldest session is mid-answer when a third one pushes past the limit.
    records.get(running.key)!.streaming = true;

    const third = await registry.open({ workspace: WORKSPACE });

    // The limit still holds — the idle one goes — but the running agent lives.
    expect(disposed).toEqual([idle.key]);
    expect(registry.hotKeys()).toEqual([running.key, third.key]);
  });

  it('goes over the limit rather than killing work when every session is running', async () => {
    const { registry, records, disposed } = registryWith(2);
    const first = await registry.open({ workspace: WORKSPACE });
    const second = await registry.open({ workspace: WORKSPACE });
    records.get(first.key)!.streaming = true;
    records.get(second.key)!.streaming = true;

    await registry.open({ workspace: WORKSPACE });

    expect(disposed).toEqual([]);
    expect(registry.hotKeys()).toHaveLength(3);
  });
});