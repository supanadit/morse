import { describe, expect, it } from 'vitest';
import { railSlots } from './rail';

describe('railSlots', () => {
  it('places one card at its anchor', () => {
    expect(railSlots([100], [40])).toEqual([{ top: 100, height: 40 }]);
  });
  it('pushes a card down when the previous one would overlap', () => {
    expect(railSlots([100, 110], [40, 30], 6)).toEqual([
      { top: 100, height: 40 },
      { top: 146, height: 30 },
    ]);
  });
  it('keeps the anchor when there is room', () => {
    expect(railSlots([100, 300], [40, 30], 6)[1]).toEqual({ top: 300, height: 30 });
  });
  it('drops a card whose line could not be measured (Review Focus 3)', () => {
    expect(railSlots([100, null], [40, 30])).toEqual([{ top: 100, height: 40 }, null]);
  });
  it('stays linear and non-overlapping with 200 pins (Review Focus 4)', () => {
    const anchors = Array.from({ length: 200 }, (_, i) => i * 4);
    const slots = railSlots(anchors, Array.from({ length: 200 }, () => 30), 6);
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.top).toBeGreaterThanOrEqual(slots[i - 1]!.top + 30 + 6);
    }
  });
});
