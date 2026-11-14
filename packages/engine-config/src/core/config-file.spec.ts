import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  it('reports a missing file as a read without issues', () => {
    const file = new JsonConfigFile(join(root(), 'none.json'), 'mcp', 'global', {
      ownership: 'user',
    });
    expect(file.read()).toMatchObject({ exists: false, strict: true, issues: [], value: undefined });
  });
});
