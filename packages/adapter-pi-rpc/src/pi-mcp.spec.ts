import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiMcp, parseMcpServerInput } from './pi-mcp.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'morse-mcp-'));
  roots.push(root);
  return root;
}

function readServers(path: string): Record<string, Record<string, unknown>> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  return parsed.mcpServers;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PiMcp', () => {
  it('writes a stdio server to the global file by default', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });

    const result = await mcp.add(
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        exposure: 'direct',
        description: 'Read the project files',
      },
      cwd,
    );

    expect(result.ok).toBe(true);
    expect(existsSync(join(cwd, '.pi', 'mcp.json'))).toBe(false);
    expect(readServers(join(agentDir, 'mcp.json'))['filesystem']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      exposure: 'direct',
      description: 'Read the project files',
    });
  });

  it('writes an HTTP server to the project file when asked', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });

    const result = await mcp.add(
      { name: 'docs', type: 'http', url: 'https://example.com/mcp', scope: 'project' },
      cwd,
    );

    expect(result.ok).toBe(true);
    expect(readServers(join(cwd, '.pi', 'mcp.json'))['docs']).toMatchObject({
      type: 'http',
      url: 'https://example.com/mcp',
    });
  });

  it('refuses an invalid name without writing anything', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });

    const result = await mcp.add({ name: 'bad name', command: 'npx' }, cwd);

    expect(result.ok).toBe(false);
    expect(existsSync(join(agentDir, 'mcp.json'))).toBe(false);
  });

  it('removes a project server in preference to a global one', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });
    await mcp.add({ name: 'dup', command: 'global-cmd' }, cwd);
    await mcp.add({ name: 'dup', command: 'project-cmd', scope: 'project' }, cwd);

    const result = await mcp.remove('dup', cwd);

    expect(result.ok).toBe(true);
    expect(readServers(join(agentDir, 'mcp.json'))['dup']).toBeDefined();
    expect(readServers(join(cwd, '.pi', 'mcp.json'))['dup']).toBeUndefined();
  });

  it('toggles enabled in whichever file defines the server', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });
    await mcp.add({ name: 'tools', command: 'uvx' }, cwd);

    await mcp.setEnabled('tools', false, cwd);
    expect(readServers(join(agentDir, 'mcp.json'))['tools']).toMatchObject({ enabled: false });

    await mcp.setEnabled('tools', true, cwd);
    expect(readServers(join(agentDir, 'mcp.json'))['tools']).not.toHaveProperty('enabled');
  });

  it('reports a mutation on an unknown server instead of throwing', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });

    await expect(mcp.remove('missing', cwd)).resolves.toMatchObject({ ok: false });
    await expect(mcp.setEnabled('missing', false, cwd)).resolves.toMatchObject({ ok: false });
  });

  it('disables a user-level server for one project with an override', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });
    await mcp.add({ name: 'tools', command: 'uvx' }, cwd);

    const result = await mcp.setEnabled('tools', false, cwd, 'project');

    expect(result).toMatchObject({ ok: true, scope: 'project', override: true });
    // The user file is untouched; the project file only carries the override.
    expect(readServers(join(agentDir, 'mcp.json'))['tools']).not.toHaveProperty('enabled');
    expect(readServers(join(cwd, '.pi', 'mcp.json'))['tools']).toEqual({ enabled: false });
  });

  it('enabling in a project removes the override, falling back to the global value', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });
    await mcp.add({ name: 'tools', command: 'uvx' }, cwd);
    await mcp.setEnabled('tools', false, cwd, 'project');

    await mcp.setEnabled('tools', true, cwd, 'project');

    expect(readServers(join(cwd, '.pi', 'mcp.json'))['tools']).toBeUndefined();
    expect(readServers(join(agentDir, 'mcp.json'))['tools']).toBeDefined();
  });

  it('edits a project-defined server in place, not as an override', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });
    await mcp.add({ name: 'docs', command: 'serve', scope: 'project' }, cwd);

    await mcp.setEnabled('docs', false, cwd, 'project');

    expect(readServers(join(cwd, '.pi', 'mcp.json'))['docs']).toMatchObject({
      command: 'serve',
      enabled: false,
    });
  });

  it('project remove never touches the user file', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });
    await mcp.add({ name: 'tools', command: 'uvx' }, cwd);

    await expect(mcp.remove('tools', cwd, 'project')).resolves.toMatchObject({ ok: false });
    expect(readServers(join(agentDir, 'mcp.json'))['tools']).toBeDefined();

    await mcp.add({ name: 'docs', command: 'serve', scope: 'project' }, cwd);
    await expect(mcp.remove('docs', cwd, 'project')).resolves.toMatchObject({ ok: true });
    expect(readServers(join(cwd, '.pi', 'mcp.json'))['docs']).toBeUndefined();
  });

  it('global scope edits the user file even when a project override exists', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });
    await mcp.add({ name: 'tools', command: 'uvx' }, cwd);
    await mcp.setEnabled('tools', false, cwd, 'project');

    await mcp.setEnabled('tools', false, cwd, 'global');

    expect(readServers(join(agentDir, 'mcp.json'))['tools']).toMatchObject({ enabled: false });
    // The override is independent and stays where it was.
    expect(readServers(join(cwd, '.pi', 'mcp.json'))['tools']).toMatchObject({ enabled: false });
  });
});

describe('parseMcpServerInput', () => {
  it('drops entries of the wrong shape and keeps the rest', () => {
    expect(
      parseMcpServerInput({
        name: 'ctx',
        type: 'http',
        url: 'https://x/mcp',
        scope: 'project',
        exposure: 'deferred',
        args: ['-y', 3, 'pkg'],
        headers: { Authorization: 'Bearer x', broken: 2 },
      }),
    ).toEqual({
      name: 'ctx',
      scope: 'project',
      type: 'http',
      url: 'https://x/mcp',
      exposure: 'deferred',
      args: ['-y', 'pkg'],
      headers: { Authorization: 'Bearer x' },
      env: undefined,
    });
  });

  it('answers an empty name for a non-object payload', () => {
    expect(parseMcpServerInput(undefined)).toEqual({
      name: '',
      env: undefined,
      headers: undefined,
    });
  });
});
