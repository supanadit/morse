import { describe, expect, it } from 'vitest';
import type {
  BotActivity,
  BotCreateInput,
  BotRoutingActive,
  BotTranscriptEntry,
} from './bot.js';
import type { ClientToHostMessage } from '../wire.js';
import { isClientToHostMessage, isHostToClientMessage } from '../wire.js';

/**
 * The subagent rows travel as their own field: the wizard's rows are data the
 * host writes into the bot's engine config, not prose folded into AGENTS.md.
 * They are an OpenCode feature, so both fixtures below create an OpenCode bot.
 * Annotating the input is the type-level half of this test; the wire assertions
 * below are the runtime half.
 */
const SUBAGENTS: NonNullable<BotCreateInput['subagents']> = [
  { name: 'reviewer', prompt: 'Read the diff and report risks.' },
];

/**
 * Every bot message the client sends, with the payload it sends. The type guards
 * read `wire.ts`'s type lists, so a message missing from its list is silently
 * dropped — this test is what keeps each one on the list.
 */
const CLIENT_BOT_MESSAGES = [
  { type: 'bot/list', payload: {} },
  {
    type: 'bot/create',
    payload: {
      requestId: 'req-1',
      name: 'forge',
      description: 'Builds things',
      engineKind: 'opencode',
      credentials: [{ provider: 'anthropic', apiKey: 'sk' }],
      envVars: ['ANTHROPIC_API_KEY'],
      persona: 'You are Forge.',
      subagents: SUBAGENTS,
    },
  },
  { type: 'bot/delete', payload: { name: 'forge' } },
  {
    type: 'bot/probeModels',
    payload: {
      kind: 'pi',
      envVars: ['ANTHROPIC_API_KEY'],
      credentials: [{ provider: 'anthropic', apiKey: 'sk' }],
      requestId: 'req-2',
    },
  },
  { type: 'bot/open', payload: { conversationId: 'dm-forge' } },
  { type: 'bot/send', payload: { conversationId: 'dm-forge', text: 'hi' } },
  { type: 'bot/stop', payload: { conversationId: 'dm-forge' } },
  // A per-bot stop names a handle, not a display name: the host reads it as a
  // username and leaves every other bot in the room running.
  { type: 'bot/stop', payload: { conversationId: 'group-launch', username: 'sigil' } },
  { type: 'bot/newDiscussion', payload: { conversationId: 'dm-forge' } },
  { type: 'bot/clear', payload: { conversationId: 'dm-forge' } },
  { type: 'bot/compact', payload: { conversationId: 'dm-forge' } },
  {
    type: 'bot/groupCreate',
    payload: { name: 'Launch', members: ['forge', 'scout'], lead: 'forge' },
  },
  {
    type: 'bot/groupUpdate',
    payload: {
      id: 'grp-launch-ab12',
      name: 'Launch, revised',
      members: ['forge', 'scout'],
      lead: 'scout',
    },
  },
  { type: 'bot/groupDelete', payload: { id: 'grp-launch-ab12' } },
] as const;

/** Every bot message the host pushes, with the payload it pushes. */
const HOST_BOT_MESSAGES = [
  { type: 'bot/roster', payload: { bots: [], conversations: [] } },
  {
    type: 'bot/transcript',
    payload: { conversationId: 'dm-forge', entries: [], replace: true },
  },
  { type: 'bot/routing', payload: { conversationId: 'dm-forge', state: null } },
  {
    type: 'bot/usage',
    payload: {
      conversationId: 'dm-forge',
      username: 'forge',
      bot: 'Forge',
      contextUsage: { tokens: 21_000, contextWindow: 200_000, percent: 10.5 },
    },
  },
  { type: 'bot/models', payload: { requestId: 'req-2', kind: 'pi', models: [] } },
] as const;

