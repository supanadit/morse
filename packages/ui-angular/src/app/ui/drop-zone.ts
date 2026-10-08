import { Injectable, computed, inject, signal } from '@angular/core';
import { AttachmentStore } from '../state/attachments';
import { DropFlight } from './drop-flight';
import { Uploader } from '../services/uploads';

/**
 * Drag and drop for the whole chat surface: dragging files anywhere over the
 * chat highlights the drop target, and dropping them attaches images or writes
 * `@mentions` for whatever came as a path (a VS Code explorer drag).
 *
 * The counter matters: `dragleave` fires when the pointer crosses into a child
 * element, so a boolean would flicker the highlight off and on.
 */
@Injectable({ providedIn: 'root' })
export class DropZone {
  private readonly attachments = inject(AttachmentStore);
  private readonly flight = inject(DropFlight);
  private readonly uploads = inject(Uploader);
  private readonly depth = signal(0);
  /** Set while a drag that started in this document is in flight. */
  private internalDrag = false;

  constructor() {
    if (typeof document === 'undefined') {
      return;
    }
    // Capture phase: these fire for every drag in the page, including ours.
    const mark = (): void => {
      this.internalDrag = true;
    };
    const clear = (): void => {
      this.internalDrag = false;
    };
    document.addEventListener('dragstart', mark, true);
    document.addEventListener('dragend', clear, true);
    document.addEventListener('drop', clear, true);
  }

  readonly active = computed(() => this.depth() > 0);

  /**
   * True for a drag that came from outside this document.
   *
   * Type sniffing alone is not enough: a VS Code Source Control drag exposes only
   * `text/plain` to a webview (its own `ResourceURLs` and
   * `application/vnd.code.uri-list` types are hidden from a cross-origin frame),
   * so requiring `Files`/`text/uri-list` made those drops silently do nothing.
   * Instead anything dragged *into* us counts, and a drag that started inside the
   * chat (moving selected text around) is ignored.
   */
  private carriesFiles(event: DragEvent): boolean {
    if (this.internalDrag) {
      return false;
    }
    const types = event.dataTransfer?.types;
    return types !== undefined && types.length > 0;
  }

  onDragEnter(event: DragEvent): void {
    if (!this.carriesFiles(event)) {
      return;
    }
    event.preventDefault();
    this.depth.update((value) => value + 1);
  }

  onDragOver(event: DragEvent): void {
    if (!this.carriesFiles(event)) {
      return;
    }
    // Required, otherwise the browser refuses the drop and opens the file.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  onDragLeave(): void {
    this.depth.update((value) => Math.max(0, value - 1));
  }

  /**
   * `cwd` turns absolute paths into workspace-relative `@mentions`, which is what
   * pi resolves them against and what reads well in a prompt.
   */
  async onDrop(event: DragEvent, cwd?: string): Promise<void> {
    this.depth.set(0);
    if (!this.carriesFiles(event)) {
      return;
    }
    event.preventDefault();

    const transfer = event.dataTransfer;
    if (!transfer) {
      return;
    }

    const files = Array.from(transfer.files ?? []);
    const { images } = await this.attachments.read(
      files.filter((file) => file.type.startsWith('image/')),
    );

    // A VS Code drag arrives as a URI list or as a label, not as File objects
    // with paths, so every source is read.
    const entries = parseDrop(transfer);
    const nonImageFiles = files.filter((file) => !file.type.startsWith('image/'));

    // A browser cannot hand out a path, so a dropped File is uploaded to the
    // host (which owns the disk) and comes back as an `@mention`. A host without
    // uploads falls back to the bare name — all it used to get.
    const uploading =
      this.uploads.available() && nonImageFiles.length > 0
        ? this.uploads.upload(nonImageFiles)
        : Promise.resolve({ added: [], failed: nonImageFiles.map((file) => file.name) });
    const ghostMentions = [
      ...entries.paths.map((path) => relativeToWorkspace(path, cwd)),
      ...entries.names,
      ...nonImageFiles.map((file) => file.name),
    ];

    // Fly first, attach on landing: the chip appears exactly when the ghost
    // reaches the composer, which is what makes the drop feel like it landed.
    // A drop event without coordinates (synthetic or keyboard-driven) starts from
    // the middle of the chat instead of the top-left corner.
    const origin =
      event.clientX > 0 || event.clientY > 0
        ? { x: event.clientX, y: event.clientY }
        : fallbackOrigin();
    await this.flight.play(
      [
        ...images.map((image) => ({
          name: image.name,
          thumbnail: `data:${image.mimeType};base64,${image.data}`,
        })),
        ...ghostMentions.map((name) => ({ name })),
      ],
      origin,
    );

    const uploaded = await uploading;
    const mentionSources = [
      ...entries.paths.map((path) => relativeToWorkspace(path, cwd)),
      ...entries.names,
      ...uploaded.added.map((file) => file.path),
      ...uploaded.failed,
    ];

    this.attachments.add(images);
    this.attachments.addMentions(mentionSources);

    const parts: string[] = [];
    if (images.length > 0) {
      parts.push(`${images.length} image${images.length === 1 ? '' : 's'} attached`);
    }
    if (mentionSources.length > 0) {
      parts.push(`${mentionSources.length} file${mentionSources.length === 1 ? '' : 's'} added to the prompt`);
    }
    if (parts.length > 0) {
      this.attachments.say('info', parts.join(' · '));
      return;
    }
    // Naming the types turns "the drop did nothing" into something diagnosable.
    const observed = Array.from(transfer.types ?? []).join(', ') || 'none';
    this.attachments.say('warn', `That drop carried no file (types: ${observed}).`);
  }
}

