import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitIdentityFor, saveGitIdentity } from './git-identity.js';

describe('git-identity', () => {
  let gitHome = '';

  beforeEach(() => {
    // An isolated global config: HOME override keeps the real ~/.gitconfig out.
    gitHome = mkdtempSync(join(tmpdir(), 'morse-git-home-'));
  });

  afterEach(() => {
    rmSync(gitHome, { recursive: true, force: true });
  });

  it('reads empty when nothing is set', () => {
    expect(gitIdentityFor(gitHome, 'bob')).toMatchObject({ username: 'bob', name: '', email: '' });
  });

  it('round-trips name and email, and unsets on empty', () => {
    saveGitIdentity(gitHome, 'bob', { name: 'Bob', email: 'bob@example.com' });
    expect(gitIdentityFor(gitHome, 'bob')).toMatchObject({ name: 'Bob', email: 'bob@example.com' });
    saveGitIdentity(gitHome, 'bob', { name: '' });
    expect(gitIdentityFor(gitHome, 'bob').name).toBe('');
  });

  it('refuses unknown fields and bad tri-states', () => {
    expect(() => saveGitIdentity(gitHome, 'bob', { 'credential.helper': 'store' } as never)).toThrow(/Unknown git setting/);
    expect(() => saveGitIdentity(gitHome, 'bob', { pullRebase: 'maybe' })).toThrow(/true, false, or empty/);
  });

  it('accepts tri-state booleans', () => {
    saveGitIdentity(gitHome, 'bob', { pullRebase: 'true', autoSetupRemote: 'true', gpgSign: 'false' });
    expect(gitIdentityFor(gitHome, 'bob')).toMatchObject({ pullRebase: 'true', autoSetupRemote: 'true', gpgSign: 'false' });
  });
});
