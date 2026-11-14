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

  it('toggles a project override when no scope is named', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });
    await mcp.add({ name: 'tools', command: 'uvx' }, cwd);
    await mcp.setEnabled('tools', false, cwd, 'project');

    // The nearer edit is the project's pin, not the user-level definition.
    await mcp.setEnabled('tools', true, cwd);

    expect(readServers(join(cwd, '.pi', 'mcp.json'))['tools']).toBeUndefined();
    expect(readServers(join(agentDir, 'mcp.json'))['tools']).not.toHaveProperty('enabled');
  });

  it('removes a project override before the global server when no scope is named', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcp = new PiMcp({ agentDir });
    await mcp.add({ name: 'tools', command: 'uvx' }, cwd);
    await mcp.setEnabled('tools', false, cwd, 'project');

    await expect(mcp.remove('tools', cwd)).resolves.toMatchObject({ ok: true });

    expect(readServers(join(cwd, '.pi', 'mcp.json'))['tools']).toBeUndefined();
    expect(readServers(join(agentDir, 'mcp.json'))['tools']).toBeDefined();
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

  it('reports the entry itself so the panel can edit it', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    writeJson(join(agentDir, 'mcp.json'), {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', 'server-github'],
          env: { GITHUB_TOKEN: 'secret' },
        },
      },
    });

    const status = await new PiMcp({ agentDir }).status(cwd);

    // The editor prefills from this, so env/args must survive the mapping.
    expect(status.servers[0]?.config).toMatchObject({
      name: 'github',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { GITHUB_TOKEN: 'secret' },
    });
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

  it('keeps an untrusted project from enabling a globally disabled server', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    writeJson(join(agentDir, 'mcp.json'), {
      mcpServers: { off: { command: 'node', enabled: false } },
    });
    // The project pins it on and carries a name issue. Neither may leak: pi
    // ignores an untrusted project's `.pi` tree entirely.
    writeJson(join(cwd, '.pi', 'mcp.json'), {
      mcpServers: { off: { enabled: true }, 'bad name': { command: 'node' } },
    });
    const inspector = fakeInspector(inspection());

    const mcp = new PiMcp({ agentDir, inspector });
    const status = await mcp.status(cwd, { probe: true });

    expect(status.trusted).toBe(false);
    expect(status.servers[0]).toMatchObject({ name: 'off', enabled: false, state: 'disabled' });
    expect(inspector.inspect).not.toHaveBeenCalled();
    expect(status.errors).toEqual([]);
  });

  it('keeps an untrusted project from disabling a global server', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    writeJson(join(agentDir, 'mcp.json'), { mcpServers: { on: { command: 'node' } } });
    writeJson(join(cwd, '.pi', 'mcp.json'), { mcpServers: { on: { enabled: false } } });
    const inspector = fakeInspector(inspection());

    const mcp = new PiMcp({ agentDir, inspector });
    const status = await mcp.status(cwd, { probe: true });

    expect(status.servers[0]).toMatchObject({ enabled: true, state: 'connected' });
    expect(inspector.inspect).toHaveBeenCalledTimes(1);
  });

  it('probes a trusted project override with the global row details', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    writeJson(join(agentDir, 'mcp.json'), {
      mcpServers: { one: { command: 'node', args: ['srv.js'] } },
    });
    writeJson(join(cwd, '.pi', 'mcp.json'), { mcpServers: { one: { exposure: 'direct' } } });
    const inspector = fakeInspector(inspection());

    const mcp = new PiMcp({ agentDir, inspector });
    await mcp.trustProject(cwd);
    const status = await mcp.status(cwd, { probe: true });

    expect(status.trusted).toBe(true);
    expect(status.servers[0]).toMatchObject({
      name: 'one',
      scope: 'global',
      source: join(agentDir, 'mcp.json'),
      transport: 'stdio: node srv.js',
      exposure: 'direct',
      override: join(cwd, '.pi', 'mcp.json'),
      state: 'connected',
    });
  });

  it('probes a global-only list in the agent directory', async () => {
    const agentDir = await tempRoot();
    writeJson(join(agentDir, 'mcp.json'), { mcpServers: { one: { command: 'node' } } });
    const inspector = fakeInspector(inspection());

    const mcp = new PiMcp({ agentDir, inspector });
    await mcp.status(undefined, { probe: true });

    expect(inspector.inspect.mock.calls[0]?.[1]).toMatchObject({ cwd: agentDir });
  });

  it('treats an empty agentDir as unset', async () => {
    const envAgentDir = await tempRoot();
    const cwd = await tempRoot();
    writeJson(join(envAgentDir, 'mcp.json'), { mcpServers: { envOne: { command: 'node' } } });

    const mcp = new PiMcp({
      agentDir: '',
      env: { ...process.env, PI_CODING_AGENT_DIR: envAgentDir },
    });
    const status = await mcp.status(cwd);

    expect(status.servers.map((server) => server.name)).toEqual(['envOne']);
  });

  it('aborts the probe budget without failing the list or inventing a config issue', async () => {
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

      // The row owns the failure: a server that will not connect is not a
      // complaint about the file that configures it, so it stays out of both
      // `issues` (which the panel offers Fix for) and `errors`.
      expect(status.servers[0]).toMatchObject({ state: 'disconnected' });
      expect(status.servers[0]!.error).toBeTruthy();
      expect(status.issues).toEqual([]);
      expect(status.errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the whole probe so many servers cannot exceed the status timeout', async () => {
    vi.useFakeTimers();
    try {
      const agentDir = await tempRoot();
      const cwd = await tempRoot();
      const mcpServers = Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`s${index}`, { command: 'node' }]),
      );
      writeJson(join(agentDir, 'mcp.json'), { mcpServers });
      const inspector = fakeInspector(() => new Promise<McpInspection>(() => {}));

      const mcp = new PiMcp({ agentDir, inspector, probeBudgetMs: 20 });
      const pending = mcp.status(cwd, { probe: true });
      await vi.advanceTimersByTimeAsync(20);
      const status = await pending;

      // Every row answers: the three in flight and the six the budget never
      // reached. None is left `connecting`, and the file is not blamed.
      expect(status.servers).toHaveLength(9);
      expect(
        status.servers.every(
          (server) => server.state === 'disconnected' && (server.error ?? '').length > 0,
        ),
      ).toBe(true);
      expect(status.issues).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the list intact when one probe hangs and another settles', async () => {
    vi.useFakeTimers();
    try {
      const agentDir = await tempRoot();
      const cwd = await tempRoot();
      writeJson(join(agentDir, 'mcp.json'), {
        mcpServers: { stuck: { command: 'stuck-cmd' }, quick: { command: 'quick-cmd' } },
      });
      const inspect = vi.fn((spec: McpServerSpec) =>
        spec.command === 'stuck-cmd'
          ? new Promise<McpInspection>(() => {})
          : Promise.resolve(inspection({ tools: [{ name: 'quick-tool' }] })),
      );

      const mcp = new PiMcp({ agentDir, inspector: { inspect } });
      const pending = mcp.status(cwd, { probe: true });
      await vi.advanceTimersByTimeAsync(10_000);
      const status = await pending;
      const rows = new Map(status.servers.map((server) => [server.name, server]));

      expect(rows.get('quick')).toMatchObject({ state: 'connected', tools: ['quick-tool'] });
      expect(rows.get('stuck')).toMatchObject({ state: 'disconnected' });
      expect(rows.get('stuck')!.error).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('probes at most three servers at once', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    const mcpServers = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`s${index}`, { command: 'node' }]),
    );
    writeJson(join(agentDir, 'mcp.json'), { mcpServers });

    let active = 0;
    let peak = 0;
    const inspect = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return inspection();
    });

    const mcp = new PiMcp({ agentDir, inspector: { inspect } });
    const status = await mcp.status(cwd, { probe: true });

    expect(inspect).toHaveBeenCalledTimes(5);
    expect(peak).toBe(3);
    expect(status.servers.every((server) => server.state === 'connected')).toBe(true);
  });

  it('reports a thrown probe as failed, not disconnected, and keeps it out of the issues', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    writeJson(join(agentDir, 'mcp.json'), { mcpServers: { one: { command: 'node' } } });
    const inspect = vi.fn(async () => {
      throw new Error('probe exploded');
    });

    const mcp = new PiMcp({ agentDir, inspector: { inspect } });
    const status = await mcp.status(cwd, { probe: true });

    expect(status.servers[0]).toMatchObject({ state: 'failed', error: 'probe exploded' });
    // A refused connection is not a config-file complaint: the file is fine, and
    // "Fix" must never be offered for it.
    expect(status.issues).toEqual([]);
    expect(status.errors).toEqual([]);
  });

  it('keeps config-file issues when a probe also fails, and never invents one for the failure', async () => {
    const agentDir = await tempRoot();
    const cwd = await tempRoot();
    // JSONC: parseable, but not strict JSON — a genuine config-file complaint.
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'mcp.json'),
      '{\n  // a comment\n  "mcpServers": { "one": { "command": "node" } }\n}\n',
      'utf8',
    );
    const inspect = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    const mcp = new PiMcp({ agentDir, inspector: { inspect } });
    const status = await mcp.status(cwd, { probe: true });

    expect(status.servers[0]).toMatchObject({
      name: 'one',
      state: 'failed',
      error: 'connect ECONNREFUSED',
    });
    expect(status.issues).toHaveLength(1);
    expect(status.issues?.[0]).toMatchObject({
      file: join(agentDir, 'mcp.json'),
      fileId: 'mcp',
      scope: 'global',
      code: 'normalize',
      fixable: true,
    });
    expect(status.errors).toEqual([status.issues?.[0]?.message]);
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