describe('bot wire messages', () => {
  it('accepts every bot message the client sends', () => {
    for (const message of CLIENT_BOT_MESSAGES) {
      expect(isClientToHostMessage(message)).toBe(true);
    }
  });

  it('accepts every bot message the host pushes', () => {
    for (const message of HOST_BOT_MESSAGES) {
      expect(isHostToClientMessage(message)).toBe(true);
    }
  });

  it('carries the subagent rows on bot/create untouched', () => {
    const message = {
      type: 'bot/create',
      payload: {
        requestId: 'req-1',
        name: 'forge',
        description: 'Builds things',
        engineKind: 'opencode',
        credentials: [],
        envVars: [],
        persona: '',
        subagents: SUBAGENTS,
      },
    };

    expect(isClientToHostMessage(message)).toBe(true);
    expect(message.payload.subagents).toEqual(SUBAGENTS);
  });

  it('carries the wizard credentials on bot/probeModels', () => {
    const message = {
      type: 'bot/probeModels',
      payload: {
        kind: 'opencode',
        envVars: [],
        credentials: [{ provider: 'anthropic', apiKey: 'sk-probe' }],
        requestId: 'req-2',
      },
    };

    expect(isClientToHostMessage(message)).toBe(true);
    expect(message.payload.credentials).toEqual([{ provider: 'anthropic', apiKey: 'sk-probe' }]);
  });

  it('carries the optional bot handle on a per-bot stop', () => {
    const message: ClientToHostMessage = {
      type: 'bot/stop',
      payload: { conversationId: 'group-launch', username: 'sigil' },
    };

    // The handle is what the host stops; a display name could repeat in a room.
    expect(isClientToHostMessage(message)).toBe(true);
    expect(message.payload.username).toBe('sigil');
  });

  it('rejects an unknown bot message type in both directions', () => {
    expect(isClientToHostMessage({ type: 'bot/nope', payload: {} })).toBe(false);
    expect(isHostToClientMessage({ type: 'bot/nope', payload: {} })).toBe(false);
  });
});

/**
 * A working bot's row shows the steps it took, the asks it handed to peers and
 * the answer it is writing. Nothing here runs a host; the annotations keep a
 * later task from changing a field the row already draws.
 */
describe('bot work rows', () => {
  it('names a tool step that failed', () => {
    const step: BotActivity = {
      kind: 'tool',
      label: 'Running npm test',
      tool: 'bash',
      at: 1,
      status: 'error',
      error: 'exit 1',
      durationMs: 1_200,
    };
    expect(step.status).toBe('error');
  });

  it('draws a live row from a turn record', () => {
    const row: BotRoutingActive = {
      target: 'Sigil',
      username: 'sigil',
      startedAt: 10,
      steps: [
        { kind: 'starting', label: 'Getting started…', at: 10 },
        { kind: 'writing', label: 'Writing the answer…', at: 12 },
      ],
      handoffs: [
        {
          username: 'loom',
          conversationId: 'thread-loom-sigil',
          deliveryId: 'd1',
          at: 11,
          state: 'working',
        },
      ],
      partial: 'Tally is',
      activity: { kind: 'writing', label: 'Writing the answer…', at: 12 },
    };
    expect(row.handoffs[0]?.state).toBe('working');
  });
});

/**
 * A person's transcript line gained the host's identity so the bus can tell who
 * asked. It is optional on purpose: every line written before the bus exists
 * carries only `{ role: 'user' }`, and those lines still read as the host person.
 */
describe('bot transcript authors', () => {
  it('lets an old transcript line carry no person identity', () => {
    const old: BotTranscriptEntry = {
      id: 'e1',
      author: { role: 'user' },
      text: 'hi',
      at: 1,
    };
    const next: BotTranscriptEntry = {
      id: 'e2',
      author: { role: 'user', personId: 'host', name: 'Adit' },
      text: 'hi',
      at: 2,
    };

    expect(old.author.role).toBe('user');
    expect(next.author).toMatchObject({ personId: 'host' });
  });
});
