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
function setup(workspaceCwd = '/repo') {
  let push: ((event: { cwd: string }) => void) | undefined;
  const requestHostCommand = vi.fn(() =>
    Promise.resolve({ servers: [], errors: [], trusted: true }),
  );
  const fake = {
    capabilities: signal({ mcp: false }),
    workspace: signal({ cwd: workspaceCwd, name: 'repo' }),
    // The draft's/session's engine choice; absent means the host's default.
    engine: signal<string | undefined>(undefined),
    requestHostCommand,
    onMcpChanged: (listener: (event: { cwd: string }) => void) => {
      push = listener;
      return () => {
        push = undefined;
      };
    },
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: MorseService, useValue: fake },
      { provide: WorkspaceTabs, useValue: { noSessionInFront: signal(false) } },
    ],
  });
  TestBed.inject(McpState);
  return { requestHostCommand, push: () => push, engine: fake.engine };
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

    engine.set('pi');
    await TestBed.inject(McpState).refresh('/repo', true);
    expect(requestHostCommand).toHaveBeenCalledWith(
      'mcpStatus',
      { cwd: '/repo', engine: 'pi' },
      expect.any(Number),
    );

    // Switching the draft's engine is a different config: a fresh read with the
    // new kind, never the previous engine's cached answer.
    engine.set('opencode');
    await TestBed.inject(McpState).refresh('/repo', true);
    expect(requestHostCommand).toHaveBeenLastCalledWith(
      'mcpStatus',
      { cwd: '/repo', engine: 'opencode' },
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
