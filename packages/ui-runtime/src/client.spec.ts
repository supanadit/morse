import { describe, expect, it, vi } from 'vitest';
import { createInitialView, reduceConnection, reduceSessionView, PROTOCOL_VERSION } from '@morse/protocol';
import type {
  ClientToHostMessage,
  ComposerSeed,
  HostCapabilities,
  HostToClientMessage,
  SessionView,
} from '@morse/protocol';
import { createMorseClient } from './client.js';
import type { HostTransport, TransportStatus } from './transport/host-transport.js';
import { MemoryHostTransport } from './transport/memory-transport.js';

describe('createMorseClient', () => {
  it('turns host/ready into view state', () => {
    const client = createMorseClient({ transport: new MemoryHostTransport() });
    const view = client.getView();

    expect(view.connection).toBe('ready');
    expect(view.state.agentReady).toBe(true);
    expect(view.state.workspace.name).toBe('mock-workspace');
    expect(view.state.availableModels.length).toBeGreaterThan(0);

    client.dispose();
  });

  it('streams a prompt into a single assistant item', () => {
    vi.useFakeTimers();
    const client = createMorseClient({ transport: new MemoryHostTransport() });

    // The mock host ships a seeded conversation, so the transcript is not empty.
    const seeded = client.getView().items.length;
    expect(seeded).toBeGreaterThan(0);

    client.actions.prompt('hello there');
    vi.advanceTimersByTime(5_000);

    const items = client.getView().items;
    expect(items.some((item) => item.kind === 'user' && item.text === 'hello there')).toBe(true);

    const answers = items.filter((item) => item.kind === 'assistant');
    const answer = answers.find(
      (item) => item.kind === 'assistant' && item.text.includes('Mock host received'),
    );
    expect(answer).toBeDefined();
    if (answer && answer.kind === 'assistant') {
      expect(answer.text).toContain('Mock host received: "hello there"');
      expect(answer.streaming).toBe(false);
    }

    expect(items.some((item) => item.kind === 'tool')).toBe(true);

    vi.useRealTimers();
    client.dispose();
  });

  it('sends pins as attachments on the wire, never inside the prompt text', () => {
    const transport = stubTransport();
    const client = createMorseClient({ transport });

    client.actions.prompt('Ini apa?', 'new', [
      { data: 'QUJD', mimeType: 'image/png' },
    ], [{ path: 'chat/tool.ts', startLine: 37, endLine: 52 }]);

    const prompt = transport.sent.find(
      (message): message is Extract<ClientToHostMessage, { type: 'chat/prompt' }> =>
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: string }).type === 'chat/prompt',
    );
    expect(prompt?.payload.text).toBe('Ini apa?');
    expect(prompt?.payload.images).toEqual([{ data: 'QUJD', mimeType: 'image/png' }]);
    expect(prompt?.payload.pins).toEqual([{ path: 'chat/tool.ts', startLine: 37, endLine: 52 }]);

    client.dispose();
  });

  it('sends an edit as `chat/edit` with the target item id', () => {
    const transport = stubTransport();
    const client = createMorseClient({ transport });

    client.actions.editMessage('morse-user-2', 'The corrected question');

    expect(transport.sent.at(-1)).toEqual({
      type: 'chat/edit',
      payload: { itemId: 'morse-user-2', text: 'The corrected question' },
    });

    client.dispose();
  });

  it('sends a fork as `chat/fork` with the target item id', () => {
    const transport = stubTransport();
    const client = createMorseClient({ transport });

    client.actions.forkMessage('morse-user-2');

    expect(transport.sent.at(-1)).toEqual({
      type: 'chat/fork',
      payload: { itemId: 'morse-user-2' },
    });

    client.dispose();
  });

  it('asks the host to re-read commands with `commands/refresh`', () => {
    const transport = stubTransport();
    const client = createMorseClient({ transport });

    client.actions.refreshCommands();

    expect(transport.sent.at(-1)).toEqual({ type: 'commands/refresh', payload: {} });

    client.dispose();
  });

  it('routes a forked prompt (`composer/seed`) to listeners', () => {
    const transport = stubTransport();
    const client = createMorseClient({ transport });

    const seeds: ComposerSeed[] = [];
    const stop = client.onComposerSeed((seed) => seeds.push(seed));
    transport.emit({
      type: 'composer/seed',
      payload: {
        text: 'the forked question',
        images: [{ data: 'QUJD', mimeType: 'image/png' }],
        pins: [{ path: 'chat/tool.ts', startLine: 37, endLine: 52 }],
      },
    });

    expect(seeds).toEqual([
      {
        text: 'the forked question',
        images: [{ data: 'QUJD', mimeType: 'image/png' }],
        pins: [{ path: 'chat/tool.ts', startLine: 37, endLine: 52 }],
      },
    ]);

    stop();
    transport.emit({ type: 'composer/seed', payload: { text: 'ignored' } });
    expect(seeds).toHaveLength(1);

    client.dispose();
  });

  it('routes host-pinned selections (`context/selection`) to listeners', () => {
    const transport = stubTransport();
    const client = createMorseClient({ transport });

    const pins: { path: string; startLine?: number; endLine?: number }[] = [];
    const stop = client.onContextSelection((pin) => pins.push(pin));
    transport.emit({ type: 'context/selection', payload: { path: 'chat/tool.ts', startLine: 37, endLine: 52 } });

    expect(pins).toEqual([{ path: 'chat/tool.ts', startLine: 37, endLine: 52 }]);

    stop();
    transport.emit({ type: 'context/selection', payload: { path: 'other.ts' } });
    expect(pins).toHaveLength(1);

    client.dispose();
  });

  it('routes live selection previews (`context/selectionLive`) to listeners', () => {
    const transport = stubTransport();
    const client = createMorseClient({ transport });

    const previews: { path: string; startLine?: number; endLine?: number }[] = [];
    const stop = client.onContextSelectionLive((preview) => previews.push(preview));
    // A drag arrives as a stream of previews; only the current numbers matter.
    transport.emit({ type: 'context/selectionLive', payload: { path: 'chat/tool.ts', startLine: 37, endLine: 44 } });
    transport.emit({ type: 'context/selectionLive', payload: { path: 'chat/tool.ts', startLine: 37, endLine: 52 } });

    expect(previews).toEqual([
      { path: 'chat/tool.ts', startLine: 37, endLine: 44 },
      { path: 'chat/tool.ts', startLine: 37, endLine: 52 },
    ]);

    stop();
    transport.emit({ type: 'context/selectionLive', payload: { path: 'chat/tool.ts' } });
    expect(previews).toHaveLength(2);

    client.dispose();
  });
});

