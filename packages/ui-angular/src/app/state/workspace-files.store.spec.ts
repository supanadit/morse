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
    store.setStatus(status);
    store.setError('Could not list this project.');

    expect(store.files()).toEqual(['a.ts']);
    expect(store.busy()).toBe(true);
    expect(store.status()).toBe(status);
    expect(store.error()).toBe('Could not list this project.');
  });
});
