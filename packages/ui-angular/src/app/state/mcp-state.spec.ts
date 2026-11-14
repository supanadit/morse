import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../host/morse.service';
import { McpState } from './mcp-state';
import { WorkspaceTabs } from './workspace-tabs';

/**
 * The host watches pi's `mcp.json` files and pushes `mcp/changed`; the store is
 * the one that turns that into a re-read. These tests cover the push path
 * (`capabilities.mcp` is off on purpose, so the background probe's timer never
 * races them).
 */
function setup(workspaceCwd = '/repo', capabilities: Record<string, unknown> = { mcp: false }) {
  let push: ((event: { cwd: string }) => void) | undefined;
  const requestHostCommand = vi.fn(
    async (..._args: unknown[]): Promise<unknown> => ({
      servers: [],
      errors: [],
      trusted: true,
    }),
  );
  const onMcpChanged = (listener: (event: { cwd: string }) => void): (() => void) => {
    push = listener;
    return () => {
      push = undefined;
    };
  };
  const fake = {
    capabilities: signal(capabilities),
    workspace: signal({ cwd: workspaceCwd, name: 'repo' }),
    // The draft's/session's engine choice; absent means the host's default.
    engine: signal<string | undefined>(undefined),
    requestHostCommand,
    onMcpChanged,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: MorseService, useValue: fake },
      { provide: WorkspaceTabs, useValue: { noSessionInFront: signal(false) } },
    ],
  });
  const state = TestBed.inject(McpState);
  return { requestHostCommand, push: () => push, engine: fake.engine, state };
}

afterEach(() => TestBed.resetTestingModule());

describe('McpState', () => {
  it('re-reads the directory the host says changed', async () => {
    const { requestHostCommand, push } = setup('/repo');

    push()?.({ cwd: '/repo' });

    await vi.waitFor(() => {
      expect(requestHostCommand).toHaveBeenCalledWith(
        'mcpStatus',
        { cwd: '/repo' },
        expect.any(Number),
      );
    });
  });

  it('names the chosen engine on every command and refetches when it changes', async () => {
    const { requestHostCommand, engine } = setup('/repo');

    engine.set('opencode');
    await TestBed.inject(McpState).refresh('/repo', true);
    // OpenCode ignores `probe`, so its fast read is the whole round trip.
    expect(requestHostCommand).toHaveBeenLastCalledWith(
      'mcpStatus',
      { cwd: '/repo', engine: 'opencode' },
      expect.any(Number),
    );

    // Switching the draft's engine is a different config: a fresh read with the
    // new kind, and the background probe that follows names it too.
    engine.set('pi');
    await TestBed.inject(McpState).refresh('/repo', true);
    expect(requestHostCommand).toHaveBeenLastCalledWith(
      'mcpStatus',
      { cwd: '/repo', engine: 'pi', probe: true },
      expect.any(Number),
    );
  });

  it('does not re-read a directory no surface is showing', async () => {
    const { requestHostCommand, push } = setup('/repo');

    push()?.({ cwd: '/elsewhere' });
    await Promise.resolve();

    expect(requestHostCommand).not.toHaveBeenCalled();
  });

  it('treats the user-level file as a change for the directory in front', async () => {
    const { requestHostCommand, push } = setup('/repo');

    push()?.({ cwd: '' });

    await vi.waitFor(() => {
      expect(requestHostCommand).toHaveBeenCalledWith(
        'mcpStatus',
        { cwd: '/repo' },
        expect.any(Number),
      );
    });
  });
});

