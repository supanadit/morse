import { describe, expect, it } from 'vitest';
import { mentionTokens, parseMentions } from './mentions.js';

/**
 * Mention parsing is syntax only: it maps `@handle` text onto the conversation's
 * member names. Who is *allowed* to address whom (a bot may not relay to itself)
 * is a routing decision and is tested with the service.
 */
describe('parseMentions', () => {
  const members = ['Forge', 'Sable', 'Moss'];

  it('returns mentioned members in order of appearance', () => {
    expect(parseMentions('@Sable take this, then @Forge reviews', members)).toEqual({
      targets: ['Sable', 'Forge'],
      all: false,
    });
  });

  it('matches mentions case-insensitively and answers with the stored casing', () => {
    expect(parseMentions('hey @sABLE', members)).toEqual({ targets: ['Sable'], all: false });
  });

  it('reports @all as a broadcast', () => {
    expect(parseMentions('@all standup', members)).toEqual({ targets: [], all: true });
  });

  it('reports @everyone as a broadcast', () => {
    expect(parseMentions('@everyone standup', members)).toEqual({ targets: [], all: true });
  });

  it('ignores names that are not members', () => {
    expect(parseMentions('@nobody @Forge hi', members)).toEqual({
      targets: ['Forge'],
      all: false,
    });
  });

  it('lists a member once however often it is mentioned', () => {
    expect(parseMentions('@Forge @forge @FORGE', members)).toEqual({
      targets: ['Forge'],
      all: false,
    });
  });

  it('does not treat a longer name as a mention of a shorter member', () => {
    expect(parseMentions('@ForgeTwo ping', ['Forge'])).toEqual({ targets: [], all: false });
  });

  it('finds no mention in plain text', () => {
    expect(parseMentions('ship it', members)).toEqual({ targets: [], all: false });
  });

  it('exposes the raw handles so the router can report the ones it ignores', () => {
    expect(mentionTokens('@nobody @Forge, mail me at a@b.com')).toEqual(['nobody', 'Forge']);
  });
});
