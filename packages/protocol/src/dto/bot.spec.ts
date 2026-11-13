import { describe, expect, it } from 'vitest';
import type { BotCreateInput } from './bot.js';
import { isClientToHostMessage, isHostToClientMessage } from '../wire.js';

/**
 * The subagent rows travel as their own field: the wizard's rows are data the
 * host writes into the bot's engine config, not prose folded into AGENTS.md.
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
      engineKind: 'pi',
      credentials: [{ provider: 'anthropic', apiKey: 'sk' }],
      envVars: ['ANTHROPIC_API_KEY'],
      persona: 'You are Forge.',
      subagents: SUBAGENTS,
    },
  },
  { type: 'bot/delete', payload: { name: 'forge' } },
  {
    type: 'bot/probeModels',
    payload: { kind: 'pi', envVars: ['ANTHROPIC_API_KEY'], requestId: 'req-2' },
  },
  { type: 'bot/open', payload: { conversationId: 'dm-forge' } },
  { type: 'bot/send', payload: { conversationId: 'dm-forge', text: 'hi' } },
  { type: 'bot/stop', payload: { conversationId: 'dm-forge' } },
  { type: 'bot/newDiscussion', payload: { conversationId: 'dm-forge' } },
  {
    type: 'bot/groupCreate',
    payload: { name: 'Launch', members: ['forge', 'scout'], lead: 'forge' },
  },
] as const;

/** Every bot message the host pushes, with the payload it pushes. */
const HOST_BOT_MESSAGES = [
  { type: 'bot/roster', payload: { bots: [], conversations: [] } },
  {
    type: 'bot/transcript',
    payload: { conversationId: 'dm-forge', entries: [], replace: true },
  },
  { type: 'bot/routing', payload: { state: null } },
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

  it('rejects an unknown bot message type in both directions', () => {
    expect(isClientToHostMessage({ type: 'bot/nope', payload: {} })).toBe(false);
    expect(isHostToClientMessage({ type: 'bot/nope', payload: {} })).toBe(false);
  });
});
