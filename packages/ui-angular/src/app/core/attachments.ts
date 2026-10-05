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

/** The pending pieces of one composer draft: images, pins and mentions. */
export interface PendingSet {
  images: PendingImage[];
  pins: PendingPin[];
  mentions: string[];
}

const EMPTY_SET: PendingSet = { images: [], pins: [], mentions: [] };

/**
 * Attachments for the next prompt, owned outside the composer: a file can be
 * dropped anywhere in the chat, and the composer is the thing that sends it.
 *
 * Images become prompt attachments (pi accepts them as content blocks); anything
 * else that arrived as a path becomes an `@mention` in the prompt text, which is
 * how pi references files.
 *
 * The pending pieces are kept per composer draft (`use`), so switching to
 * another session tab carries the reader's attachments with it instead of
 * leaving them on the wrong message.
 */
@Injectable({ providedIn: 'root' })
export class AttachmentStore {
  /** Pending pieces per composer draft (a session or draft tab id). */
  private readonly sets = signal<Record<string, PendingSet>>({});
  /**
   * The draft the composer is editing. Everything below reads and writes this
   * key, so a half-typed message's attachments stay with their session instead
   * of following the reader to the next tab.
   */
  private readonly scope = signal('');
  private readonly live = signal<PendingPin | null>(null);
  private readonly message = signal<{ level: 'info' | 'warn'; text: string; at: number } | null>(
    null,
  );
  private counter = 0;

  readonly images = computed(() => this.current().images);
  /** Selection chips pinned to the next message (`+` picker / host command). */
  readonly pins = computed(() => this.current().pins);
  /**
   * The editor's current selection, reported live by the host: it is shown as
   * an unlocked chip that keeps following every selection change until the
   * user clicks it to lock it into `pins`.
   */
  readonly livePreview = this.live.asReadonly();
  readonly mentions = computed(() => this.current().mentions);
  readonly notice = this.message.asReadonly();
  readonly count = computed(
    () => this.images().length + this.pins().length + this.mentions().length,
  );

  /** Points the store at `key` (the composer draft in front). */
  use(key: string): void {
    if (key === this.scope()) {
      return;
    }
    this.scope.set(key);
    // A live selection belongs to the session that reported it: it must not
    // follow the reader to another tab.
    this.live.set(null);
  }

  /** True when `key`'s draft holds no pending attachments. */
  isEmpty(key: string): boolean {
    const set = this.sets()[key] ?? EMPTY_SET;
    return set.images.length === 0 && set.pins.length === 0 && set.mentions.length === 0;
  }

  /** Moves a draft's attachments when its tab is promoted to a real session. */
  rekey(from: string, to: string): void {
    const set = this.sets()[from];
    if (set === undefined) {
      return;
    }
    this.sets.update((map) => {
      const next = { ...map };
      delete next[from];
      next[to] = set;
      return next;
    });
    if (this.scope() === from) {
      this.scope.set(to);
    }
  }

  /** Drops a closed tab's attachments. */
  forget(key: string): void {
    if (!(key in this.sets())) {
      return;
    }
    this.sets.update((map) => {
      const next = { ...map };
      delete next[key];
      return next;
    });
  }

  /** Every draft's pending pieces, as the saved state keeps them. */
  snapshot(): Record<string, PendingSet> {
    const result: Record<string, PendingSet> = {};
    for (const [key, set] of Object.entries(this.sets())) {
      result[key] = {
        images: set.images.map((image) => ({ ...image })),
        pins: set.pins.map((pin) => ({ ...pin })),
        mentions: [...set.mentions],
      };
    }
    return result;
  }

  /**
   * Restores the saved attachments. The in-memory pieces win over the restored
   * ones, so a load that lands after the reader started attaching cannot clobber
   * them; the id counter moves past every restored id so a new chip never
   * collides with one that came back. The live preview is never restored — it
   * belonged to a selection that is gone.
   */
  restore(sets: unknown): void {
    const parsed = asAttachmentSets(sets);
    if (parsed === undefined) {
      return;
    }
    this.sets.update((current) => {
      const next: Record<string, PendingSet> = { ...parsed };
      for (const [key, set] of Object.entries(current)) {
        next[key] = set;
      }
      return next;
    });
    for (const set of Object.values(parsed)) {
      for (const piece of [...set.images, ...set.pins]) {
        this.counter = Math.max(this.counter, trailingNumber(piece.id));
      }
    }
    this.live.set(null);
  }

  /** The pending set of the draft in front. */
  private current(): PendingSet {
    return this.sets()[this.scope()] ?? EMPTY_SET;
  }

