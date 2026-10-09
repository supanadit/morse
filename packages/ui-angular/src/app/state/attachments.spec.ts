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

  it('shows a whole-file chip for a focused editor with no selection', () => {
    const store = freshStore();
    store.setLivePreview({ path: 'src/service.ts' });
    expect(store.livePreview()).toEqual({ id: 'live-preview', path: 'src/service.ts' });
    // Choosing a range on the same file turns the chip into a range chip.
    store.setLivePreview({ path: 'src/service.ts', startLine: 10, endLine: 12 });
    expect(store.livePreview()).toMatchObject({ path: 'src/service.ts', startLine: 10, endLine: 12 });
    // Clearing the selection on the same file falls back to the whole-file chip.
    store.setLivePreview({ path: 'src/service.ts' });
    expect(store.livePreview()).toEqual({ id: 'live-preview', path: 'src/service.ts' });
  });

  it('hides when there is no editor at all, without touching locked pins', () => {
    const store = freshStore();
    store.pin({ path: 'src/service.ts', startLine: 154, endLine: 165 });
    store.setLivePreview({ path: 'src/other.ts', startLine: 3, endLine: 7 });

    // An empty path is the host's "no editor in front".
    store.setLivePreview({ path: '' });
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

  it('locks a whole-file preview as a whole-file pin', () => {
    const store = freshStore();
    store.setLivePreview({ path: 'src/service.ts' });
    store.lockLivePreview();

    expect(store.livePreview()).toBeNull();
    expect(store.pins()).toEqual([{ id: 'pin-1', path: 'src/service.ts' }]);
  });

  it('does not show a whole-file preview for a file already pinned whole', () => {
    const store = freshStore();
    store.pin({ path: 'src/service.ts' });
    // The host keeps reporting the focused file on every edit; the chip must not
    // come back as a duplicate of the pin.
    store.setLivePreview({ path: 'src/service.ts' });
    expect(store.livePreview()).toBeNull();
    expect(store.pins()).toHaveLength(1);
    // A range selection on the same file is still a new, distinct chip.
    store.setLivePreview({ path: 'src/service.ts', startLine: 4, endLine: 6 });
    expect(store.livePreview()).toMatchObject({ startLine: 4, endLine: 6 });
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

describe('AttachmentStore snapshot', () => {
  it('round-trips each draft and moves the id counter past the restored ones', () => {
    const store = freshStore();
    store.use('s1');
    store.pin({ path: 'a.ts', startLine: 1, endLine: 2 });
    store.addMentions(['b.ts']);

    const snapshot = store.snapshot();
    const restored = freshStore();
    restored.restore(snapshot);
    restored.use('s1');

    expect(restored.pins()).toHaveLength(1);
    expect(restored.mentions()).toEqual(['b.ts']);
    // `pin-1` came back, so the next pin is `pin-2`, not a colliding id.
    expect(restored.pin({ path: 'c.ts' })).toBe('pin-2');
  });

  it('drops a malformed saved set instead of throwing', () => {
    const store = freshStore();

    store.restore({
      s1: 'not a set',
      s2: { images: [{}], pins: [{ path: 'a.ts' }], mentions: [1] },
    });

    store.use('s1');
    expect(store.pins()).toEqual([]);
    store.use('s2');
    expect(store.pins()).toEqual([]);
    expect(store.mentions()).toEqual([]);
  });
});
describe('AttachmentStore annotations', () => {
  it('sends the note with the pin and drops blank ones', () => {
    const store = freshStore();
    store.use('s1');
    store.pin({ path: 'src/index.ts', startLine: 30, endLine: 31, note: ' fix the fallback loop ' });
    store.pin({ path: 'README.md', note: '   ' });

    expect(store.takePins()).toEqual([
      { path: 'src/index.ts', startLine: 30, endLine: 31, note: 'fix the fallback loop' },
      { path: 'README.md' },
    ]);
    // Sent pins are spent: the strip is empty for the next prompt.
    expect(store.pins()).toHaveLength(0);
  });

  it('sets one pin\u2019s annotation without touching its range', () => {
    const store = freshStore();
    store.use('s1');
    const id = store.pin({ path: 'src/index.ts', startLine: 30, endLine: 31 });

    store.setPinNote(id, 'fix the fallback loop');
    expect(store.pins()).toEqual([
      { id, path: 'src/index.ts', startLine: 30, endLine: 31, note: 'fix the fallback loop' },
    ]);

    store.setPinNote(id, '   ');
    expect(store.pins()).toEqual([{ id, path: 'src/index.ts', startLine: 30, endLine: 31 }]);
  });

  it('keeps a range edit\u2019s annotation when the chip is dragged again', () => {
    const store = freshStore();
    store.use('s1');
    const id = store.pin({ path: 'src/index.ts', startLine: 20, endLine: 40, note: 'the helper' });

    // Editing the same chip in place (the preview's drag) grows the range but
    // must not lose the words that already ride on it.
    store.setPinRange(id, { startLine: 15, endLine: 45 });
    expect(store.pins()[0]).toMatchObject({ startLine: 15, endLine: 45, note: 'the helper' });
  });

  it('unions the notes of coalesced chips in range order, without stutters', () => {
    const store = freshStore();
    store.use('s1');
    const first = store.pin({ path: 'src/index.ts', startLine: 5, endLine: 10, note: 'guards the top' });
    store.pin({ path: 'src/index.ts', startLine: 12, endLine: 20, note: 'guards the bottom' });
    const merged = store.pin({ path: 'src/index.ts', startLine: 5, endLine: 12, note: 'guards the top' });

    // The new pin touches the first chip and overlaps past it, so the merge has
    // to pull in the second one too (11..20 is reachable only on a second pass).
    const chip = store.pins().find((pin) => pin.id === first)!;
    expect(chip).toMatchObject({ startLine: 5, endLine: 20 });
    expect(chip.note).toBe('guards the top\nguards the bottom');
    expect(merged).toBe(first);
  });

  it('restores annotations with the pins a fork handed back', () => {
    const store = freshStore();
    store.use('s1');
    store.seed([], [
      { path: 'src/index.ts', startLine: 30, endLine: 31, note: 'fix the fallback loop' },
    ]);
    expect(store.pins()).toEqual([
      { id: 'pin-1', path: 'src/index.ts', startLine: 30, endLine: 31, note: 'fix the fallback loop' },
    ]);
  });

  it('round-trips an annotation through the saved-state snapshot', () => {
    const store = freshStore();
    store.use('s1');
    store.pin({ path: 'src/index.ts', startLine: 30, endLine: 31, note: 'fix the fallback loop' });
    const restored = freshStore();
    restored.restore(store.snapshot());
    restored.use('s1');
    expect(restored.pins()).toEqual(store.pins());
  });
});
