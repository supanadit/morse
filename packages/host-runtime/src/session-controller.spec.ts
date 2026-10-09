import { describe, expect, it, vi } from 'vitest';
import {
  AgentUnavailableError,
  ChatService,
  SessionRegistry,
  silentLogger,
  type AgentEventListener,
  type AgentDiagnostic,
  type AgentEvent,
  type AgentForkMessage,
  type AgentGateway,
  type AgentGatewayFactory,
  type AgentHistoryEntry,
  type AgentInteractionRequest,
  type AgentSessionState,
  type ModelRef,
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
import type { TerminalBackend, TerminalSink } from './terminal.js';
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
    /** Counts model-catalog re-reads; omitted means the adapter can't. */
    refreshModels?: () => Promise<void>;
    /** Warnings the agent carries on its state (pi's refused prompt templates). */
    diagnostics?: AgentDiagnostic[];
    /** Records each compaction call's instructions and target session key. */
    onCompact?: (instructions: string | undefined, sessionKey: string | undefined) => void;
  } = {},
): AgentGateway {
  let sessionId = options.sessionId;
  const state = {
    workspace: WORKSPACE,
    thinkingLevel: 'off' as const,
    availableModels: [],
    availableThinkingLevels: [],
    availableCommands: [],
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
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
    compact: (instructions, sessionKey) => {
      options.onCompact?.(instructions, sessionKey);
      return options.hold
        ? new Promise<void>((resolve, reject) => {
            let hold = options.hold!;
            hold.finish = resolve;
            hold.fail = reject;
          })
        : Promise.reject(options.compactError ?? new Error('compact failed'));
    },
    respondToInteraction: () => Promise.resolve(),
    ...(options.refreshCommands ? { refreshCommands: options.refreshCommands } : {}),
    ...(options.refreshModels ? { refreshModels: options.refreshModels } : {}),
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
  pinnedSessionId?: string,
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
    // A VS Code editor tab shows exactly one session and addresses it.
    ...(pinnedSessionId ? { pinnedSessionId } : {}),
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
  /** A successful session-less probe whose catalog depends on the requested model. */
  probeState?: (model?: ModelRef) => AgentSessionState | undefined;
  /**
   * Parks a draft probe until a test says so, to look at the panel mid-probe.
   * `call` is 1-based, so a test can let the load-time probe through and park
   * the model pick's one.
   */
  probeGate?: (call: number) => Promise<void>;
  agentHint?: string;
  refreshCommands?: () => Promise<void>;
  /** Counts model-catalog re-reads; omitted means the adapter can't. */
  refreshModels?: () => Promise<void>;
  /** Persisted sessions the catalog reports, so a test can seed a real title. */
  catalogSessions?: SessionSummary[];
  /** Warnings the agent carries on its state (pi's refused prompt templates). */
  diagnostics?: AgentDiagnostic[];
  /** Records each compaction call's instructions and target session key. */
  onCompact?: (instructions: string | undefined, sessionKey: string | undefined) => void;
} = {}): Harness {
  const messages: HostToClientMessage[] = [];
  const gateway = fakeGateway({
    compactError: options.compactError,
    sessionId: 'sess-1',
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    ...(options.onCompact ? { onCompact: options.onCompact } : {}),
    ...(options.hold ? { hold: options.hold } : {}),
    ...(options.historyEntries ? { historyEntries: options.historyEntries } : {}),
    ...(options.forkMessages ? { forkMessages: options.forkMessages } : {}),
    ...(options.fork ? { fork: options.fork } : {}),
    ...(options.refreshCommands ? { refreshCommands: options.refreshCommands } : {}),
    ...(options.refreshModels ? { refreshModels: options.refreshModels } : {}),
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
    ...(options.probeState
      ? {
          probeDefaults: (input: { workspace: typeof WORKSPACE; model?: ModelRef }) => {
            probes.count += 1;
            const state = options.probeState!(input.model);
            if (!state) {
              return Promise.reject(new Error('no probe state'));
            }
            const gateway = fakeGateway({ sessionId: 'probe-1' });
            const gate = options.probeGate?.(probes.count) ?? Promise.resolve();
            return gate.then(() => ({ ...gateway, state: () => Promise.resolve(state) }));
          },
        }
      : options.probeError
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

  it('a pinned session key names the conversation, so a stale dialog cannot compact the wrong one', async () => {
    const calls: Array<[string | undefined, string | undefined]> = [];
    const h = harness({
      compactError: new Error('compact failed'),
      onCompact: (instructions, sessionKey) => calls.push([instructions, sessionKey]),
    });
    await withOpenSession(h);

    // The frontend pins the conversation its question was asked over. The host uses
    // that key to *select* the agent (the gateway's own id is the conversation), so
    // the call lands on the pinned session rather than reaching for whichever one is
    // in front when the message arrives. The gateway's second argument is therefore
    // the routing key resolved by `chatAgent`, not the wire field — what matters is
    // that the exact conversation was addressed.
    await h.controller.handleClientMessage({
      type: 'session/compact',
      payload: { instructions: 'keep the schema', sessionKey: 'sess-1' },
    });
    expect(calls).toEqual([['keep the schema', undefined]]);
    // And the routing key that selected this agent is the pinned one, not the
    // controller's own (undefined) target.
    expect(h.registry.activeKeyOf()).toBe('sess-1');
  });

  it('a pinned key for a session that is no longer open fails loudly, not onto the wrong one', async () => {
    const calls: Array<[string | undefined, string | undefined]> = [];
    const h = harness({
      compactError: new Error('compact failed'),
      onCompact: (instructions, sessionKey) => calls.push([instructions, sessionKey]),
    });
    await withOpenSession(h);
    h.messages.length = 0;

    // The readery switched away and the pinned conversation closed before the yes.
    // The safe failure is a refusal — never silently compacting the session that
    // happens to be in front instead.
    await h.controller.handleClientMessage({
      type: 'session/compact',
      payload: { sessionKey: 'sess-closed' },
    });
    expect(calls).toEqual([]);
    const appends = h.messages
      .filter((message): message is Extract<HostToClientMessage, { type: 'transcript/append' }> =>
        message.type === 'transcript/append',
      )
      .map((message) => message.payload);
    expect(String(appends.at(-1)?.text)).toContain('no longer open');
  });

  it('an unpinned compaction falls back to the session in front', async () => {
    const calls: Array<[string | undefined, string | undefined]> = [];
    const h = harness({
      compactError: new Error('compact failed'),
      onCompact: (instructions, sessionKey) => calls.push([instructions, sessionKey]),
    });
    await withOpenSession(h);

    // No key (an older frontend, or the shared panel): the session in front is the
    // only sensible target, which is what `promptTarget()` resolves to — here
    // `undefined`, and the registry's active session answers it.
    await h.controller.handleClientMessage({ type: 'session/compact', payload: {} });
    expect(calls).toEqual([[undefined, undefined]]);
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

  it('re-probes the draft for the picked model, so the thinking picker follows that model', async () => {
    const base: AgentSessionState = {
      workspace: WORKSPACE,
      thinkingLevel: 'low',
      availableModels: [
        { provider: 'mock', id: 'reasoner', name: 'Reasoner' },
        { provider: 'mock', id: 'plain', name: 'Plain' },
      ],
      availableThinkingLevels: ['off', 'low', 'high', 'max'],
      availableCommands: [],
      streaming: false,
    };
    const h = harness({
      probeState: (model) =>
        model?.id === 'plain'
          ? { ...base, model, thinkingLevel: 'off', availableThinkingLevels: ['off'] }
          : base,
    });
    await h.controller.start();
    await vi.waitFor(() =>
      expect(h.lastState()?.availableThinkingLevels).toEqual(['off', 'low', 'high', 'max']),
    );
    expect(h.probes()).toBe(1);

    // pi reports thinking levels per current model, so the draft's picker must
    // be re-read for the model the reader picked, not the default one's.
    await h.controller.handleClientMessage({
      type: 'model/set',
      payload: { provider: 'mock', id: 'plain' },
    });

    await vi.waitFor(() =>
      expect(h.lastState()?.availableThinkingLevels).toEqual(['off']),
    );
    expect(h.probes()).toBe(2);
    expect(h.lastState()?.model?.id).toBe('plain');
  });

  it('says it is reading the picked model\'s levels while the draft re-probe runs', async () => {
    const base: AgentSessionState = {
      workspace: WORKSPACE,
      thinkingLevel: 'low',
      availableModels: [
        { provider: 'mock', id: 'reasoner', name: 'Reasoner' },
        { provider: 'mock', id: 'plain', name: 'Plain' },
      ],
      availableThinkingLevels: ['off', 'low', 'high', 'max'],
      availableCommands: [],
      streaming: false,
    };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      probeState: (model) =>
        model?.id === 'plain'
          ? { ...base, model, thinkingLevel: 'off', availableThinkingLevels: ['off'] }
          : base,
      // The first probe is the load-time one. Only the model pick's probe parks.
      probeGate: (call) => (call > 1 ? gate : Promise.resolve()),
    });
    await h.controller.start();
    await vi.waitFor(() => expect(h.probes()).toBe(1));
    await vi.waitFor(() =>
      expect(h.lastState()?.availableThinkingLevels).toEqual(['off', 'low', 'high', 'max']),
    );

    let settled = false;
    const picked = (async () => {
      await h.controller.handleClientMessage({
        type: 'model/set',
        payload: { provider: 'mock', id: 'plain' },
      });
      settled = true;
    })();
    await vi.waitFor(() => expect(h.probes()).toBe(2));

    // pi scopes the levels to the current model, so the new model's list cannot
    // be known yet: the panel names the model already and admits it is reading
    // instead of showing the previous model's levels as if they still applied.
    // The stale list is dropped and the level reads `off` — the previous model's
    // `low` must not stand in for a model that may not have it.
    expect(settled).toBe(false);
    expect(h.lastState()?.model?.id).toBe('plain');
    expect(h.lastState()?.loadingThinkingLevels).toBe(true);
    expect(h.lastState()?.availableThinkingLevels).toEqual([]);
    expect(h.lastState()?.thinkingLevel).toBe('off');

    release?.();
    await picked;
    expect(h.lastState()?.loadingThinkingLevels).toBe(false);
    expect(h.lastState()?.availableThinkingLevels).toEqual(['off']);
  });

  it('applies a draft model the host already probed without a loading row', async () => {
    const base: AgentSessionState = {
      workspace: WORKSPACE,
      thinkingLevel: 'low',
      availableModels: [
        { provider: 'mock', id: 'reasoner', name: 'Reasoner' },
        { provider: 'mock', id: 'plain', name: 'Plain' },
      ],
      availableThinkingLevels: ['off', 'low', 'high'],
      availableCommands: [],
      streaming: false,
    };
    const h = harness({
      probeState: (model) =>
        model?.id === 'plain'
          ? { ...base, model, thinkingLevel: 'off', availableThinkingLevels: ['off'] }
          : base,
    });
    await h.controller.start();
    await vi.waitFor(() => expect(h.probes()).toBe(1));

    await h.controller.handleClientMessage({
      type: 'model/set',
      payload: { provider: 'mock', id: 'plain' },
    });
    expect(h.probes()).toBe(2);
    // Switching to the same model again is not a probe: the cached catalog
    // applies in the same frame, so the picker never flickers through a loading
    // row for an answer the host already has.
    await h.controller.handleClientMessage({
      type: 'model/set',
      payload: { provider: 'mock', id: 'plain' },
    });
    expect(h.probes()).toBe(2);
    expect(h.lastState()?.loadingThinkingLevels).toBe(false);
    expect(h.lastState()?.availableThinkingLevels).toEqual(['off']);
  });

  it('re-probes the draft catalog on models/refresh, so a new model shows up', async () => {
    let calls = 0;
    const state = (availableModels: AgentSessionState['availableModels']): AgentSessionState => ({
      workspace: WORKSPACE,
      thinkingLevel: 'off',
      availableModels,
      availableThinkingLevels: ['off'],
      availableCommands: [],
      streaming: false,
    });
    const first = [{ provider: 'mock', id: 'one', name: 'One' }];
    const second = [...first, { provider: 'thinking-lab', id: 'lab-full', name: 'Lab Full' }];
    const h = harness({
      probeState: () => {
        calls += 1;
        return state(calls === 1 ? first : second);
      },
    });
    await h.controller.start();
    await vi.waitFor(() => expect(h.lastState()?.availableModels).toHaveLength(1));

    // The picker opening sends this; without it the probe would stay cached for
    // the host's lifetime and a model added to models.json would be invisible.
    await h.controller.handleClientMessage({ type: 'models/refresh', payload: {} });

    await vi.waitFor(() => expect(h.lastState()?.availableModels).toHaveLength(2));
    expect(h.probes()).toBe(2);
  });

  it('re-asks a warm session for its model catalog on models/refresh', async () => {
    const refreshModels = vi.fn(() => Promise.resolve());
    const h = harness({ refreshModels });
    await withOpenSession(h);

    await h.controller.handleClientMessage({ type: 'models/refresh', payload: {} });

    expect(refreshModels).toHaveBeenCalledTimes(1);
    // A warm session is re-asked over RPC: no new probe, no respawn.
    expect(h.probes()).toBe(0);
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

  it('carries a prompt template pi refused in the state, never in the transcript', async () => {
    const diagnostic = {
      key: 'prompt:/home/u/.pi/agent/prompts/explain-path.md',
      level: 'warn' as const,
      text: 'Prompt template /home/u/.pi/agent/prompts/explain-path.md is not loaded by pi: Nested mappings are not allowed in compact mappings at line 1, column 14',
    };
    const h = harness({ diagnostics: [diagnostic] });
    await withOpenSession(h);

    // The warning is a row above the conversation, so the conversation itself
    // stays exactly as the reader left it.
    expect(h.transcripts.items('sess-1').some((item) => item.kind === 'notice')).toBe(false);
    expect(h.lastState()?.diagnostics).toEqual([{ level: 'warn', text: diagnostic.text }]);
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

  it('answers a failed host command without appending it to the transcript', async () => {
    const messages: HostToClientMessage[] = [];
    const registry = new SessionRegistry({
      factory: { create: () => Promise.resolve(fakeGateway({ sessionId: 'sess-1' })) },
      catalog: { list: () => Promise.resolve([]) },
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });
    const chat = new ChatService({ agent: registry, logger: silentLogger });
    const transcripts = new SessionTranscriptStore();
    const controller = new HostSessionController({
      services: { registry, chat },
      capabilities: CAPABILITIES,
      emit: (message) => messages.push(message),
      logger: silentLogger,
      transcripts,
      autoOpen: false,
      scope: { kind: 'global' },
      onHostCommand: () =>
        Promise.reject(new Error("ENOENT: no such file or directory, scandir '/gone'")),
    });
    await controller.start();
    // A live session whose transcript a failure used to be appended to.
    await controller.handleClientMessage({ type: 'chat/prompt', payload: { text: 'hi' } });
    await controller.handleClientMessage({
      type: 'host/command',
      payload: { command: 'listDirectories', requestId: 'r1' },
    });

    // The caller is told the value is missing: typing an unfinished or wrong
    // folder must land as the picker's inline message, not as conversation.
    const result = messages.find((message) => message.type === 'host/command/result');
    expect(result?.type === 'host/command/result' ? result.payload.ok : undefined).toBe(false);
    const key = registry.activeKeyOf();
    const items = key === undefined ? [] : transcripts.items(key);
    expect(items.some((item) => item.kind === 'notice' && item.level === 'error')).toBe(false);
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

/** A hand-driven shell: the test writes keystrokes and pushes output at will. */
function fakeTerminal(options: { replay?: string } = {}) {
  const writes: string[] = [];
  const opened: { cwd: string; cols: number; rows: number }[] = [];
  const sinks: TerminalSink[] = [];
  let buffer = options.replay ?? '';
  let killed = false;
  let detaches = 0;
  const backend: TerminalBackend = {
    attach(_terminalId, nextOptions, nextSink) {
      opened.push(nextOptions);
      sinks.push(nextSink);
      return {
        replay: buffer,
        write: (data) => writes.push(data),
        resize: () => undefined,
        detach: () => {
          detaches += 1;
        },
      };
    },
    close: () => {
      killed = true;
      // The real backend drops the scrollback here, so a restart does not replay it.
      buffer = '';
    },
  };
  return {
    backend,
    writes,
    opened,
    sinks,
    isKilled: () => killed,
    detaches: () => detaches,
    output: (data: string) => sinks.at(-1)?.output(data),
    end: (code?: number, error?: string) => sinks.at(-1)?.exit(code, error),
  };
}

describe('HostSessionController terminal', () => {
  function controller(messages: HostToClientMessage[], terminal?: TerminalBackend) {
    const registry = new SessionRegistry({
      factory: { create: () => Promise.resolve(fakeGateway()) },
      catalog: { list: () => Promise.resolve([]) },
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });
    const chat = new ChatService({ agent: registry, logger: silentLogger });
    return new HostSessionController({
      services: { registry, chat },
      capabilities: CAPABILITIES,
      emit: (message) => messages.push(message),
      logger: silentLogger,
      transcripts: new SessionTranscriptStore(),
      autoOpen: false,
      scope: { kind: 'global' },
      ...(terminal ? { terminal } : {}),
    });
  }

  it('opens a shell in the viewing workspace and streams it', async () => {
    const messages: HostToClientMessage[] = [];
    const shell = fakeTerminal();
    const host = controller(messages, shell.backend);
    await host.start();

    await host.handleClientMessage({ type: 'terminal/open', payload: { terminalId: 't1' } });
    shell.output('hello\n');
    await host.handleClientMessage({
      type: 'terminal/input',
      payload: { terminalId: 't1', data: 'ls\n' },
    });

    expect(shell.opened[0]?.cwd).toBe(WORKSPACE.cwd);
    expect(shell.writes).toEqual(['ls\n']);
    expect(messages).toContainEqual({
      type: 'terminal/output',
      payload: { terminalId: 't1', data: 'hello\n' },
    });
  });

  it('kills the shell on close, but only detaches it when the client leaves', async () => {
    const messages: HostToClientMessage[] = [];
    const shell = fakeTerminal();
    const host = controller(messages, shell.backend);
    await host.start();

    await host.handleClientMessage({ type: 'terminal/open', payload: { terminalId: 't1' } });
    await host.handleClientMessage({ type: 'terminal/close', payload: { terminalId: 't1' } });
    expect(shell.isKilled()).toBe(true);

    // A shell still open when the connection goes away is left running: the host
    // owns it, and a reloaded page attaches to the same process.
    const second = fakeTerminal();
    const other = controller(messages, second.backend);
    await other.start();
    await other.handleClientMessage({ type: 'terminal/open', payload: { terminalId: 't2' } });
    await other.dispose();
    expect(second.isKilled()).toBe(false);
    expect(second.detaches()).toBe(1);
  });

  it('replays the scrollback a reattached shell produced while nobody watched', async () => {
    const messages: HostToClientMessage[] = [];
    const shell = fakeTerminal({ replay: 'earlier output\n' });
    const host = controller(messages, shell.backend);
    await host.start();

    await host.handleClientMessage({ type: 'terminal/open', payload: { terminalId: 't1' } });

    expect(messages).toContainEqual({
      type: 'terminal/output',
      payload: { terminalId: 't1', data: 'earlier output\n' },
    });
  });

  it('clears the scrollback when a shell is restarted on the same connection', async () => {
    const messages: HostToClientMessage[] = [];
    const shell = fakeTerminal({ replay: 'before the restart\n' });
    const host = controller(messages, shell.backend);
    await host.start();

    await host.handleClientMessage({ type: 'terminal/open', payload: { terminalId: 't1' } });
    shell.end(0);
    // Restart: the emulator still shows the old output, so replaying it would
    // duplicate the whole scrollback.
    messages.length = 0;
    await host.handleClientMessage({ type: 'terminal/open', payload: { terminalId: 't1' } });

    expect(shell.isKilled()).toBe(true);
    expect(messages.filter((message) => message.type === 'terminal/output')).toHaveLength(0);
  });

  it('reports a shell that could not start as an exit with the reason', async () => {
    const messages: HostToClientMessage[] = [];
    const host = controller(messages, {
      attach: () => Promise.reject(new Error('not allowed here')),
      close: () => undefined,
    });
    await host.start();

    await host.handleClientMessage({ type: 'terminal/open', payload: { terminalId: 't1' } });

    expect(messages).toContainEqual({
      type: 'terminal/exit',
      payload: { terminalId: 't1', code: undefined, error: 'not allowed here' },
    });
  });

  it('ignores the exit of a shell replaced under the same id', async () => {
    const messages: HostToClientMessage[] = [];
    const shells = fakeTerminal();
    const host = controller(messages, shells.backend);
    await host.start();

    // Open t1 twice: the second replaces the first.
    await host.handleClientMessage({ type: 'terminal/open', payload: { terminalId: 't1' } });
    await host.handleClientMessage({ type: 'terminal/open', payload: { terminalId: 't1' } });
    // The superseded shell ends late; that is not the terminal's news.
    shells.sinks[0]?.exit(1);

    expect(messages.filter((message) => message.type === 'terminal/exit')).toHaveLength(0);

    // The shell now holding the id still streams and reports.
    shells.sinks[1]?.output('still here\n');
    shells.sinks[1]?.exit(0);
    expect(messages).toContainEqual({
      type: 'terminal/output',
      payload: { terminalId: 't1', data: 'still here\n' },
    });
    expect(messages).toContainEqual({
      type: 'terminal/exit',
      payload: { terminalId: 't1', code: 0, error: undefined },
    });
  });

  it('refuses a terminal when the host has no backend', async () => {
    const messages: HostToClientMessage[] = [];
    const host = controller(messages);
    await host.start();

    await host.handleClientMessage({ type: 'terminal/open', payload: { terminalId: 't1' } });

    expect(messages).toContainEqual({
      type: 'terminal/exit',
      payload: { terminalId: 't1', code: undefined, error: 'This host has no terminal.' },
    });
  });
});
describe('HostSessionController background prompts', () => {
  it('runs a session-addressed prompt in that session without switching the view', async () => {
    const messages: HostToClientMessage[] = [];
    const sent: { sessionId: string; text: string }[] = [];
    const factory: AgentGatewayFactory = {
      create: (options) => {
        const sessionId = options.sessionId ?? 'generated';
        const gateway = fakeGateway({ sessionId });
        return Promise.resolve({
          ...gateway,
          prompt: (text: string) => {
            sent.push({ sessionId, text });
            return Promise.resolve<PromptDisposition>('started');
          },
        });
      },
    };
    const registry = new SessionRegistry({
      factory,
      catalog: { list: () => Promise.resolve([]) },
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });
    const chat = new ChatService({ agent: registry, logger: silentLogger });
    const transcripts = new SessionTranscriptStore();
    const host = connect(registry, chat, transcripts, messages);

    // A background session first, then the one the panel shows.
    await registry.open({ sessionId: 'sess-a' });
    await host.handleClientMessage({
      type: 'session/activate',
      payload: { sessionId: 'sess-b', cwd: WORKSPACE.cwd },
    });

    await host.handleClientMessage({
      type: 'chat/prompt',
      payload: { text: 'queued follow-up', sessionKey: 'sess-a' },
    });

    // It reached the addressed session, and only that one.
    expect(sent).toEqual([{ sessionId: 'sess-a', text: 'queued follow-up' }]);
    // Its transcript got the user item; the panel never switched to it.
    expect(transcripts.items('sess-a')).toHaveLength(1);
    expect(registry.activeKeyOf()).toBe('sess-b');
    expect(lastStateOf(messages)?.sessionId).toBe('sess-b');
  });
});

/**
 * The transport fires every client message without awaiting the last, so a
 * prompt used to run in parallel with the model or thinking pick it followed.
 * A fast Enter — switching to a model that has no reasoning, then immediately
 * sending — could reach the agent before the switch settled, and the prompt was
 * answered by the previous model's settings. The controller now orders the
 * mutating messages; these lock that down.
 */
describe('HostSessionController ordering of settings and prompts', () => {
  interface Ordering {
    host: HostSessionController;
    /** Resolves the parked `setModel` so the switch can finish. */
    release(): void;
    /** Every model the agent was told to switch to, in order. */
    models: ModelRef[];
    /** Every prompt that reached the agent, in order, with the model it saw. */
    prompts: { text: string; model: string | undefined }[];
    /** The model the agent currently holds, as the fake gateway sees it. */
    current(): ModelRef | undefined;
  }

  async function ordering(): Promise<Ordering> {
    const messages: HostToClientMessage[] = [];
    const models: ModelRef[] = [];
    const prompts: { text: string; model: string | undefined }[] = [];
    let current: ModelRef | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory: AgentGatewayFactory = {
      create: () => {
        const gateway = fakeGateway({ sessionId: 'sess-1' });
        return Promise.resolve({
          ...gateway,
          // The switch parks, like pi re-reading the new model's levels does;
          // a switch to `broken` fails outright, to prove the chain survives it.
          setModel: (model: ModelRef) => {
            models.push(model);
            if (model.id === 'broken') {
              return Promise.reject(new Error('set_model refused'));
            }
            return gate.then(() => {
              current = model;
            });
          },
          prompt: (text: string) => {
            prompts.push({ text, model: current?.id });
            return Promise.resolve<PromptDisposition>('started');
          },
        });
      },
    };
    const registry = new SessionRegistry({
      factory,
      catalog: { list: () => Promise.resolve([]) },
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });
    const chat = new ChatService({ agent: registry, logger: silentLogger });
    const host = connect(registry, chat, new SessionTranscriptStore(), messages);
    await host.start();
    await host.handleClientMessage({ type: 'chat/prompt', payload: { text: 'first' } });
    // Only the prompt under test should be parked against the gate; the session
    // is warm now and the next two messages are the ones being ordered.
    current = { provider: 'mock', id: 'reasoner', name: 'Reasoner' };
    prompts.length = 0;
    return {
      host,
      release: () => release?.(),
      models,
      prompts,
      current: () => current,
    };
  }

  it('holds a prompt behind a slow model switch instead of racing it', async () => {
    const h = await ordering();

    // Fired the way the transport does: neither awaited before the next.
    const switching = h.host.handleClientMessage({
      type: 'model/set',
      payload: { provider: 'mock', id: 'plain' },
    });
    const sending = h.host.handleClientMessage({
      type: 'chat/prompt',
      payload: { text: 'answer me' },
    });

    await Promise.resolve();
    // The switch is still in flight, so the prompt must not have reached the
    // agent — and must not have been answered by the old model.
    expect(h.models.map((model) => model.id)).toEqual(['plain']);
    expect(h.prompts).toEqual([]);

    h.release();
    await switching;
    await sending;

    // The prompt ran on the model it was meant to follow, not the previous one.
    expect(h.prompts).toEqual([{ text: 'answer me', model: 'plain' }]);
  });

  it('keeps the chain alive after a failed message, so the next prompt still sends', async () => {
    const h = await ordering();

    // A switch that fails: the chain must not wedge on the rejected message.
    const failing = h.host.handleClientMessage({
      type: 'model/set',
      payload: { provider: 'mock', id: 'broken' },
    });
    await failing.catch(() => undefined);

    await h.host.handleClientMessage({
      type: 'chat/prompt',
      payload: { text: 'still reaches the agent' },
    });

    expect(h.prompts.map((prompt) => prompt.text)).toContain('still reaches the agent');
  });
});

/**
 * An extension dialog (`ui.select`/`input`) belongs to the session that raised
 * it. The bug: it was routed through whatever session happened to be in front,
 * and a dialog raised in a background conversation was dropped entirely — its
 * pi process then waited forever. These tests drive a real per-session gateway
 * that can emit events, so both halves are checked.
 */
describe('HostSessionController session-scoped dialogs', () => {
  interface Controlled {
    gateway: AgentGateway;
    emit(event: AgentEvent): void;
    respond: ReturnType<typeof vi.fn>;
  }

  function controlled(sessionId: string): Controlled {
    const listeners: AgentEventListener[] = [];
    const respond = vi.fn(async () => undefined);
    const state: AgentSessionState = {
      workspace: WORKSPACE,
      thinkingLevel: 'off',
      availableModels: [],
      availableThinkingLevels: [],
      availableCommands: [],
      streaming: true,
      sessionId,
    };
    const gateway: AgentGateway = {
      subscribe(listener) {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        };
      },
      state: () => Promise.resolve(state),
      history: () => Promise.resolve({ entries: [], hasOlder: false }),
      prompt: () => Promise.resolve<PromptDisposition>('started'),
      forkMessages: () => Promise.resolve([]),
      fork: () => Promise.resolve({ text: '', cancelled: true }),
      abort: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      setThinkingLevel: () => Promise.resolve(),
      compact: () => Promise.resolve(),
      respondToInteraction: respond,
      dispose: () => Promise.resolve(),
    };
    return {
      gateway,
      emit: (event) => {
        for (const listener of [...listeners]) {
          listener(event);
        }
      },
      respond,
    };
  }

  async function twoSessions(): Promise<{
    host: HostSessionController;
    messages: HostToClientMessage[];
    created: Controlled[];
  }> {
    const messages: HostToClientMessage[] = [];
    const created: Controlled[] = [];
    const factory: AgentGatewayFactory = {
      create: (options) => {
        const sessionId = options.sessionId ?? `generated-${created.length + 1}`;
        const session = controlled(sessionId);
        created.push(session);
        return Promise.resolve(session.gateway);
      },
    };
    const registry = new SessionRegistry({
      factory,
      catalog: { list: () => Promise.resolve([]) },
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });
    const chat = new ChatService({ agent: registry, logger: silentLogger });
    const transcripts = new SessionTranscriptStore();
    const host = connect(registry, chat, transcripts, messages);
    await host.start();
    // sess-a is the one in front; sess-b stays hot in the background.
    await registry.open({ sessionId: 'sess-a' });
    await registry.open({ sessionId: 'sess-b' });
    await host.handleClientMessage({
      type: 'session/activate',
      payload: { sessionId: 'sess-a', cwd: WORKSPACE.cwd },
    });
    return { host, messages, created };
  }

  it('holds a background dialog until its session is in front, then answers there', async () => {
    const { host, messages, created } = await twoSessions();
    const request: AgentInteractionRequest = {
      requestId: 'req-1',
      kind: 'input',
      title: 'What is your name?',
      placeholder: 'name',
    };

    created[1].emit({ type: 'agent/interaction', at: Date.now(), request });
    await Promise.resolve();

    // The background dialog did not steal the panel's single slot...
    expect(messages.some((message) => message.type === 'interaction/request')).toBe(false);
    // ...but the navigator can mark the session that is waiting on it.
    const activity = messages
      .filter((message) => message.type === 'session/activity')
      .at(-1);
    const waiting = activity?.payload.sessions.find((s) => s.sessionKey === 'sess-b');
    expect(waiting?.needsInput).toBe(true);

    // Switching to it puts the dialog back in the slot...
    await host.handleClientMessage({
      type: 'session/activate',
      payload: { sessionId: 'sess-b', cwd: WORKSPACE.cwd },
    });
    const shown = messages.filter((message) => message.type === 'interaction/request').at(-1);
    expect(shown?.payload.requestId).toBe('req-1');

    // ...and the answer goes to the session that asked, not the previous one.
    await host.handleClientMessage({
      type: 'interaction/respond',
      payload: { requestId: 'req-1', value: 'Ada' },
    });
    expect(created[1].respond).toHaveBeenCalledTimes(1);
    expect(created[0].respond).not.toHaveBeenCalled();
    expect(
      messages.some(
        (message) =>
          message.type === 'interaction/dismiss' && message.payload.requestId === 'req-1',
      ),
    ).toBe(true);
  });

  it('dismisses a dialog when the reader switches away from its session', async () => {
    const { host, messages, created } = await twoSessions();
    const request: AgentInteractionRequest = {
      requestId: 'req-2',
      kind: 'confirm',
      title: 'Proceed?',
      message: 'Continue with the change?',
    };
    created[1].emit({ type: 'agent/interaction', at: Date.now(), request });
    await host.handleClientMessage({
      type: 'session/activate',
      payload: { sessionId: 'sess-b', cwd: WORKSPACE.cwd },
    });

    await host.handleClientMessage({
      type: 'session/activate',
      payload: { sessionId: 'sess-a', cwd: WORKSPACE.cwd },
    });

    const dismissed = messages
      .filter((message) => message.type === 'interaction/dismiss')
      .at(-1);
    expect(dismissed?.payload.requestId).toBe('req-2');
  });
});

/**
 * A pinned client is a VS Code editor tab: it shows one session and must keep
 * addressing it. These lock the two ways that could go wrong — following some
 * other surface's `session/activate`, and acting on the host-wide active pointer.
 */
describe('HostSessionController (pinned to one session)', () => {
  /** A factory whose gateways record the prompts each session was sent. */
  function recordingRegistry(): {
    registry: SessionRegistry;
    promptsFor(sessionId: string): string[];
  } {
    const prompts = new Map<string, string[]>();
    const factory: AgentGatewayFactory = {
      create: (options) => {
        const sessionId = options.sessionId ?? `generated-${prompts.size + 1}`;
        const sent = prompts.get(sessionId) ?? [];
        prompts.set(sessionId, sent);
        const gateway = fakeGateway({ sessionId });
        return Promise.resolve({
          ...gateway,
          prompt: (text: string) => {
            sent.push(text);
            return Promise.resolve<PromptDisposition>('started');
          },
        });
      },
    };
    const registry = new SessionRegistry({
      factory,
      catalog: { list: () => Promise.resolve([]) },
      defaultWorkspace: WORKSPACE,
      logger: silentLogger,
    });
    return { registry, promptsFor: (id) => prompts.get(id) ?? [] };
  }

  /** Two sessions opened by a sidebar client, then a client pinned to sess-b. */
  async function pinned(): Promise<{
    host: HostSessionController;
    messages: HostToClientMessage[];
    registry: SessionRegistry;
    promptsFor(sessionId: string): string[];
  }> {
    const { registry, promptsFor } = recordingRegistry();
    const chat = new ChatService({ agent: registry, logger: silentLogger });
    const transcripts = new SessionTranscriptStore();
    const sidebar = connect(registry, chat, transcripts, []);
    await sidebar.start();
    await registry.open({ sessionId: 'sess-a' });
    await registry.open({ sessionId: 'sess-b' });
    await sidebar.handleClientMessage({
      type: 'session/activate',
      payload: { sessionId: 'sess-a', cwd: WORKSPACE.cwd },
    });

    const messages: HostToClientMessage[] = [];
    const host = connect(registry, chat, transcripts, messages, undefined, undefined, 'sess-b');
    await host.start();
    return { host, messages, registry, promptsFor };
  }

  it('adopts its own session on start, and shows it', async () => {
    const { messages } = await pinned();
    // Starting activates the pinned session (reusing a warm process), so the
    // host-wide pointer follows it — that is intended: one window has one
    // session in front, and the sidebar reattaches to whatever was last
    // activated. What matters is that this tab shows its own session.
    expect(lastStateOf(messages)?.sessionId).toBe('sess-b');
  });

  it('keeps its session after another surface activates a different one', async () => {
    const { host, messages } = await pinned();

    // The sidebar switches to sess-a; this tab must not follow it.
    await host.handleClientMessage({
      type: 'session/activate',
      payload: { sessionId: 'sess-a', cwd: WORKSPACE.cwd },
    });

    expect(lastStateOf(messages)?.sessionId).toBe('sess-b');
  });

  it('sends its prompt to its own session, not the host-wide active one', async () => {
    const { host, registry, promptsFor } = await pinned();
    // The sidebar moved the host-wide pointer away from this tab's session.
    await registry.activate('sess-a');

    await host.handleClientMessage({ type: 'chat/prompt', payload: { text: 'only here' } });

    expect(promptsFor('sess-b')).toEqual(['only here']);
    expect(promptsFor('sess-a')).toEqual([]);
  });

  it('falls back to the empty draft when its session is gone instead of adopting another', async () => {
    const { host, messages, registry } = await pinned();

    // The sidebar closes this tab's session out from under it.
    await registry.close('sess-b');
    await host.handleClientMessage({
      type: 'session/close',
      payload: { sessionId: 'sess-b' },
    });

    // Another live session exists, but showing it here would silently turn this
    // tab into a different conversation.
    expect(lastStateOf(messages)?.sessionId).toBeUndefined();
  });
});
