import { describe, expect, it } from 'vitest';
import { elapsedLabel, revealLength, rowIsQuiet } from './reveal';

describe('revealLength', () => {
  it('never runs past the text and stops on a word', () => {
    const text = 'Tally is the one that survives being said out loud';
    const next = revealLength(0, text);
    expect(next).toBeLessThanOrEqual(text.length);
    expect(next === text.length || text[next - 1] === ' ').toBe(true);
  });

  it('keeps moving when a burst arrives at once', () => {
    expect(revealLength(0, 'a '.repeat(500))).toBeGreaterThan(24);
  });

  it('never goes backwards, and keeps moving through one long word', () => {
    const word = 'uninterruptedwordwithoutaspace';
    expect(revealLength(7, word)).toBeGreaterThan(7);
    expect(revealLength(0, word)).toBeLessThanOrEqual(word.length);
  });

  it('stops at the end, and goes no further once there', () => {
    const text = 'all of this is already here';
    expect(revealLength(text.length - 2, text)).toBe(text.length);
    expect(revealLength(text.length, text)).toBe(text.length);
    expect(revealLength(text.length + 10, text)).toBe(text.length);
  });

  it('never steps back below what is already shown', () => {
    const text = 'one word follows another word here';
    const shown = 9;
    expect(revealLength(shown, text)).toBeGreaterThanOrEqual(shown);
  });
});

describe('elapsedLabel', () => {
  it('hides a young timer and counts in minutes after one', () => {
    expect(elapsedLabel(4_900)).toBeUndefined();
    expect(elapsedLabel(38_000)).toBe('38s');
    expect(elapsedLabel(125_000)).toBe('2m 05s');
  });

  it('counts a whole minute as a minute and a second', () => {
    expect(elapsedLabel(5_000)).toBe('5s');
    expect(elapsedLabel(60_000)).toBe('1m 00s');
    expect(elapsedLabel(3_600_000)).toBe('60m 00s');
  });
});

describe('rowIsQuiet', () => {
  it('calls a row quiet after twenty seconds, but never with a tool running', () => {
    expect(rowIsQuiet(20_000, 1_000, false)).toBe(false);
    expect(rowIsQuiet(21_000, 1_000, false)).toBe(true);
    expect(rowIsQuiet(120_000, 1_000, true)).toBe(false);
  });

  it('is quiet exactly twenty seconds after the newest step', () => {
    expect(rowIsQuiet(1_000 + 19_999, 1_000, false)).toBe(false);
    expect(rowIsQuiet(1_000 + 20_000, 1_000, false)).toBe(true);
  });
});
