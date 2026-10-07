import { describe, expect, it } from 'vitest';
import { asDiagnostics, asHover, asLocation, asPosition, asRange, asReferences } from './lsp';

const RANGE = {
  start: { line: 1, character: 2 },
  end: { line: 1, character: 8 },
};

describe('reading an LSP answer off the wire', () => {
  it('accepts a position and a range only with integer coordinates', () => {
    expect(asPosition({ line: 0, character: 0 })).toEqual({ line: 0, character: 0 });
    expect(asPosition({ line: 0.5, character: 0 })).toBeUndefined();
    expect(asPosition({ line: '1', character: 0 })).toBeUndefined();
    expect(asPosition(null)).toBeUndefined();
    expect(asRange(RANGE)).toEqual(RANGE);
    expect(asRange({ start: RANGE.start })).toBeUndefined();
  });

  it('keeps a hover with contents and drops an empty one', () => {
    expect(asHover({ contents: 'const x: number' })).toEqual({ contents: 'const x: number' });
    expect(asHover({ contents: 'x', range: RANGE })).toEqual({ contents: 'x', range: RANGE });
    expect(asHover({ contents: '   ' })).toBeUndefined();
    expect(asHover({ contents: 42 })).toBeUndefined();
    expect(asHover(undefined)).toBeUndefined();
  });

  it('reads a definition target, refusing one with no file or range', () => {
    // A definition answer is a location: the file and the range inside it.
    expect(asLocation({ path: 'src/a.ts', range: RANGE })).toEqual({ path: 'src/a.ts', range: RANGE });
    expect(asLocation({ path: 'src/a.ts' })).toBeUndefined();
    expect(asLocation({ range: RANGE })).toBeUndefined();
    expect(asLocation({ path: '', range: RANGE })).toBeUndefined();
  });

  it('reads references, dropping locations that are not ones', () => {
    const references = asReferences({
      path: 'src/a.ts',
      locations: [
        { path: 'src/a.ts', range: RANGE },
        { path: 'src/b.ts' },
        null,
        { path: '', range: RANGE },
      ],
    });
    expect(references).toEqual({ path: 'src/a.ts', locations: [{ path: 'src/a.ts', range: RANGE }] });
  });

  it('keeps `available: false` distinct from an empty problem list', () => {
    const clean = asDiagnostics({ path: 'a.ts', available: true, diagnostics: [] });
    expect(clean).toEqual({ path: 'a.ts', available: true, diagnostics: [] });
    const uncovered = asDiagnostics({ path: 'a.ts', available: false, diagnostics: [] });
    expect(uncovered?.available).toBe(false);
    // A host that said nothing about availability is not claiming coverage.
    expect(asDiagnostics({ path: 'a.ts' })?.available).toBe(false);
  });

  it('maps a problem, defaulting an unknown severity to the mildest', () => {
    const diagnostics = asDiagnostics({
      path: 'a.ts',
      available: true,
      diagnostics: [
        { range: RANGE, severity: 'error', message: 'boom', source: 'typescript', code: '2322' },
        { range: RANGE, severity: 'nonsense', message: 'hm' },
        { message: 'no range' },
      ],
    });
    expect(diagnostics?.diagnostics).toEqual([
      { range: RANGE, severity: 'error', message: 'boom', source: 'typescript', code: '2322' },
      { range: RANGE, severity: 'information', message: 'hm' },
    ]);
  });

  it('answers undefined for anything that is not an object', () => {
    for (const value of [undefined, null, 'hover', 7, []]) {
      expect(asHover(value)).toBeUndefined();
      expect(asLocation(value)).toBeUndefined();
      expect(asReferences(value)).toBeUndefined();
      expect(asDiagnostics(value)).toBeUndefined();
    }
  });
});
