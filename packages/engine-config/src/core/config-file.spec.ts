import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonConfigFile } from './config-file.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-config-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('JsonConfigFile', () => {
  it('refuses to write JSONC without normalize and writes strict JSON with it', () => {
    const dir = root();
    const path = join(dir, 'opencode.json');
    writeFileSync(path, '{\n  // keep?\n  "a": 1,\n}\n');
    const file = new JsonConfigFile(path, 'config', 'global', { ownership: 'user' });

    const refused = file.write({ a: 2 });
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({ code: 'normalize', fixable: true });
    expect(readFileSync(path, 'utf8')).toContain('// keep?');

    const fixed = file.normalize();
    expect(fixed.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
    expect(readFileSync(path, 'utf8')).not.toContain('// keep?');
  });

  it('writes isolated files 0600 inside a 0700 directory, atomically', () => {
    const dir = root();
    const path = join(dir, 'config', 'mcp.json');
    const file = new JsonConfigFile(path, 'mcp', 'global', { ownership: 'isolated' });
    expect(file.write({ mcpServers: {} }).ok).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'config')).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('writes through a symlinked config instead of replacing the link', () => {
    const dir = root();
    const dotfiles = join(dir, 'dotfiles');
    const config = join(dir, 'config');
    mkdirSync(dotfiles, { recursive: true });
    mkdirSync(config, { recursive: true });
    const target = join(dotfiles, 'mcp.json');
    writeFileSync(target, '{\n  "mcpServers": {}\n}\n');
    chmodSync(target, 0o640);
    const link = join(config, 'mcp.json');
    symlinkSync(target, link);

    const file = new JsonConfigFile(link, 'mcp', 'global', { ownership: 'user' });
    expect(file.write({ mcpServers: { one: { command: 'node' } } }).ok).toBe(true);

    // The dotfiles link survives; only the file it points at changed.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({
      mcpServers: { one: { command: 'node' } },
    });
    // The target's mode is preserved across the rename.
    expect(statSync(target).mode & 0o777).toBe(0o640);
    // No temp file left behind in either directory.
    expect(readdirSync(dotfiles).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(config).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps an existing user file mode across an atomic write', () => {
    const path = join(root(), 'opencode.json');
    writeFileSync(path, '{}\n');
    chmodSync(path, 0o640);
    const file = new JsonConfigFile(path, 'config', 'global', { ownership: 'user' });

    expect(file.write({ a: 1 }).ok).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it('reports a missing file as a read without issues', () => {
    const file = new JsonConfigFile(join(root(), 'none.json'), 'mcp', 'global', {
      ownership: 'user',
    });
    expect(file.read()).toMatchObject({ exists: false, strict: true, issues: [], value: undefined });
  });

  it('reports an existing but unreadable path as a read issue instead of throwing', () => {
    const dir = root();
    const path = join(dir, 'config-dir');
    mkdirSync(path);
    const file = new JsonConfigFile(path, 'config', 'global', { ownership: 'user' });

    const read = file.read();
    expect(read.exists).toBe(true);
    expect(read.value).toBeUndefined();
    expect(read.text).toBe('');
    expect(read.strict).toBe(true);
    expect(read.issues[0]).toMatchObject({ code: 'read', fixable: false, file: path });
    expect(read.issues[0].message).toContain(path);

    const refused = file.write({ a: 1 });
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({ code: 'read', fixable: false });
  });

  it('initializes an empty file instead of refusing it', () => {
    const path = join(root(), 'empty.json');
    writeFileSync(path, '');
    const file = new JsonConfigFile(path, 'config', 'global', { ownership: 'user' });

    expect(file.read().issues).toEqual([]);
    expect(file.write({ a: 1 }).ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
  });

  it('initializes a comment-only file instead of refusing it', () => {
    const path = join(root(), 'comments.json');
    writeFileSync(path, '// todo\n');
    const file = new JsonConfigFile(path, 'config', 'global', { ownership: 'user' });

    expect(file.read().issues).toEqual([]);
    expect(file.write({ a: 1 }).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).not.toContain('// todo');
  });

  it('refuses to write genuinely corrupt content and leaves it untouched', () => {
    const path = join(root(), 'corrupt.json');
    const text = '{ "a":';
    writeFileSync(path, text);
    const file = new JsonConfigFile(path, 'config', 'global', { ownership: 'user' });

    const refused = file.write({ a: 1 });
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({ code: 'parse', fixable: false });
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('normalizes an already strict file to a byte- and signature-identical no-op', () => {
    const path = join(root(), 'strict.json');
    const text = '{\n  "a": 1\n}\n';
    writeFileSync(path, text);
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(path, past, past);
    const file = new JsonConfigFile(path, 'config', 'global', { ownership: 'user' });
    const signature = file.signature();

    expect(file.normalize()).toMatchObject({ ok: true, issues: [] });
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(file.signature()).toBe(signature);
  });
});
