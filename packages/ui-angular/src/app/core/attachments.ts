import { Injectable, computed, signal } from '@angular/core';
import type { ChatPin, PromptImage } from '@morse/protocol';

/** One file the user attached but has not sent yet. */
export interface PendingImage {
  id: string;
  name: string;
  mimeType: string;
  /** Base64, without the `data:` prefix. */
  data: string;
  bytes: number;
}

/** An editor selection (or a file) pinned to the next message, shown as a chip. */
export interface PendingPin {
  id: string;
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface AcceptReport {
  attached: number;
  /** Names of files that cannot travel with a prompt. */
  skipped: string[];
}

/**
 * Attachments for the next prompt, owned outside the composer: a file can be
 * dropped anywhere in the chat, and the composer is the thing that sends it.
 *
 * Images become prompt attachments (pi accepts them as content blocks); anything
 * else that arrived as a path becomes an `@mention` in the prompt text, which is
 * how pi references files.
 */
@Injectable({ providedIn: 'root' })
export class AttachmentStore {
  private readonly attached = signal<PendingImage[]>([]);
  private readonly pinned = signal<PendingPin[]>([]);
  private readonly live = signal<PendingPin | null>(null);
  private readonly pendingMentions = signal<string[]>([]);
  private readonly message = signal<{ level: 'info' | 'warn'; text: string; at: number } | null>(
    null,
  );
  private counter = 0;

  readonly images = this.attached.asReadonly();
  /** Selection chips pinned to the next message (`+` picker / host command). */
  readonly pins = this.pinned.asReadonly();
  /**
   * The editor's current selection, reported live by the host: it is shown as
   * an unlocked chip that keeps following every selection change until the
   * user clicks it to lock it into `pins`.
   */
  readonly livePreview = this.live.asReadonly();
  readonly mentions = this.pendingMentions.asReadonly();
  readonly notice = this.message.asReadonly();
  readonly count = computed(
    () => this.attached().length + this.pinned().length + this.pendingMentions().length,
  );

  /**
   * Reads files without storing them, so the caller can animate them in first and
   * attach when they land.
   */
  async read(files: readonly File[]): Promise<{ images: PendingImage[]; skipped: string[] }> {
    const images: PendingImage[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        skipped.push(file.name);
        continue;
      }
      const data = await readBase64(file);
      if (!data) {
        skipped.push(file.name);
        continue;
      }
      this.counter += 1;
      images.push({
        id: `attachment-${this.counter}`,
        name: file.name || `image-${this.counter}.png`,
        mimeType: file.type,
        data,
        bytes: file.size,
      });
    }
    return { images, skipped };
  }

  /** Adds already-read images to the pending set. */
  add(images: readonly PendingImage[]): void {
    if (images.length === 0) {
      return;
    }
    this.attached.update((list) => [...list, ...images]);
  }

  /**
   * Reads files from a drop or a paste and keeps them. Images are inlined; other
   * files have no path in a browser, so they are reported as skipped instead of
   * silently disappearing.
   */
  async accept(files: readonly File[]): Promise<AcceptReport> {
    const { images, skipped } = await this.read(files);
    this.add(images);
    return { attached: images.length, skipped };
  }

  addMentions(paths: readonly string[]): void {
    const clean = paths.map((path) => path.trim()).filter((path) => path.length > 0);
    if (clean.length === 0) {
      return;
    }
    this.pendingMentions.update((list) => [...list, ...clean]);
  }

  /**
   * Restores a forked prompt's attachments. A fork hands the message back to
   * the composer, so its images and pins come with it instead of being lost
   * when the branch truncates the transcript.
   */
  seed(images: readonly PromptImage[], pins: readonly ChatPin[]): void {
    if (images.length > 0) {
      this.add(
        images.map((image, index) => {
          this.counter += 1;
          const subtype = image.mimeType.split('/')[1]?.toLowerCase() ?? '';
          const ext = subtype.replace(/[^a-z0-9]/g, '') || 'png';
          return {
            id: `seed-${this.counter}`,
            name: index === 0 ? `image.${ext}` : `image-${index + 1}.${ext}`,
            mimeType: image.mimeType,
            data: image.data,
            // Base64 carries 3 bytes per 4 characters; close enough for a chip.
            bytes: Math.floor((image.data.length * 3) / 4),
          };
        }),
      );
    }
    for (const pin of pins) {
      this.pin({ path: pin.path, startLine: pin.startLine, endLine: pin.endLine });
    }
  }

  /**
   * Moves a pin's range **without** merging. This is the live part of an edge
   * drag: while the pointer is down the ranges stay separate, so the neighbour a
   * boundary is being pushed into does not vanish mid-drag. The coalescing
   * happens on release (`pin(range, id)`), which keeps the whole union.
   */
  setPinRange(id: string, range: { startLine: number; endLine?: number }): void {
    this.pinned.update((list) =>
      list.map((item) =>
        item.id === id
          ? { ...item, startLine: range.startLine, endLine: range.endLine }
          : item,
      ),
    );
  }

