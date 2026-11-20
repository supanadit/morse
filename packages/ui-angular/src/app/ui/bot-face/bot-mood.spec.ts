import { describe, expect, it } from 'vitest';
import { moodForBot } from './bot-mood';

describe('moodForBot', () => {
  it('lets a failure outrank everything, including an answer still arriving', () => {
    expect(
      moodForBot({ failed: true, streaming: true, warm: true, description: 'drafts posts' }),
    ).toBe('failed');
  });

  it('reads a round in flight as thinking, and a warm engine as working', () => {
    expect(moodForBot({ streaming: true, warm: true })).toBe('thinking');
    expect(moodForBot({ warm: true })).toBe('working');
  });

  it('gives a quiet bot the face its own description earned', () => {
    expect(moodForBot({ description: 'Sigil Crafts bot names & identities' })).toBe('idle');
    expect(moodForBot({ description: 'Refactor the parser and run the tests' })).toBe('working');
    expect(moodForBot({ description: 'Review diffs, compare options, audit logs' })).toBe(
      'thinking',
    );
    expect(moodForBot({ description: 'Watch uptime and alert on-call' })).toBe('waiting');
    expect(moodForBot({ description: 'Draft replies and brainstorm ideas' })).toBe('excited');
  });

  it('rests a bot with nothing to say', () => {
    expect(moodForBot({})).toBe('idle');
    expect(moodForBot({ description: '   ' })).toBe('idle');
  });

  it('never lets a blurb outrank a live signal', () => {
    expect(moodForBot({ description: 'watch uptime and alert', warm: true })).toBe('working');
  });
});