function fallbackOrigin(): { x: number; y: number } {
  const chat = document.querySelector('main.chat');
  if (!chat) {
    return { x: 0, y: 0 };
  }
  const box = chat.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height * 0.35 };
}

/** What a drop carried, sorted by how usable it is. */
export interface DropEntries {
  /** Absolute paths (from a `file://` URI list or a plain path). */
  paths: string[];
  /** Bare file names, e.g. a Source Control item, to be resolved by the host. */
  names: string[];
}

/**
 * VS Code sets `text/uri-list` when dragging from the Explorer, but only
 * `text/plain` (plus types a cross-origin frame cannot read) when dragging from
 * Source Control. The private ones are read anyway: a host that does expose them
 * saves a guess.
 */
const URI_LIST_TYPES = [
  'application/vnd.code.uri-list',
  'ResourceURLs',
  'text/uri-list',
] as const;

export function parseDrop(transfer: DataTransfer): DropEntries {
  const lines: string[] = [];
  for (const type of [...URI_LIST_TYPES, 'text/plain']) {
    for (const line of expandPayload(transfer.getData(type))) {
      lines.push(line);
    }
  }

  const paths: string[] = [];
  const names: string[] = [];
  for (const line of lines) {
    if (line.startsWith('file://')) {
      const path = fileUriToPath(line);
      if (path) {
        paths.push(path);
      }
      continue;
    }
    if (/^[a-z]+:\/\//i.test(line)) {
      // A web URL is not a file we can mention.
      continue;
    }
    if (looksLikePath(line)) {
      paths.push(line);
      continue;
    }
    const name = fileNameFrom(line);
    if (name) {
      names.push(name);
    }
  }

  return { paths: Array.from(new Set(paths)), names: Array.from(new Set(names)) };
}

/** Backwards-compatible helper: the absolute paths a drop carried. */
export function dropPaths(transfer: DataTransfer): string[] {
  return parseDrop(transfer).paths;
}

/**
 * A payload can be a URI list, a JSON array (VS Code's private lists) or a single
 * value, depending on the source.
 */
function expandPayload(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => {
            if (typeof entry === 'string') {
              return entry;
            }
            const record = entry as { fsPath?: unknown; path?: unknown; uri?: unknown };
            const value = record.fsPath ?? record.uri ?? record.path;
            return typeof value === 'string' ? value : '';
          })
          .filter((value) => value.length > 0);
      }
    } catch {
      // Not JSON: fall through and treat it as plain lines.
    }
  }
  return splitEntries(trimmed);
}

/**
 * VS Code joins several dragged resources with a space (or `\r `), not a newline,
 * so entries are split on whitespace that is *followed by* an absolute path. A
 * space inside a path survives, because the remainder would not start with `/`.
 */
function splitEntries(value: string): string[] {
  return value
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=\S)\s+(?=[/\\]|[A-Za-z]:[\\/])/))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * A bare file name, as VS Code labels tree items: `service.ts (Working Tree)` and
 * `src/app.ts` both name a file, while a dragged code snippet does not.
 */
export function fileNameFrom(value: string): string | undefined {
  const withoutDecoration = value.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (withoutDecoration.length === 0 || withoutDecoration.length > 200) {
    return undefined;
  }
  if (/\s/.test(withoutDecoration) || withoutDecoration.includes(':')) {
    return undefined;
  }
  return /[^/\\]+\.[A-Za-z0-9]{1,8}$/.test(withoutDecoration) ? withoutDecoration : undefined;
}

/** Absolute POSIX/Windows paths, as dragged out of a terminal or editor. */
export function looksLikePath(value: string): boolean {
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    return true;
  }
  return false;
}

function fileUriToPath(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    return decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
}

/**
 * `@mentions` read better relative to the workspace, which is also what pi
 * resolves them against.
 */
export function relativeToWorkspace(path: string, cwd: string | undefined): string {
  if (!cwd) {
    return path;
  }
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}
