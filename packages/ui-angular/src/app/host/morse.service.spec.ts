import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { HostToClientMessage, SessionViewState } from '@morse/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { MORSE_TRANSPORT } from './transport.token';
import { MorseService } from './morse.service';
import type { HostTransport, TransportKind, TransportStatus } from '@morse/ui-runtime';

/** A transport whose `toClient` lets a test push host messages by hand. */
class ScriptedTransport implements HostTransport {
  readonly kind: TransportKind = 'memory';
  private readonly listeners = new Set<(message: HostToClientMessage) => void>();
  private readonly statuses = new Set<(status: TransportStatus, detail?: string) => void>();
  readonly sent: unknown[] = [];
  connect(): void {}
  dispose(): void {}
  send(message: unknown): void {
    this.sent.push(message);
  }
  onMessage(listener: (message: HostToClientMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onStatus(listener: (status: TransportStatus, detail?: string) => void): () => void {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }
  toClient(message: HostToClientMessage): void {
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }
}

function state(
  overrides: Partial<SessionViewState> & { workspace: SessionViewState['workspace'] },
) {
  return {
    streaming: false,
    busy: false,
    availableModels: [],
    availableThinkingLevels: [],
    availableCommands: [],
    ...overrides,
  } as SessionViewState;
}

/**
 * `MorseService.workspace` is read by effects that trigger I/O: the git panel
 * re-reads its repository list plus a history/status round trip per repository,
 * and the Explorer re-reads the tree. The host rebuilds that `workspace` object
 * on every `session/state` emit — which happens on every `agent/state` during a
 * run — so returning it straight through made those effects fire on every token.
 * On a project holding two dozen repositories that storm outran the 5s answer
 * timeout, and the panel reported that the host could not read its history.
 *
 * The computed must therefore be equal by *value*: unchanged in a run's emits,
 * and a new value only when the project actually changes.
 */
describe('MorseService.workspace stability', () => {
  afterEach(() => TestBed.resetTestingModule());

  function mount(transport: ScriptedTransport) {
    TestBed.configureTestingModule({
      providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
    });
    return TestBed.inject(MorseService);
  }

  it('keeps the same value across state emits for the same project', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    const seen: unknown[] = [];

    for (let index = 0; index < 20; index += 1) {
      transport.toClient({
        type: 'session/state',
        payload: state({ workspace: { cwd: '/repo', name: 'repo' } }),
      });
      seen.push(morse.workspace());
    }

    const first = seen[0];
    expect(seen.every((value) => value === first)).toBe(true);
  });

  it('reports a new value only when the project actually changes', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);

    transport.toClient({
      type: 'session/state',
      payload: state({ workspace: { cwd: '/repo', name: 'repo' } }),
    });
    const before = morse.workspace();
    transport.toClient({
      type: 'session/state',
      payload: state({ workspace: { cwd: '/other', name: 'other' } }),
    });

    expect(morse.workspace()).not.toBe(before);
    expect(morse.workspace().cwd).toBe('/other');
  });

  it('does not notify a dependent of an unchanged project', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    let runs = 0;
    // Exactly what the git panel's effect does: read `workspace()` as a signal.
    const project = computed(() => {
      runs += 1;
      return morse.workspace().cwd;
    });

    transport.toClient({
      type: 'session/state',
      payload: state({ workspace: { cwd: '/repo', name: 'repo' } }),
    });
    const afterFirst = project();
    expect(afterFirst).toBe('/repo');

    // A run's emits change the streaming flag, not the project.
    for (let index = 0; index < 5; index += 1) {
      transport.toClient({
        type: 'session/state',
        payload: state({
          workspace: { cwd: '/repo', name: 'repo' },
          streaming: index % 2 === 0,
        }),
      });
    }

    expect(project()).toBe('/repo');
    // One evaluation: the emits left `workspace` equal, so the dependent never
    // went dirty and never recomputed.
    expect(runs).toBe(1);
  });
});

