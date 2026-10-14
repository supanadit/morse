import { describe, expect, it } from 'vitest';
import type { GitStatus } from '@morse/protocol';
import { WorkspaceFilesStore } from './workspace-files.store';

describe('WorkspaceFilesStore', () => {
  it('publishes whatever its setters are given', () => {
    const store = new WorkspaceFilesStore();

    expect(store.files()).toEqual([]);
    expect(store.busy()).toBe(false);
    expect(store.status()).toBeUndefined();
    expect(store.error()).toBeUndefined();

    const status: GitStatus = { isRepo: true, files: [{ path: 'a.ts', status: ' M' }] };
    store.setFiles(['a.ts']);
    store.setBusy(true);
    store.setStatus('', status);
    store.setError('Could not list this project.');

    expect(store.files()).toEqual(['a.ts']);
    expect(store.busy()).toBe(true);
    expect(store.status()).toEqual(status);
    expect(store.error()).toBe('Could not list this project.');
  });

  it('merges every repository into one status for the Explorer', () => {
    const store = new WorkspaceFilesStore();
    store.setStatuses({
      '': { isRepo: true, files: [{ path: 'root.ts', status: ' M' }] },
      'packages/sub': { isRepo: true, files: [{ path: 'packages/sub/a.ts', status: '??' }] },
    });

    expect(store.status()?.files.map((file) => file.path)).toEqual([
      'root.ts',
      'packages/sub/a.ts',
    ]);
    // A nested repository with no changes of its own adds nothing.
    store.setStatus('packages/sub', { isRepo: true, files: [] });
    expect(store.status()?.files.map((file) => file.path)).toEqual(['root.ts']);
  });

  it('holds the Explorer\u2019s listed levels, the ones on their way, and forgets both', () => {
    const store = new WorkspaceFilesStore();
    expect(store.directories()).toEqual({});
    expect(store.pendingDirectories().size).toBe(0);

    store.setDirectory('', ['src/', 'README.md']);
    store.setDirectoryPending('src', true);

    expect(store.directories()['']).toEqual(['src/', 'README.md']);
    expect(store.pendingDirectories().has('src')).toBe(true);

    // A level that landed stops being pending; setting either way twice is a no-op.
    store.setDirectoryPending('src', false);
    store.setDirectoryPending('src', false);
    expect(store.pendingDirectories().size).toBe(0);

    // A refresh, a moved tree or a project switch throws both away at once.
    store.invalidateDirectories();
    expect(store.directories()).toEqual({});
  });
});
