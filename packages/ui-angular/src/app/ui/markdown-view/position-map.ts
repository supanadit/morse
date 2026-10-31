/**
 * Rect in view coordinates (pixels relative to view container).
 */
export interface ViewRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PositionMapMetrics {
  lineHeight: number;
  charWidth: number;
  paddingLeft: number;
  paddingTop: number;
  paddingRight: number;
  containerWidth: number;
}

export interface PositionMapHiddenRange {
  start: number;
  end: number;
}

export interface PositionMapBlockRange {
  start: number;
  end: number;
  paddingTop?: number;
  paddingBottom?: number;
}

export interface PositionMapOptions {
  text: string;
  metrics: PositionMapMetrics;
  hiddenRanges?: PositionMapHiddenRange[];
  blockRanges?: PositionMapBlockRange[];
}

export interface PositionMapSlot {
  offset: number;
  line: number;
  col: number;
  rect: ViewRect;
  hidden: boolean;
}

/**
 * Maps buffer offsets to view coordinates and vice versa.
 *
 * Each character offset in the buffer is associated with a ViewRect.
 * For hidden ranges (such as collapsed fence lines), the view represents them as a
 * spacer line of standard line-height (or zero width at the collapsed coordinate)
 * so offsets remain monotonically mapped and round-trip faithfully.
 */
export class PositionMap {
  readonly text: string;
  readonly metrics: PositionMapMetrics;
  readonly hiddenRanges: PositionMapHiddenRange[];
  readonly blockRanges: PositionMapBlockRange[];
  private readonly slots: PositionMapSlot[] = [];
  private readonly lineStarts: number[] = [0];

  constructor(options: PositionMapOptions) {
    this.text = options.text;
    this.metrics = { ...options.metrics };
    this.hiddenRanges = options.hiddenRanges ? [...options.hiddenRanges] : [];
    this.blockRanges = options.blockRanges ? [...options.blockRanges] : [];
    this.build();
  }

  private isHidden(offset: number): boolean {
    return this.hiddenRanges.some((r) => offset >= r.start && offset < r.end);
  }

  private getBlock(offset: number): PositionMapBlockRange | undefined {
    return this.blockRanges.find((r) => offset >= r.start && offset <= r.end);
  }

  private build(): void {
    const { lineHeight, charWidth, paddingLeft, paddingTop, containerWidth } = this.metrics;
    const contentWidth = Math.max(charWidth, containerWidth - paddingLeft - this.metrics.paddingRight);
    const charsPerLine = Math.max(1, Math.floor(contentWidth / charWidth));

    let currentY = paddingTop;
    let currentX = paddingLeft;
    let lineIdx = 0;
    let colIdx = 0;

    for (let i = 0; i < this.text.length; i++) {
      const char = this.text[i];
      const hidden = this.isHidden(i);

      if (hidden) {
        // Hidden range character - collapsed / zero-width in view or sitting at current position
        this.slots.push({
          offset: i,
          line: lineIdx,
          col: colIdx,
          rect: {
            left: currentX,
            top: currentY,
            right: currentX,
            bottom: currentY + lineHeight,
            width: 0,
            height: lineHeight,
          },
          hidden: true,
        });

        if (char === '\n') {
          // If a newline is within a hidden range, the hidden line acts as a line spacer
          lineIdx++;
          colIdx = 0;
          currentX = paddingLeft;
          currentY += lineHeight;
          this.lineStarts.push(i + 1);
        }
        continue;
      }

      if (char === '\n') {
        this.slots.push({
          offset: i,
          line: lineIdx,
          col: colIdx,
          rect: {
            left: currentX,
            top: currentY,
            right: currentX + charWidth,
            bottom: currentY + lineHeight,
            width: charWidth,
            height: lineHeight,
          },
          hidden: false,
        });

        lineIdx++;
        colIdx = 0;
        currentX = paddingLeft;
        currentY += lineHeight;
        this.lineStarts.push(i + 1);
        continue;
      }

      // Check soft wrap
      if (colIdx >= charsPerLine) {
        lineIdx++;
        colIdx = 0;
        currentX = paddingLeft;
        currentY += lineHeight;
      }

      const rect: ViewRect = {
        left: currentX,
        top: currentY,
        right: currentX + charWidth,
        bottom: currentY + lineHeight,
        width: charWidth,
        height: lineHeight,
      };

      this.slots.push({
        offset: i,
        line: lineIdx,
        col: colIdx,
        rect,
        hidden: false,
      });

      currentX += charWidth;
      colIdx++;
    }

    // Trailing slot for position at text.length (the end of the buffer / cursor position)
    const endHidden = this.isHidden(this.text.length);
    const endRect: ViewRect = {
      left: currentX,
      top: currentY,
      right: currentX,
      bottom: currentY + lineHeight,
      width: 0,
      height: lineHeight,
    };
    this.slots.push({
      offset: this.text.length,
      line: lineIdx,
      col: colIdx,
      rect: endRect,
      hidden: endHidden,
    });
  }

  /**
   * Returns the bounding rectangle for the caret or character at `offset`.
   */
  bufferToRect(offset: number): ViewRect {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    const slot = this.slots[clamped];
    if (slot) {
      return { ...slot.rect };
    }
    const { lineHeight, paddingLeft, paddingTop } = this.metrics;
    return {
      left: paddingLeft,
      top: paddingTop,
      right: paddingLeft,
      bottom: paddingTop + lineHeight,
      width: 0,
      height: lineHeight,
    };
  }

  /**
   * Maps a view coordinate (x, y) back to the closest buffer offset.
   */
  viewToBuffer(x: number, y: number): number {
    if (this.slots.length === 0) {
      return 0;
    }

    const { lineHeight, paddingTop, paddingLeft } = this.metrics;

    // If click is above top padding
    if (y < paddingTop) {
      return 0;
    }

    // Find slots on the line matching y
    let bestSlot = this.slots[0];
    let minDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const { rect } = slot;

      // Check if point falls within vertical row
      const inVertical = y >= rect.top && y < rect.bottom;
      if (inVertical) {
        // If x is within the slot or closest to it
        const slotMidX = rect.left + rect.width / 2;
        const dist = Math.abs(x - slotMidX);
        if (dist < minDistance) {
          minDistance = dist;
          bestSlot = slot;
        }
      }
    }

    // If y is past the bottom of all slots, return end of buffer
    const lastSlot = this.slots[this.slots.length - 1];
    if (y >= lastSlot.rect.bottom) {
      return this.text.length;
    }

    if (minDistance === Number.POSITIVE_INFINITY) {
      // Find line closest to y
      let closestLineDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.slots.length; i++) {
        const slot = this.slots[i];
        const lineDist = Math.abs(y - (slot.rect.top + slot.rect.height / 2));
        if (lineDist < closestLineDist) {
          closestLineDist = lineDist;
          bestSlot = slot;
        }
      }
    }

    return bestSlot.offset;
  }

  /**
   * Total height required to display the view.
   */
  getTotalHeight(): number {
    if (this.slots.length === 0) {
      return this.metrics.paddingTop + this.metrics.lineHeight;
    }
    const lastSlot = this.slots[this.slots.length - 1];
    return lastSlot.rect.bottom + this.metrics.paddingTop;
  }
}