/**
 * Bot mode is this frontend's own state, fed by four host messages and driven by
 * nine client frames. The frames are asserted whole, character for character
 * against `@morse/protocol`'s `wire/client.ts`, because the host routes by
 * `type` and reads `payload` field by field.
 */
describe('MorseService bot mode', () => {
  afterEach(() => TestBed.resetTestingModule());

  function mount(transport: ScriptedTransport) {
    TestBed.configureTestingModule({
      providers: [{ provide: MORSE_TRANSPORT, useValue: transport }],
    });
    return TestBed.inject(MorseService);
  }

  /** The frame a call just sent; the client's own handshake is the first one. */
  function lastFrame(transport: ScriptedTransport): unknown {
    return transport.sent[transport.sent.length - 1];
  }

  const summary = { name: 'forge', description: 'keeps the forge hot', engineKind: 'pi', warm: true };
  const dm = {
    id: 'dm-forge',
    kind: 'dm' as const,
    title: 'Forge',
    members: ['forge'],
    chainCap: 8,
    updatedAt: 1_700_000_000_000,
  };

  it('lists the bots on request', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);

    morse.listBots();

    expect(lastFrame(transport)).toEqual({ type: 'bot/list', payload: {} });
  });

  it('records the roster the host pushes', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);

    transport.toClient({ type: 'bot/roster', payload: { bots: [summary], conversations: [dm] } });

    expect(morse.bot.roster()).toEqual({ bots: [summary], conversations: [dm] });
  });

  it('replaces a conversation transcript when the host says replace', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    const stale = { id: 'old', author: { role: 'user' as const }, text: 'stale', at: 1 };

    transport.toClient({
      type: 'bot/transcript',
      payload: { conversationId: 'dm-forge', entries: [stale], replace: true },
    });
    const fresh = { id: 'a', author: { role: 'bot' as const, name: 'forge' }, text: 'hi', at: 2 };
    transport.toClient({
      type: 'bot/transcript',
      payload: { conversationId: 'dm-forge', entries: [fresh], replace: true },
    });

    expect(morse.bot.transcripts()['dm-forge']).toEqual([fresh]);
  });

  it('appends entries the host sends without replace', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);

    transport.toClient({
      type: 'bot/transcript',
      payload: {
        conversationId: 'dm-forge',
        entries: [{ id: 'a', author: { role: 'user' }, text: 'hello', at: 1 }],
        replace: true,
      },
    });
    transport.toClient({
      type: 'bot/transcript',
      payload: {
        conversationId: 'dm-forge',
        entries: [{ id: 'b', author: { role: 'bot', name: 'forge' }, text: 'hi', at: 2 }],
        replace: false,
      },
    });

    expect(morse.bot.transcripts()['dm-forge']).toEqual([
      { id: 'a', author: { role: 'user' }, text: 'hello', at: 1 },
      { id: 'b', author: { role: 'bot', name: 'forge' }, text: 'hi', at: 2 },
    ]);
  });

  it('sets and clears the routing state from bot/routing', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    const route = { conversationId: 'group-1', target: 'forge', queued: ['sable'] };

    transport.toClient({ type: 'bot/routing', payload: { state: route } });
    expect(morse.bot.routing()).toEqual(route);

    transport.toClient({ type: 'bot/routing', payload: { state: null } });
    expect(morse.bot.routing()).toBeNull();
  });

  it('records probed models under their request id', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    const models = [{ provider: 'anthropic', id: 'claude-sonnet-4', name: 'Sonnet' }];

    transport.toClient({ type: 'bot/models', payload: { requestId: 'probe-1', kind: 'pi', models } });

    expect(morse.bot.models()['probe-1']).toEqual(models);
  });

  it('opens a conversation: active id set, routing dropped, bot/open sent', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    transport.toClient({
      type: 'bot/routing',
      payload: { state: { conversationId: 'dm-sable', target: 'sable', queued: [] } },
    });

    morse.openBotConversation('dm-forge');

    expect(morse.bot.activeId()).toBe('dm-forge');
    expect(morse.bot.routing()).toBeNull();
    expect(lastFrame(transport)).toEqual({
      type: 'bot/open',
      payload: { conversationId: 'dm-forge' },
    });
  });

  it('sends the reader line and leaves the transcript to the host', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    morse.openBotConversation('dm-forge');

    morse.sendBotMessage('hi');

    expect(lastFrame(transport)).toEqual({
      type: 'bot/send',
      payload: { conversationId: 'dm-forge', text: 'hi' },
    });
    // No local echo: the host appends the user line when it accepts the send,
    // and a second copy here is what rendered every message twice.
    expect(morse.bot.transcripts()['dm-forge']).toBeUndefined();
  });

  it('renders the host transcript after a send, once', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    morse.openBotConversation('dm-forge');
    morse.sendBotMessage('hi');

    const stored = { id: 'h1', author: { role: 'user' as const }, text: 'hi', at: 5 };
    transport.toClient({
      type: 'bot/transcript',
      payload: { conversationId: 'dm-forge', entries: [stored], replace: false },
    });

    expect(morse.bot.transcripts()['dm-forge']).toEqual([stored]);
  });

  it('sends nothing for a line with no conversation open', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    const before = transport.sent.length;

    morse.sendBotMessage('nowhere to go');

    expect(transport.sent).toHaveLength(before);
    expect(morse.bot.transcripts()).toEqual({});
  });

  it('probes models with the wizard credentials and its request id', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);

    morse.probeModels(
      'pi',
      ['ANTHROPIC_API_KEY'],
      [{ provider: 'anthropic', apiKey: 'sk-probe' }],
      'probe-1',
    );

    expect(lastFrame(transport)).toEqual({
      type: 'bot/probeModels',
      payload: {
        kind: 'pi',
        envVars: ['ANTHROPIC_API_KEY'],
        credentials: [{ provider: 'anthropic', apiKey: 'sk-probe' }],
        requestId: 'probe-1',
      },
    });
  });

  it('creates a bot with the wizard input and its request id', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    const input = {
      name: 'forge',
      description: 'keeps the forge hot',
      engineKind: 'pi',
      credentials: [{ provider: 'anthropic', apiKey: 'sk-test' }],
      envVars: ['ANTHROPIC_API_KEY'],
      persona: 'You are Forge.',
      requestId: 'create-1',
    };

    morse.createBot(input);

    expect(lastFrame(transport)).toEqual({ type: 'bot/create', payload: input });
  });

  it('deletes a bot by name', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);

    morse.deleteBot('forge');

    expect(lastFrame(transport)).toEqual({ type: 'bot/delete', payload: { name: 'forge' } });
  });

  it('creates a group with the dialog input', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    const input = { name: 'builders', members: ['forge', 'sable'], lead: 'forge' };

    morse.createGroup(input);

    expect(lastFrame(transport)).toEqual({ type: 'bot/groupCreate', payload: input });
  });

  it('stops the round in flight on the open conversation', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    morse.openBotConversation('dm-forge');

    morse.stopBotRound();

    expect(lastFrame(transport)).toEqual({
      type: 'bot/stop',
      payload: { conversationId: 'dm-forge' },
    });
  });

  it('starts a fresh discussion on the open conversation', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    morse.openBotConversation('group-1');

    morse.newBotDiscussion();

    expect(lastFrame(transport)).toEqual({
      type: 'bot/newDiscussion',
      payload: { conversationId: 'group-1' },
    });
  });

  it('sends no round controls while no conversation is open', () => {
    const transport = new ScriptedTransport();
    const morse = mount(transport);
    const before = transport.sent.length;

    morse.stopBotRound();
    morse.newBotDiscussion();

    expect(transport.sent).toHaveLength(before);
  });
});
