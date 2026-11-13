import { describe, expect, it } from 'vitest';
import { extensionOf, grammarFor, loadLanguage } from './languages';

describe('extensionOf', () => {
  it('lowercases the extension', () => expect(extensionOf('src/A.TSX')).toBe('tsx'));
  it('returns empty for a dotfile', () => expect(extensionOf('/repo/.env')).toBe(''));
  it('returns empty for an extensionless path', () => expect(extensionOf('/repo/Makefile')).toBe(''));
  it('reads the last dot only', () => expect(extensionOf('a.test.ts')).toBe('ts'));
});

describe('grammarFor', () => {
  it('maps a known extension', () => expect(grammarFor('a.rs')).not.toBeNull());
  it('returns null for an unknown one', () => expect(grammarFor('a.txt')).toBeNull());
  it('returns null for a dotfile', () => expect(grammarFor('.env')).toBeNull());
});

describe('loadLanguage', () => {
  it('resolves a language for a mapped path', async () => {
    expect(await loadLanguage('a.py')).not.toBeNull();
  });
  it('resolves null for an unmapped path', async () => {
    expect(await loadLanguage('a.txt')).toBeNull();
  });
  it('resolves null when the loader rejects (Review Focus 1)', async () => {
    expect(await loadLanguage('a.rs', () => Promise.reject(new Error('offline')))).toBeNull();
  });
});