/** A minimal transport the tests can push host messages into and inspect with. */
function stubTransport(): HostTransport & { emit(message: HostToClientMessage): void; sent: unknown[] } {
  let listener: ((message: HostToClientMessage) => void) | undefined;
  return {
    sent: [],
    connect: () => undefined,
    send(message: ClientToHostMessage): void {
      this.sent.push(message);
    },
    onMessage(subscribed: (message: HostToClientMessage) => void): () => void {
      listener = subscribed;
      return () => {
        listener = undefined;
      };
    },
    onStatus(_listener: (status: TransportStatus, detail?: string) => void): () => void {
      return () => undefined;
    },
    emit(message: HostToClientMessage): void {
      listener?.(message);
    },
    dispose: () => undefined,
  };
}

describe('reduceSessionView', () => {
  it('keeps the host epoch steady and advances it only on a reconnect', () => {
    const ready = (view: SessionView): SessionView =>
      reduceSessionView(view, {
        type: 'host/ready',
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {} as HostCapabilities,
          state: view.state,
        },
      });

    // The first ready is the initial handshake, not a reconnect.
    const first = ready(createInitialView());
    expect(first.hostEpoch).toBe(0);
    // A manual re-handshake on a live socket is not a new host either, so a
    // terminal watching this must not re-attach (and kill its shell) for nothing.
    expect(ready(first).hostEpoch).toBe(0);

    // A ready that follows a dropped connection *is* a new host.
    const dropped = reduceConnection(first, 'closed', 'Connection lost');
    expect(ready(dropped).hostEpoch).toBe(1);
  });

  it('appends text and thinking deltas to the same item', () => {
    const view = createInitialView();
    const withItem = reduceSessionView(view, {
      type: 'transcript/append',
      payload: { kind: 'assistant', id: 'a1', at: 1, text: '', thinking: '', streaming: true },
    });
    const afterText = reduceSessionView(withItem, {
      type: 'transcript/delta',
      payload: { id: 'a1', text: 'hello ' },
    });
    const afterThinking = reduceSessionView(afterText, {
      type: 'transcript/delta',
      payload: { id: 'a1', thinking: 'hmm' },
    });

    const item = afterThinking.items[0];
    expect(afterThinking.items).toHaveLength(1);
    expect(item?.kind).toBe('assistant');
    if (item && item.kind === 'assistant') {
      expect(item.text).toBe('hello ');
      expect(item.thinking).toBe('hmm');
      expect(item.streaming).toBe(true);
    }
  });

  it('inserts a history page in front of what is already shown', () => {
    const view = createInitialView();
    const seeded = reduceSessionView(view, {
      type: 'transcript/replace',
      payload: {
        items: [
          { kind: 'assistant', id: 'a1', at: 2, text: 'newer', thinking: '', streaming: false },
        ],
      },
    });
    const prepended = reduceSessionView(seeded, {
      type: 'transcript/prepend',
      payload: { items: [{ kind: 'user', id: 'u0', at: 1, text: 'older' }] },
    });
    expect(prepended.items.map((item) => item.id)).toEqual(['u0', 'a1']);
  });

  it('ignores unknown message shapes without throwing', () => {
    const view = createInitialView();
    const unknown = { type: 'nope/whatever', payload: {} } as unknown as Parameters<
      typeof reduceSessionView
    >[1];
    expect(reduceSessionView(view, unknown)).toBe(view);
  });
});
