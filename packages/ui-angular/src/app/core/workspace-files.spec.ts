import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostCapabilities } from '@morse/protocol';
import { MorseService } from './morse.service';
import { WorkspaceFiles } from './workspace-files';

function setup(capabilities: Partial<HostCapabilities>) {
  const state = signal({ workspace: { cwd: '/repo', name: 'repo' } });
  const requestHostCommand = vi.fn((command: string) =>
    Promise.resolve(
      command === 'listFiles' ? { files: ['README.md'] } : { isRepo: false, files: [] },
    ),
  );
  const morse = {
    state,
    // The real service derives `workspace` from `state`; mirror that so the
    // effect sees a directory to load.
    workspace: computed(() => state().workspace),
    capabilities: signal(capabilities as HostCapabilities),
    requestHostCommand,
  };
  TestBed.configureTestingModule({ providers: [{ provide: MorseService, useValue: morse }] });
  const files = TestBed.inject(WorkspaceFiles);
  // Effects run with change detection, and a service does not drive the
  // application on its own — `tick()` is what flushes them here.
  TestBed.tick();
  return { files, requestHostCommand };
}

function commands(requestHostCommand: ReturnType<typeof vi.fn>): string[] {
  return requestHostCommand.mock.calls.map(([command]) => command as string);
}

/** The arguments of every `listFiles` request, in the order they were made. */
function listArgs(requestHostCommand: ReturnType<typeof vi.fn>): unknown[] {
  return requestHostCommand.mock.calls
    .filter(([command]) => command === 'listFiles')
    .map(([, args]) => args);
}

/** Mirrors the service's poll interval; the timer is what drives the test. */
const POLL_MS = 4_000;

/**
 * Lets the promise chain behind a poll land before the next assertion, since the
 * interval only *starts* the round trip and the host answers asynchronously.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

/**
 * A polling harness. Fake timers are installed before the service exists, so the
 * interval its constructor registers is one the test can drive; `status` is read
 * per request, so a test can move the working tree between ticks.
 */
async function setupPolling(
  capabilities: Partial<HostCapabilities>,
  status: () => unknown = () => ({ isRepo: true, files: [] }),
) {
  vi.useFakeTimers();
  // A pinned clock: the poll compares the working tree against the last reading
  // and against a staleness cap, so the epoch must not decide the outcome.
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const state = signal({ workspace: { cwd: '/repo', name: 'repo' } });
  const requestHostCommand = vi.fn((command: string) =>
    Promise.resolve(command === 'listFiles' ? { files: ['README.md'] } : status()),
  );
  const morse = {
    state,
    workspace: computed(() => state().workspace),
    capabilities: signal(capabilities as HostCapabilities),
    requestHostCommand,
  };
  TestBed.configureTestingModule({ providers: [{ provide: MorseService, useValue: morse }] });
  const files = TestBed.inject(WorkspaceFiles);
  TestBed.tick();
  await settle();
  return {
    files,
    requestHostCommand,
    /** Runs `times` poll ticks, with every answer landed. */
    async poll(times = 1): Promise<void> {
      for (let index = 0; index < times; index += 1) {
        await vi.advanceTimersByTimeAsync(POLL_MS);
        await settle();
      }
    },
  };
}

describe('WorkspaceFiles', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('does not ask a host without git for gitStatus', () => {
    // VS Code advertises `filePicker` (for the @ picker) but implements no
    // `gitStatus`: polling it put a red "VS Code does not implement gitStatus"
    // in the transcript every 4 seconds. `gitPanel` is the gate.
    const { requestHostCommand } = setup({ hostKind: 'vscode', filePicker: true, gitPanel: false });

    expect(commands(requestHostCommand)).toContain('listFiles');
    expect(commands(requestHostCommand)).not.toContain('gitStatus');
  });

  it('asks the browser host for the working tree it advertises', () => {
    const { requestHostCommand } = setup({ hostKind: 'server', filePicker: true, gitPanel: true });

    expect(commands(requestHostCommand)).toContain('gitStatus');
  });

  it('asks nothing when the host cannot list files at all', () => {
    const { requestHostCommand } = setup({
      hostKind: 'vscode',
      filePicker: false,
      gitPanel: false,
    });

    expect(requestHostCommand).not.toHaveBeenCalled();
  });

  it('re-reads the list when the tree moved, not on every quiet tick', async () => {
    // `listFiles{fresh:true}` makes the browser host re-scan the whole
    // directory, so a poll that finds the same working tree must not ask for
    // one: it is the status — one cheap call — that has to run every tick.
    let tree: unknown = { isRepo: true, files: [{ path: 'a.ts', status: ' M' }] };
    const { requestHostCommand, poll } = await setupPolling(
      { hostKind: 'server', filePicker: true, gitPanel: true },
      () => tree,
    );

    await poll();
    await poll();
    // A file appears: the porcelain listing moves, and the list follows.
    tree = {
      isRepo: true,
      files: [
        { path: 'a.ts', status: ' M' },
        { path: 'b.ts', status: '??' },
      ],
    };
    await poll();

    expect(listArgs(requestHostCommand)).toEqual([
      undefined,
      { fresh: true },
      undefined,
      { fresh: true },
    ]);
  });

  it('keeps re-reading the list where the status cannot decide it', async () => {
    // Not a repository: the host answers from a directory walk, which no git
    // status can vouch for, so every tick has to ask for the real thing.
    const { requestHostCommand, poll } = await setupPolling(
      { hostKind: 'server', filePicker: true, gitPanel: true },
      () => ({ isRepo: false, files: [] }),
    );

    await poll(3);

    const fresh = listArgs(requestHostCommand).slice(1);
    expect(fresh).toHaveLength(3);
    expect(fresh.every((args) => (args as { fresh?: boolean })?.fresh === true)).toBe(true);
  });

  it('asks a host with no git for the list alone, every tick', async () => {
    // VS Code: `gitPanel` off, so there is no status to compare and the host's
    // own `listFiles` cache is the only thing standing between the picker and a
    // workspace walk.
    const { requestHostCommand, poll } = await setupPolling({
      hostKind: 'vscode',
      filePicker: true,
      gitPanel: false,
    });

    await poll(3);

    expect(commands(requestHostCommand)).not.toContain('gitStatus');
    expect(commands(requestHostCommand).filter((command) => command === 'listFiles')).toHaveLength(4);
  });
});