/** The config issues a status carries, and the two actions they enable. */
describe('McpState issues, probing and Fix', () => {
  it('reports Fix available only when the host advertises configFix', () => {
    const { state } = setup('/repo', { mcp: true, configFix: true });
    expect(state.canFix()).toBe(true);
  });

  it('hides Fix when the host does not advertise configFix', () => {
    const { state } = setup('/repo', { mcp: true });
    expect(state.canFix()).toBe(false);
  });

  it('parses the config issues the host attached to a status', async () => {
    const { requestHostCommand, state } = setup('/repo');
    requestHostCommand.mockResolvedValue({
      servers: [],
      errors: [],
      trusted: true,
      issues: [
        {
          file: '/repo/opencode.json',
          fileId: 'config',
          scope: 'project',
          code: 'normalize',
          message: '/repo/opencode.json: rewrite this file without comments.',
          fixable: true,
        },
      ],
    });

    const status = await state.refresh('/repo', true);
    expect(status?.issues).toEqual([
      {
        file: '/repo/opencode.json',
        fileId: 'config',
        scope: 'project',
        code: 'normalize',
        message: '/repo/opencode.json: rewrite this file without comments.',
        fixable: true,
      },
    ]);
  });

  it('reads the fast status first, then probes in the background', async () => {
    const { requestHostCommand, state } = setup('/repo');
    requestHostCommand.mockImplementation((_command, args) =>
      Promise.resolve(
        (args as { probe?: boolean } | undefined)?.probe === true
          ? {
              servers: [{ name: 'docs', state: 'connected', enabled: true }],
              errors: [],
            }
          : { servers: [{ name: 'docs', state: 'connecting', enabled: true }], errors: [] },
      ),
    );

    await state.refresh('/repo', true);
    expect(requestHostCommand).toHaveBeenCalledWith(
      'mcpStatus',
      { cwd: '/repo' },
      expect.any(Number),
    );

    // The probe's live answer replaces the fast one, so the dot settles without
    // the panel having waited for a server to connect.
    await vi.waitFor(() => {
      expect(state.status('/repo')?.servers[0]?.state).toBe('connected');
    });
    expect(requestHostCommand).toHaveBeenCalledWith(
      'mcpStatus',
      { cwd: '/repo', probe: true },
      expect.any(Number),
    );
  });

  it('probes on its own in-flight track, so a refresh cannot swallow it', async () => {
    const { requestHostCommand, state } = setup('/repo');
    let answerProbe: ((value: unknown) => void) | undefined;
    requestHostCommand.mockImplementation((_command, args) =>
      (args as { probe?: boolean } | undefined)?.probe === true
        ? new Promise((resolve) => {
            answerProbe = resolve;
          })
        : Promise.resolve({ servers: [], errors: [] }),
    );

    const probing = state.probe('/repo');
    // The same directory's refresh must still ask the host for the fast list.
    await state.refresh('/repo', true);
    const fastReads = requestHostCommand.mock.calls.filter(
      ([, args]) => (args as { probe?: boolean } | undefined)?.probe !== true,
    );
    expect(fastReads).toHaveLength(1);

    answerProbe?.({
      servers: [{ name: 'docs', state: 'connected', enabled: true }],
      errors: [],
    });
    await expect(probing).resolves.toMatchObject({ servers: [{ state: 'connected' }] });
  });

  /** The `mcpStatus` calls that asked for a live probe. */
  function probeCalls(requestHostCommand: ReturnType<typeof vi.fn>): unknown[][] {
    return requestHostCommand.mock.calls.filter(
      ([, args]) => (args as { probe?: boolean } | undefined)?.probe === true,
    );
  }

  it('probes once inside the probe TTL, however many refreshes arrive', async () => {
    const { requestHostCommand, state } = setup('/repo');

    await state.refresh('/repo', true);
    // Join the probe the refresh started, so the TTL — not the in-flight share —
    // is what the next refresh meets.
    await state.probe('/repo');
    expect(probeCalls(requestHostCommand)).toHaveLength(1);

    await state.refresh('/repo', true);
    await state.probe('/repo');
    expect(probeCalls(requestHostCommand)).toHaveLength(1);
  });

  it('does not probe when the fast read came from the cache', async () => {
    const { state } = setup('/repo');

    await state.refresh('/repo', true);
    await state.probe('/repo');
    // A cache hit must not even consider a dial.
    const probe = vi.spyOn(state, 'probe');

    await state.refresh('/repo');
    expect(probe).not.toHaveBeenCalled();
  });

  it('leaves the loading state to the fast read, not the probe', async () => {
    const { requestHostCommand, state } = setup('/repo');
    let answerProbe: ((value: unknown) => void) | undefined;
    requestHostCommand.mockImplementation((_command, args) =>
      (args as { probe?: boolean } | undefined)?.probe === true
        ? new Promise((resolve) => {
            answerProbe = resolve;
          })
        : Promise.resolve({ servers: [], errors: [] }),
    );

    const refreshed = await state.refresh('/repo', true);
    expect(refreshed).toMatchObject({ servers: [] });
    // The panel's Refresh must work while servers are still dialing.
    expect(state.isLoading('/repo')).toBe(false);
    expect(state.isProbing('/repo')).toBe(true);

    answerProbe?.({
      servers: [{ name: 'docs', state: 'connected', enabled: true }],
      errors: [],
    });
    await vi.waitFor(() => {
      expect(state.isProbing('/repo')).toBe(false);
    });
  });

  it('drops a probe that lands after a newer fast read', async () => {
    const { requestHostCommand, state } = setup('/repo');
    let answerProbe: ((value: unknown) => void) | undefined;
    requestHostCommand.mockImplementation((_command, args) =>
      (args as { probe?: boolean } | undefined)?.probe === true
        ? new Promise((resolve) => {
            answerProbe = resolve;
          })
        : Promise.resolve({
            servers: [{ name: 'new', state: 'connected', enabled: true }],
            errors: [],
          }),
    );

    const staleProbe = state.probe('/repo');
    // The read started after the probe is authoritative even though the probe
    // answers last; its stale rows must not replace the newer list.
    await state.refresh('/repo', true);
    answerProbe?.({
      servers: [{ name: 'old', state: 'failed', enabled: true }],
      errors: [],
    });
    await staleProbe;

    expect(state.status('/repo')?.servers.map((server) => server.name)).toEqual(['new']);
  });

  it('clears the probe TTL when an external change arrives', async () => {
    const { requestHostCommand, state, push } = setup('/repo');

    await state.refresh('/repo', true);
    await state.probe('/repo');
    expect(probeCalls(requestHostCommand)).toHaveLength(1);

    // The host saw the file move; the cached live state is as stale as the list.
    push()?.({ cwd: '/repo' });
    await vi.waitFor(() => {
      expect(probeCalls(requestHostCommand)).toHaveLength(2);
    });
  });

  it('clears the probe TTL after a successful mutation', async () => {
    const { requestHostCommand, state } = setup('/repo');
    requestHostCommand.mockImplementation((command) =>
      command === 'mcpSetEnabled'
        ? Promise.resolve({ ok: true, scope: 'global' })
        : Promise.resolve({ servers: [], errors: [] }),
    );

    await state.refresh('/repo', true);
    await state.probe('/repo');
    expect(probeCalls(requestHostCommand)).toHaveLength(1);

    const result = await state.setEnabled('docs', false, '/repo', 'global');
    expect(result.ok).toBe(true);
    // The write changed what connects; the next refresh must dial again.
    await vi.waitFor(() => {
      expect(probeCalls(requestHostCommand)).toHaveLength(2);
    });
  });

  it('fixes an issue through the host, then refreshes the directory', async () => {
    const { requestHostCommand, state } = setup('/repo');
    requestHostCommand.mockImplementation((command) =>
      command === 'configFix'
        ? Promise.resolve({
            ok: true,
            path: '/repo/opencode.json',
            scope: 'project',
            issues: [],
          })
        : Promise.resolve({ servers: [], errors: [] }),
    );

    const result = await state.fix('/repo', {
      file: '/repo/opencode.json',
      fileId: 'config',
      scope: 'project',
      code: 'normalize',
      message: 'rewrite this file',
      fixable: true,
    });

    expect(result.ok).toBe(true);
    expect(requestHostCommand).toHaveBeenCalledWith(
      'configFix',
      {
        fileId: 'config',
        path: '/repo/opencode.json',
        scope: 'project',
        cwd: '/repo',
      },
      expect.any(Number),
    );
    expect(requestHostCommand).toHaveBeenCalledWith(
      'mcpStatus',
      { cwd: '/repo' },
      expect.any(Number),
    );
  });

  it('reports a host without the Fix command instead of claiming success', async () => {
    const { requestHostCommand, state } = setup('/repo');
    // An older host answers `undefined` (the command is not implemented).
    requestHostCommand.mockResolvedValue(undefined);

    const result = await state.fix('/repo', {
      file: '/repo/mcp.json',
      fileId: 'mcp',
      scope: 'global',
      code: 'normalize',
      message: 'rewrite this file',
      fixable: true,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
  });
});
