import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProjectTrust, writeProjectTrust } from './project-trust.js';

/**
 * Project trust is pi's own decision store (`<agentDir>/trust.json`). Read it
 * the way pi resolves it (a parent folder covers its children) and write it the
 * way pi's prompt does, so the panel can answer the prompt instead of sending
 * the reader to a terminal.
 */

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'morse-trust-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('project trust', () => {
  it('writes a decision pi can read back, and reads it again', () => {
    const agentDir = tempDir();
    const project = tempDir();

    expect(readProjectTrust(project, agentDir)).toBe(false);
    const result = writeProjectTrust(project, agentDir);
    expect(result.ok).toBe(true);
    expect(readProjectTrust(project, agentDir)).toBe(true);

    const stored = JSON.parse(readFileSync(result.path, 'utf8')) as Record<string, boolean>;
    expect(Object.values(stored)).toEqual([true]);
  });

  it('lets a trusted parent folder cover its children, exactly like pi', () => {
    const agentDir = tempDir();
    const parent = tempDir();
    const child = join(parent, 'packages', 'app');

    writeProjectTrust(parent, agentDir);

    expect(readProjectTrust(child, agentDir)).toBe(true);
  });

  it('preserves other decisions and sorts the file', () => {
    const agentDir = tempDir();
    const first = tempDir();
    const second = tempDir();

    writeProjectTrust(first, agentDir);
    const result = writeProjectTrust(second, agentDir);

    const stored = JSON.parse(readFileSync(result.path, 'utf8')) as Record<string, boolean>;
    expect(Object.values(stored)).toEqual([true, true]);
    expect(readProjectTrust(first, agentDir)).toBe(true);
    expect(readProjectTrust(second, agentDir)).toBe(true);
  });
});