  /**
   * Pins an editor selection (or file) as an attachment chip: it rides with the
   * next prompt as a `@path` mention, while the prompt text keeps only the
   * words the user typed.
   *
   * Line ranges are coalesced, the way a text editor treats a selection:
   * a range that overlaps or touches an existing one becomes **one** chip, and
   * `replaceId` (the chip the user dragged on again) is *edited in place* rather
   * than grown, so a highlight can be made smaller as well as bigger. A
   * whole-file pin (no lines) is a separate kind of chip and never merges.
   */
  pin(pin: Omit<PendingPin, 'id'>, replaceId?: string): void {
    if (pin.path.length === 0) {
      return;
    }

    if (pin.startLine === undefined) {
      const duplicate = this.pinned().some(
        (item) => item.path === pin.path && item.startLine === undefined,
      );
      if (duplicate) {
        return;
      }
      this.counter += 1;
      this.pinned.update((list) => [...list, { ...pin, id: `pin-${this.counter}` }]);
      return;
    }

    const list = this.pinned();
    let start = pin.startLine;
    let end = pin.endLine ?? pin.startLine;
    // The edited chip is dropped before the merge pass, so it does not absorb
    // its own old (possibly larger) bounds and pin them back.
    const absorbed = new Set<string>(replaceId === undefined ? [] : [replaceId]);
    // The first absorbed chip lends its id, so an edit or a merge keeps the chip's
    // identity (and its slot in the composer) instead of looking like a new one.
    let targetId: string | undefined;

    // Re-check after every growth: a merge can make the range touch another pin.
    let grew = true;
    while (grew) {
      grew = false;
      for (const item of list) {
        if (absorbed.has(item.id) || item.path !== pin.path || item.startLine === undefined) {
          continue;
        }
        const itemStart = item.startLine;
        const itemEnd = item.endLine ?? itemStart;
        if (itemStart <= end + 1 && itemEnd + 1 >= start) {
          start = Math.min(start, itemStart);
          end = Math.max(end, itemEnd);
          absorbed.add(item.id);
          targetId ??= item.id;
          grew = true;
        }
      }
    }

    this.counter += 1;
    const merged: PendingPin = {
      id: replaceId ?? targetId ?? `pin-${this.counter}`,
      path: pin.path,
      startLine: start,
      endLine: end > start ? end : undefined,
    };

    // Emit the merged chip once, where the first absorbed chip sat, so editing a
    // chip does not reshuffle the composer.
    const next: PendingPin[] = [];
    let placed = false;
    for (const item of list) {
      if (absorbed.has(item.id)) {
        if (!placed) {
          next.push(merged);
          placed = true;
        }
        continue;
      }
      next.push(item);
    }
    if (!placed) {
      next.push(merged);
    }
    this.pinned.set(next);
  }

  removePin(id: string): void {
    this.pinned.update((list) => list.filter((item) => item.id !== id));
  }

  /**
   * Replaces the live selection preview (a payload without lines means the
   * selection is gone). Field-level equality keeps a stream of identical
   * updates from churning the render while the numbers stay realtime.
   */
  setLivePreview(next: Omit<PendingPin, 'id'> | null): void {
    if (next === null || next.path.length === 0 || next.startLine === undefined) {
      this.live.set(null);
      return;
    }
    const current = this.live();
    if (
      current &&
      current.path === next.path &&
      current.startLine === next.startLine &&
      current.endLine === next.endLine
    ) {
      return;
    }
    this.live.set({
      id: 'live-preview',
      path: next.path,
      startLine: next.startLine,
      endLine: next.endLine,
    });
  }

  /**
   * Locks the live preview into a pin: it stops following new selections and
   * rides with the next prompt. Clicking the live chip is what calls this, so
   * locking is always the user's explicit move, never the host's.
   */
  lockLivePreview(): void {
    const current = this.live();
    if (!current) {
      return;
    }
    this.live.set(null);
    this.pin({ path: current.path, startLine: current.startLine, endLine: current.endLine });
  }

  remove(id: string): void {
    this.attached.update((list) => list.filter((item) => item.id !== id));
  }

  /** The images to send, cleared so the next prompt starts empty. */
  takeImages(): PromptImage[] {
    const images = this.attached().map(({ data, mimeType }) => ({ data, mimeType }));
    this.attached.set([]);
    return images;
  }

  /** The pins to send as the message's attachments, then cleared. */
  takePins(): ChatPin[] {
    const pins = this.pinned().map(({ path, startLine, endLine }) => {
      const wire: ChatPin = { path };
      if (startLine !== undefined) {
        wire.startLine = startLine;
      }
      if (endLine !== undefined) {
        wire.endLine = endLine;
      }
      return wire;
    });
    this.pinned.set([]);
    return pins;
  }

  /** Mentions waiting to be written into the prompt text. */
  takeMentions(): string[] {
    const mentions = this.pendingMentions();
    this.pendingMentions.set([]);
    return mentions;
  }

  clear(): void {
    this.attached.set([]);
    this.pinned.set([]);
    this.live.set(null);
    this.pendingMentions.set([]);
  }

  /** Short user-facing feedback, rendered as the app's toast. */
  say(level: 'info' | 'warn', text: string): void {
    this.message.set({ level, text, at: Date.now() });
  }
}

/** Reads a file as base64 without the `data:` prefix; `undefined` when it fails. */
export function readBase64(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (typeof FileReader === 'undefined') {
      resolve(undefined);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => resolve(undefined);
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        resolve(undefined);
        return;
      }
      // `data:image/png;base64,AAAA` -> `AAAA`
      const comma = result.indexOf(',');
      resolve(comma === -1 ? undefined : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}
