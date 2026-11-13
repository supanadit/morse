import type {
  BotConversationSummary,
  BotSummary,
  BotTranscriptEntry,
  ModelOption,
} from '@morse/protocol';
import { describe, expect, it } from 'vitest';
import { BotState } from './bot-state';

function bot(name: string, overrides: Partial<BotSummary> = {}): BotSummary {
  return { name, description: `${name} keeps the forge hot`, engineKind: 'pi', warm: false, ...overrides };
}

function conversation(
  id: string,
  overrides: Partial<BotConversationSummary> = {},
): BotConversationSummary {
  return { id, kind: 'dm', title: id, members: [], chainCap: 8, updatedAt: 0, ...overrides };
}

function line(id: string, text: string, at = 1_700_000_000_000): BotTranscriptEntry {
  return { id, author: { role: 'user' }, text, at };
}

const model: ModelOption = { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Sonnet' };

describe('BotState', () => {
  it('records the roster the host pushes, replacing the previous one', () => {
    const state = new BotState();
    expect(state.roster()).toBeNull();

    state.onRoster({ bots: [bot('forge')], conversations: [conversation('dm-forge')] });
    expect(state.roster()).toEqual({
      bots: [bot('forge')],
      conversations: [conversation('dm-forge')],
    });

    state.onRoster({ bots: [bot('sable')], conversations: [] });
    expect(state.roster()).toEqual({ bots: [bot('sable')], conversations: [] });
  });

  it('forgets the open conversation when a pushed roster drops it', () => {
    const state = new BotState();
    state.onRoster({ bots: [bot('forge')], conversations: [conversation('dm-forge')] });
    state.open('dm-forge');
    state.onTranscript({ conversationId: 'dm-forge', entries: [line('a', 'hi')], replace: true });
    state.onRouting({ conversationId: 'dm-forge', target: 'forge', queued: [] });

    // The bot was deleted: its conversation is gone from the roster, so the
    // workspace must not keep pointing at it — a prompt typed now would be sent
    // to a conversation the host no longer has.
    state.onRoster({ bots: [], conversations: [] });

    expect(state.activeId()).toBeNull();
    expect(state.transcripts()['dm-forge']).toBeUndefined();
    expect(state.routing()).toBeNull();
  });

  it('keeps the open conversation when a pushed roster still lists it', () => {
    const state = new BotState();
    state.onRoster({ bots: [bot('forge')], conversations: [conversation('dm-forge')] });
    state.open('dm-forge');
    state.onTranscript({ conversationId: 'dm-forge', entries: [line('a', 'hi')], replace: true });

    // A rename or a new conversation elsewhere replaces the roster whole; the one
    // in front is still there, so the workspace stays on it.
    state.onRoster({
      bots: [bot('forge'), bot('sable')],
      conversations: [conversation('dm-forge', { updatedAt: 5 }), conversation('dm-sable')],
    });

    expect(state.activeId()).toBe('dm-forge');
    expect(state.transcripts()['dm-forge']).toEqual([line('a', 'hi')]);
  });

  it('resets one conversation when the host says replace', () => {
    const state = new BotState();
    state.onTranscript({
      conversationId: 'dm-forge',
      entries: [line('stale-1', 'from the last session')],
      replace: true,
    });

    state.onTranscript({
      conversationId: 'dm-forge',
      entries: [line('a', 'hello'), line('b', 'hi')],
      replace: true,
    });

    expect(state.transcripts()['dm-forge']).toEqual([line('a', 'hello'), line('b', 'hi')]);
  });

  it('appends when the host sends entries alone', () => {
    const state = new BotState();
    state.onTranscript({ conversationId: 'dm-forge', entries: [line('a', 'hello')], replace: true });

    state.onTranscript({ conversationId: 'dm-forge', entries: [line('b', 'hi')], replace: false });

    expect(state.transcripts()['dm-forge']).toEqual([line('a', 'hello'), line('b', 'hi')]);
  });

  it('keeps each conversation transcript separate', () => {
    const state = new BotState();
    state.onTranscript({ conversationId: 'dm-forge', entries: [line('a', 'forge')], replace: true });
    state.onTranscript({ conversationId: 'group-1', entries: [line('b', 'group')], replace: true });

    // A replace on one conversation never touches another.
    state.onTranscript({ conversationId: 'group-1', entries: [], replace: true });

    expect(state.transcripts()['dm-forge']).toEqual([line('a', 'forge')]);
    expect(state.transcripts()['group-1']).toEqual([]);
  });

  it('resets one conversation transcript and leaves the rest', () => {
    const state = new BotState();
    state.onTranscript({ conversationId: 'dm-forge', entries: [line('a', 'kept')], replace: true });
    state.onTranscript({ conversationId: 'dm-sable', entries: [line('b', 'gone')], replace: true });

    state.resetTranscript('dm-sable');

    expect(state.transcripts()['dm-forge']).toEqual([line('a', 'kept')]);
    expect(state.transcripts()['dm-sable']).toEqual([]);
  });

  it('sets and clears the routing state', () => {
    const state = new BotState();
    const route = { conversationId: 'group-1', target: 'forge', queued: ['sable'] };

    state.onRouting(route);
    expect(state.routing()).toEqual(route);

    state.onRouting(null);
    expect(state.routing()).toBeNull();
  });

  it('opens a conversation and drops the previous round', () => {
    const state = new BotState();
    state.onRouting({ conversationId: 'dm-sable', target: 'sable', queued: [] });
    state.onTranscript({ conversationId: 'dm-forge', entries: [line('a', 'hi')], replace: true });

    state.open('dm-forge');

    expect(state.activeId()).toBe('dm-forge');
    expect(state.routing()).toBeNull();
    // Opening reads what is held; the host's replace reconciles it.
    expect(state.transcripts()['dm-forge']).toEqual([line('a', 'hi')]);
  });

  it('appends a local line to the open conversation', () => {
    const state = new BotState();
    state.open('dm-forge');

    state.appendLocal(line('local-1', 'hi', 42));

    expect(state.transcripts()['dm-forge']).toEqual([line('local-1', 'hi', 42)]);
  });

  it('ignores a local line when no conversation is open', () => {
    const state = new BotState();

    state.appendLocal(line('local-1', 'nowhere'));

    expect(state.transcripts()).toEqual({});
  });

  it('records probed models per request, keeping earlier answers', () => {
    const state = new BotState();

    state.onModels({ requestId: 'probe-1', kind: 'pi', models: [model] });
    state.onModels({ requestId: 'probe-2', kind: 'opencode', models: [] });

    expect(state.models()['probe-1']).toEqual([model]);
    expect(state.models()['probe-2']).toEqual([]);
  });
});
