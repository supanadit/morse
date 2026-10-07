import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LANGUAGE_SERVERS,
  languageIdForPath,
  resolveServerCommand,
  searchPath,
  serverForLanguage,
} from './language-servers';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'morse-lsp-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fake executable in the project's `node_modules/.bin`, like a pinned server. */
function localBin(name: string): string {
  const dir = join(root, 'node_modules', '.bin');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return path;
}

const TS = LANGUAGE_SERVERS[0];

describe('language ids', () => {
  it('maps the extensions an editor would', () => {
    expect(languageIdForPath('src/a.ts')).toBe('typescript');
    expect(languageIdForPath('src/a.tsx')).toBe('typescriptreact');
    expect(languageIdForPath('src/a.mjs')).toBe('javascript');
    expect(languageIdForPath('a/b/c.yml')).toBe('yaml');
    expect(languageIdForPath('Dockerfile')).toBeUndefined();
    expect(languageIdForPath('notes.txt')).toBeUndefined();
    expect(languageIdForPath('.gitignore')).toBeUndefined();
  });

  it('finds the server that answers for a language', () => {
    expect(serverForLanguage('typescript')?.command).toBe('typescript-language-server');
    expect(serverForLanguage('yaml')?.command).toBe('yaml-language-server');
    expect(serverForLanguage('cobol')).toBeUndefined();
  });
});

describe('resolving a language server', () => {
  it('prefers an explicit override over everything else', async () => {
    const pinned = localBin('typescript-language-server');
    const resolved = await resolveServerCommand(TS, root, {
      MORSE_LSP_TS: '/opt/ts-ls',
      PATH: '',
    });
    expect(resolved).toEqual({ command: '/opt/ts-ls', args: ['--stdio'], via: 'MORSE_LSP_TS' });
    expect(pinned).not.toBe(resolved?.command);
  });

  it('prefers the project’s own pinned server over PATH', async () => {
    const pinned = localBin('typescript-language-server');
    const resolved = await resolveServerCommand(TS, root, { PATH: '' });
    expect(resolved?.command).toBe(pinned);
    expect(resolved?.via).toContain('node_modules');
  });

  it('finds one on PATH when the project has none', async () => {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const onPath = join(bin, 'typescript-language-server');
    writeFileSync(onPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const resolved = await resolveServerCommand(TS, root, { PATH: bin });
    expect(resolved?.command).toBe(onPath);
    expect(resolved?.via).toBe('PATH');
  });

  it('falls back to npx so a host with nothing installed still works', async () => {
    const resolved = await resolveServerCommand(TS, root, { PATH: '' });
    expect(resolved).toEqual({
      command: 'npx',
      args: ['-y', 'typescript-language-server', '--stdio'],
      via: 'npx (typescript-language-server)',
    });
  });

  it('ignores a path entry that is not executable', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gopls'), 'not executable', { mode: 0o644 });
    expect(searchPath('gopls', { PATH: bin })).toBeUndefined();
  });

  it('keeps the environment variable names distinct per server', () => {
    const keys = LANGUAGE_SERVERS.map((server) => server.envKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key.startsWith('MORSE_LSP_')).toBe(true);
    }
  });
});
