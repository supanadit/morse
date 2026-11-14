import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiMcp, parseMcpServerInput } from './pi-mcp.js';
import type { McpInspection, McpServerSpec } from './internal/mcp-client.js';

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
  return parsed.mcpServers ?? {};
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fakeInspector(
  result: McpInspection | (() => Promise<McpInspection>),
): { inspect: ReturnType<typeof vi.fn> } {
  const inspect = vi.fn(async (_spec: McpServerSpec) =>
    typeof result === 'function' ? result() : result,
  );
  return { inspect };
}

function inspection(overrides: Partial<McpInspection> = {}): McpInspection {
  return {
    ok: true,
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    durationMs: 1,
    ...overrides,
  };
}

describe('PiMcp status', () => {
  it('lists configured servers without a working pi binary', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    writeJson(join(agentDir, 'mcp.json'), { mcpServers: { one: { command: 'node' } } });

    const mcp = new PiMcp({ agentDir, piPath: '/nonexistent/pi' });
    const status = await mcp.status(cwd);

    expect(status.servers[0]).toMatchObject({ name: 'one', state: 'connecting', enabled: true });
    expect(status.note).toMatch(/configured files only/);
    expect(status.errors).toEqual([]);
  });

  it('probes enabled servers and fills tools', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    writeJson(join(agentDir, 'mcp.json'), { mcpServers: { one: { command: 'node' } } });
    const inspector = fakeInspector(
      inspection({
        tools: [{ name: 'read' }],
        resources: [{ uri: 'file:///a' }],
        resourceTemplates: [{ uriTemplate: 'file:///{path}' }],
      }),
    );

    const mcp = new PiMcp({ agentDir, inspector });
    const status = await mcp.status(cwd, { probe: true });

    expect(status.servers[0]).toMatchObject({
      state: 'connected',
      tools: ['read'],
      resources: 1,
      resourceTemplates: 1,
    });
    expect(inspector.inspect).toHaveBeenCalledTimes(1);
  });

  it('does not probe a disabled server and reports its disabled state', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    writeJson(join(agentDir, 'mcp.json'), {
      mcpServers: { off: { command: 'node', enabled: false } },
    });
    const inspector = fakeInspector(inspection());

    const mcp = new PiMcp({ agentDir, inspector });
    const status = await mcp.status(cwd, { probe: true });

    expect(status.servers[0]).toMatchObject({ state: 'disabled', enabled: false, tools: [] });
    expect(inspector.inspect).not.toHaveBeenCalled();
  });

  it('keeps the project trust filter and reports untrusted', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    writeJson(join(agentDir, 'mcp.json'), { mcpServers: { globalOne: { command: 'node' } } });
    writeJson(join(cwd, '.pi', 'mcp.json'), { mcpServers: { projectOne: { command: 'node' } } });

    const mcp = new PiMcp({ agentDir });
    const status = await mcp.status(cwd);

    expect(status.trusted).toBe(false);
    expect(status.servers.map((server) => server.name)).toEqual(['globalOne']);
  });

  it('aborts the probe budget without failing the list', async () => {
    vi.useFakeTimers();
    try {
      const agentDir = await tempRoot();
      const cwd = await tempRoot();
      writeJson(join(agentDir, 'mcp.json'), { mcpServers: { stuck: { command: 'node' } } });
      const inspector = fakeInspector(() => new Promise<McpInspection>(() => {}));

      const mcp = new PiMcp({ agentDir, inspector });
      const pending = mcp.status(cwd, { probe: true });
      await vi.advanceTimersByTimeAsync(10_000);
      const status = await pending;

      expect(['connecting', 'disconnected']).toContain(status.servers[0]!.state);
      expect(status.servers[0]!.error).toBeTruthy();
      expect(status.issues?.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
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

  it('writes a global server with no project at all', async () => {
    const agentDir = await tempRoot();
    const mcp = new PiMcp({ agentDir });

    const result = await mcp.add(
      { name: 'openviking', scope: 'global', command: 'npx', args: ['-y', 'pkg'], exposure: 'codemode' },
      undefined,
    );

    expect(result.ok).toBe(true);
    expect(readServers(join(agentDir, 'mcp.json'))['openviking']).toBeDefined();
  });

  it('refuses a project server when there is no project to write into', async () => {
    const agentDir = await tempRoot();
    const mcp = new PiMcp({ agentDir });

    const result = await mcp.add(
      { name: 'filesystem', scope: 'project', command: 'npx', args: [], exposure: 'codemode' },
      undefined,
    );

    expect(result).toEqual({
      ok: false,
      message: 'Open a session to add a server to its project.',
    });
    expect(existsSync(join(agentDir, 'mcp.json'))).toBe(false);
  });
});
