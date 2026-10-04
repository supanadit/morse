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

describe('AttachmentStore per-draft scoping', () => {
  it('keeps each draft\u2019s pending pieces apart', () => {
    const store = freshStore();
    store.use('s1');
    store.addMentions(['a.ts']);
    store.use('s2');
    store.addMentions(['b.ts']);

    expect(store.mentions()).toEqual(['b.ts']);
    store.use('s1');
    expect(store.mentions()).toEqual(['a.ts']);
  });

  it('reports which drafts are empty', () => {
    const store = freshStore();
    store.use('s1');
    store.addMentions(['a.ts']);

    expect(store.isEmpty('s1')).toBe(false);
    expect(store.isEmpty('s2')).toBe(true);
  });

  it('moves a draft\u2019s attachments when its tab becomes a session', () => {
    const store = freshStore();
    store.use('draft-1');
    store.addMentions(['a.ts']);

    store.rekey('draft-1', 's1');

    expect(store.isEmpty('draft-1')).toBe(true);
    store.use('s1');
    expect(store.mentions()).toEqual(['a.ts']);
  });

  it('drops a closed tab\u2019s attachments', () => {
    const store = freshStore();
    store.use('s1');
    store.addMentions(['a.ts']);

    store.forget('s1');
    store.use('s1');

    expect(store.mentions()).toEqual([]);
    expect(store.isEmpty('s1')).toBe(true);
  });
});

describe('AttachmentStore.pin coalescing', () => {
  it('edits the same range instead of stacking a second chip', () => {
    const store = freshStore();
    store.pin({ path: 'src/main.ts', startLine: 10, endLine: 12 });
    const first = store.pins()[0].id;

    store.pin({ path: 'src/main.ts', startLine: 10, endLine: 12 });

    expect(store.pins()).toHaveLength(1);
    expect(store.pins()[0].id).toBe(first);
  });

  it('merges a range that touches another into one chip', () => {
    const store = freshStore();
    store.pin({ path: 'src/main.ts', startLine: 10, endLine: 12 });
    store.pin({ path: 'src/main.ts', startLine: 13, endLine: 15 });

    expect(store.pins()).toHaveLength(1);
    expect(store.pins()[0]).toMatchObject({ startLine: 10, endLine: 15 });
  });

  it('merges overlapping ranges too', () => {
    const store = freshStore();
    store.pin({ path: 'src/main.ts', startLine: 10, endLine: 15 });
    store.pin({ path: 'src/main.ts', startLine: 12, endLine: 20 });

    expect(store.pins()).toHaveLength(1);
    expect(store.pins()[0]).toMatchObject({ startLine: 10, endLine: 20 });
  });

  it('keeps a chain of touching pins apart only until the link arrives', () => {
    const store = freshStore();
    store.pin({ path: 'src/main.ts', startLine: 1, endLine: 2 });
    store.pin({ path: 'src/main.ts', startLine: 5, endLine: 6 });
    expect(store.pins()).toHaveLength(2);

    // Bridging the gap merges all three into one range.
    store.pin({ path: 'src/main.ts', startLine: 3, endLine: 4 });
    expect(store.pins()).toHaveLength(1);
    expect(store.pins()[0]).toMatchObject({ startLine: 1, endLine: 6 });
  });

  it('keeps disjoint ranges on different files separate', () => {
    const store = freshStore();
    store.pin({ path: 'src/main.ts', startLine: 1, endLine: 2 });
    store.pin({ path: 'src/other.ts', startLine: 1, endLine: 2 });
    store.pin({ path: 'src/main.ts', startLine: 10, endLine: 11 });

    expect(store.pins()).toHaveLength(3);
  });

  it('edits a pin in place when given its id, so a highlight can shrink', () => {
    const store = freshStore();
    store.pin({ path: 'src/main.ts', startLine: 10, endLine: 20 });
    const id = store.pins()[0].id;

    store.pin({ path: 'src/main.ts', startLine: 12, endLine: 14 }, id);

    expect(store.pins()).toHaveLength(1);
    expect(store.pins()[0]).toMatchObject({ id, startLine: 12, endLine: 14 });
  });

  it('never merges a whole-file pin with a line range', () => {
    const store = freshStore();
    store.pin({ path: 'src/main.ts' });
    store.pin({ path: 'src/main.ts', startLine: 1, endLine: 2 });

    expect(store.pins()).toHaveLength(2);
  });

  it('moves a range without merging its neighbour (the live edge drag)', () => {
    const store = freshStore();
    store.pin({ path: 'src/main.ts', startLine: 1, endLine: 2 });
    store.pin({ path: 'src/main.ts', startLine: 5, endLine: 6 });
    const id = store.pins()[0].id;

    store.setPinRange(id, { startLine: 1, endLine: 4 });

    // Both chips survive the move; the neighbour is untouched.
    expect(store.pins()).toHaveLength(2);
    expect(store.pins()[0]).toMatchObject({ startLine: 1, endLine: 4 });
    expect(store.pins()[1]).toMatchObject({ startLine: 5, endLine: 6 });
  });

  it('coalesces on release, keeping the union of both ranges', () => {
    const store = freshStore();
    store.pin({ path: 'src/main.ts', startLine: 1, endLine: 2 });
    store.pin({ path: 'src/main.ts', startLine: 5, endLine: 6 });
    const id = store.pins()[0].id;
    store.setPinRange(id, { startLine: 1, endLine: 4 });

    store.pin({ path: 'src/main.ts', startLine: 1, endLine: 4 }, id);

    expect(store.pins()).toHaveLength(1);
    // The merged chip spans both, so no range's length is lost.
    expect(store.pins()[0]).toMatchObject({ id, startLine: 1, endLine: 6 });
  });
});