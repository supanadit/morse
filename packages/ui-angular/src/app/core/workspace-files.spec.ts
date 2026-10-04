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

describe('WorkspaceFiles', () => {
  afterEach(() => TestBed.resetTestingModule());

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
});
