import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from './morse.service';
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
  return { requestHostCommand, push: () => push };
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
