import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigMutation } from '@morse/engine-config';
import { silentLogger } from '@morse/system';
import { createPiRpcAdapter } from './create-pi-rpc-adapter.js';

/**
 * The host's Fix action on pi's own files: one comment-bearing `mcp.json` is
 * rewritten as strict JSON, and nothing outside the paths pi resolves for that
 * file id, scope and directory is touched. A fix is a repair, not a file editor.
 */
describe('pi config fix', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-fix-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The adapter with `root` as its isolated (or user) agent directory. */
  function adapter() {
    return createPiRpcAdapter(
      { env: { ...process.env, PI_CODING_AGENT_DIR: root } },
      silentLogger,
    );
  }

  function jsonc(path: string): void {
    writeFileSync(path, '{\n  // kept by the reader, dropped by a fix\n  "mcpServers": {}\n}\n');
  }

  it('rewrites the global mcp.json as strict JSON', async () => {
    const file = join(root, 'mcp.json');
    jsonc(file);

    const result = (await adapter().extras?.fix?.({
      fileId: 'mcp',
      path: file,
      scope: 'global',
    })) as ConfigMutation;

    expect(result).toMatchObject({ ok: true, path: file, scope: 'global' });
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('//');
    expect(JSON.parse(text)).toEqual({ mcpServers: {} });
  });

  it('rewrites a project .pi/mcp.json through the user tree', async () => {
    const project = join(root, 'project');
    mkdirSync(join(project, '.pi'), { recursive: true });
    const file = join(project, '.pi', 'mcp.json');
    jsonc(file);

    const result = (await adapter().extras?.fix?.({
      fileId: 'mcp',
      path: file,
      scope: 'project',
      cwd: project,
    })) as ConfigMutation;

    expect(result).toMatchObject({ ok: true, path: file, scope: 'project' });
    expect(readFileSync(file, 'utf8')).not.toContain('//');
  });

  it('refuses a path outside the paths pi resolves, without touching it', async () => {
    const file = join(root, 'settings.json');
    jsonc(file);

    const result = (await adapter().extras?.fix?.({
      fileId: 'mcp',
      path: file,
      scope: 'global',
    })) as ConfigMutation;

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not one of pi's global config paths/);
    expect(readFileSync(file, 'utf8')).toContain('//');
  });

  it('refuses a file id it cannot repair', async () => {
    const result = (await adapter().extras?.fix?.({
      fileId: 'config',
      path: join(root, 'config.json'),
      scope: 'global',
    })) as ConfigMutation;

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no fixable config file "config"/);
  });
});