  /** Replaces fields of the draft in front, leaving the others alone. */
  private patch(change: Partial<PendingSet>): void {
    const key = this.scope();
    const base = this.sets()[key] ?? EMPTY_SET;
    this.sets.update((map) => ({ ...map, [key]: { ...base, ...change } }));
  }

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
    this.patch({ images: [...this.current().images, ...images] });
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
    this.patch({ mentions: [...this.current().mentions, ...clean] });
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
    this.patch({
      pins: this.current().pins.map((item) =>
        item.id === id
          ? { ...item, startLine: range.startLine, endLine: range.endLine }
          : item,
      ),
    });
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
  pin(pin: Omit<PendingPin, 'id'>, replaceId?: string): string {
    if (pin.path.length === 0) {
      return '';
    }

    if (pin.startLine === undefined) {
      const duplicate = this.current().pins.find(
        (item) => item.path === pin.path && item.startLine === undefined,
      );
      if (duplicate !== undefined) {
        return duplicate.id;
      }
      this.counter += 1;
      const id = `pin-${this.counter}`;
      this.patch({ pins: [...this.current().pins, { ...pin, id }] });
      return id;
    }

    const list = this.current().pins;
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
    this.patch({ pins: next });
    return merged.id;
  }

  removePin(id: string): void {
    this.patch({ pins: this.current().pins.filter((item) => item.id !== id) });
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
    this.patch({ images: this.current().images.filter((item) => item.id !== id) });
  }

  /** The images to send, cleared so the next prompt starts empty. */
  takeImages(): PromptImage[] {
    const images = this.current().images.map(({ data, mimeType }) => ({ data, mimeType }));
    this.patch({ images: [] });
    return images;
  }

  /** The pins to send as the message's attachments, then cleared. */
  takePins(): ChatPin[] {
    const pins = this.current().pins.map(({ path, startLine, endLine }) => {
      const wire: ChatPin = { path };
      if (startLine !== undefined) {
        wire.startLine = startLine;
      }
      if (endLine !== undefined) {
        wire.endLine = endLine;
      }
      return wire;
    });
    this.patch({ pins: [] });
    return pins;
  }

  /** Mentions waiting to be written into the prompt text. */
  takeMentions(): string[] {
    const mentions = this.current().mentions;
    this.patch({ mentions: [] });
    return mentions;
  }

  clear(): void {
    this.patch({ images: [], pins: [], mentions: [] });
    this.live.set(null);
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

/** The `N` in `attachment-N` / `pin-N`; 0 when the id has no trailing number. */
function trailingNumber(id: string): number {
  const match = /(\d+)$/.exec(id);
  return match === null ? 0 : Number.parseInt(match[1]!, 10);
}

/**
 * Validates a saved attachments map, dropping anything that is not a usable
 * pending set. A layout from an unknown version degrades to the draft keys that
 * still make sense instead of throwing at boot.
 */
function asAttachmentSets(value: unknown): Record<string, PendingSet> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, PendingSet> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const set = asPendingSet(entry);
    if (set !== undefined && !isEmptySet(set)) {
      result[key] = set;
    }
  }
  return result;
}

function asPendingSet(value: unknown): PendingSet | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const rawImages = candidate['images'];
  const rawPins = candidate['pins'];
  const rawMentions = candidate['mentions'];
  const images = Array.isArray(rawImages) ? rawImages.flatMap(asPendingImage) : [];
  const pins = Array.isArray(rawPins) ? rawPins.flatMap(asPendingPin) : [];
  const mentions = Array.isArray(rawMentions)
    ? rawMentions.filter((mention): mention is string => typeof mention === 'string')
    : [];
  return { images, pins, mentions };
}

function asPendingImage(value: unknown): PendingImage[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate['id'];
  const name = candidate['name'];
  const mimeType = candidate['mimeType'];
  const data = candidate['data'];
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof mimeType !== 'string' ||
    typeof data !== 'string'
  ) {
    return [];
  }
  const bytes = candidate['bytes'];
  return [{ id, name, mimeType, data, bytes: typeof bytes === 'number' ? bytes : 0 }];
}

function asPendingPin(value: unknown): PendingPin[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate['id'];
  const path = candidate['path'];
  if (typeof id !== 'string' || typeof path !== 'string') {
    return [];
  }
  const startLine = candidate['startLine'];
  const endLine = candidate['endLine'];
  return [
    {
      id,
      path,
      ...(typeof startLine === 'number' ? { startLine } : {}),
      ...(typeof endLine === 'number' ? { endLine } : {}),
    },
  ];
}

function isEmptySet(set: PendingSet): boolean {
  return set.images.length === 0 && set.pins.length === 0 && set.mentions.length === 0;
}
