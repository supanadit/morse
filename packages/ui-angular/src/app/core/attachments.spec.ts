import { describe, expect, it } from 'vitest';
import { AttachmentStore } from './attachments';

/** The store is plain signals, so it is constructed directly here. */
function freshStore(): AttachmentStore {
  return new AttachmentStore();
}

describe('AttachmentStore.setLivePreview', () => {
  it('shows a live chip and keeps moving it with every selection', () => {
    const store = freshStore();
    store.setLivePreview({ path: 'src/service.ts', startLine: 154, endLine: 165 });
    expect(store.livePreview()).toEqual({
      id: 'live-preview',
      path: 'src/service.ts',
      startLine: 154,
      endLine: 165,
    });

    // The same chip, new numbers: it updates in place instead of stacking up.
    store.setLivePreview({ path: 'src/service.ts', startLine: 152, endLine: 164 });
    expect(store.livePreview()).toMatchObject({ startLine: 152, endLine: 164 });
    store.setLivePreview({ path: 'src/other.ts', startLine: 3, endLine: 7 });
    expect(store.livePreview()).toMatchObject({ path: 'src/other.ts', startLine: 3, endLine: 7 });
    expect(store.pins()).toHaveLength(0);
  });

  it('hides when the selection is gone, without touching locked pins', () => {
    const store = freshStore();
    store.pin({ path: 'src/service.ts', startLine: 154, endLine: 165 });
    store.setLivePreview({ path: 'src/other.ts', startLine: 3, endLine: 7 });

    // A payload without lines is the host's "selection disappeared".
    store.setLivePreview({ path: 'src/other.ts' });
    expect(store.livePreview()).toBeNull();
    expect(store.pins()).toHaveLength(1);

    store.setLivePreview(null);
    expect(store.livePreview()).toBeNull();
  });

  it('stays empty for malformed previews (no path, no lines)', () => {
    const store = freshStore();
    store.setLivePreview({ path: '' , startLine: 1, endLine: 2 });
    expect(store.livePreview()).toBeNull();
  });
});

describe('AttachmentStore.lockLivePreview', () => {
  it('turns the live preview into a pin and clears the preview', () => {
    const store = freshStore();
    store.setLivePreview({ path: 'src/service.ts', startLine: 154, endLine: 165 });
    store.lockLivePreview();

    expect(store.livePreview()).toBeNull();
    expect(store.pins()).toEqual([
      { id: 'pin-1', path: 'src/service.ts', startLine: 154, endLine: 165 },
    ]);
  });

  it('does nothing when nothing is live', () => {
    const store = freshStore();
    store.lockLivePreview();
    expect(store.pins()).toHaveLength(0);
  });

  it('keeps one chip per distinct range, so two unlocked selections do not collide', () => {
    const store = freshStore();
    store.setLivePreview({ path: 'src/service.ts', startLine: 152, endLine: 164 });
    store.lockLivePreview();
    // The user selects again while the first chip is locked: a new live chip.
    store.setLivePreview({ path: 'src/service.ts', startLine: 171, endLine: 179 });
    store.lockLivePreview();

    expect(store.pins()).toHaveLength(2);
    // Locking the exact range that is already pinned adds nothing.
    store.setLivePreview({ path: 'src/service.ts', startLine: 152, endLine: 164 });
    store.lockLivePreview();
    expect(store.pins()).toHaveLength(2);
  });
});

describe('AttachmentStore.clear', () => {
  it('clears the live preview too', () => {
    const store = freshStore();
    store.setLivePreview({ path: 'src/service.ts', startLine: 154, endLine: 165 });
    store.clear();
    expect(store.livePreview()).toBeNull();
  });
});