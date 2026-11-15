import { describe, expect, it } from 'vitest';
import { titleForReport, UNTITLED_SESSION } from './record.js';

/**
 * Which name a session row carries after an engine report. A title the reader
 * typed is theirs; everything else follows the engine, falling back to what the
 * row already had when the engine names nothing.
 */
describe('titleForReport', () => {
  it('keeps a pinned title whatever the engine reports', () => {
    expect(titleForReport({ title: 'Release prep', titlePinned: true }, 'Engine name')).toBe(
      'Release prep',
    );
  });

  it('takes the engine title when the title is not pinned', () => {
    expect(titleForReport({ title: UNTITLED_SESSION }, 'Engine name')).toBe('Engine name');
  });

  it('falls back to the stored title when the engine reports none', () => {
    expect(titleForReport({ title: 'Old name' }, undefined)).toBe('Old name');
  });
});
