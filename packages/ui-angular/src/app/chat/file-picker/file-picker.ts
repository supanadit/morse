import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import { EnterDirective } from '../../shared/enter.directive';

/**
 * In-webview file picker.
 *
 * VS Code does not deliver Explorer drags into a webview, so a frontend that only
 * supported drag and drop could not attach a file at all. The host lists workspace
 * files (`listFiles`) and the composer filters them while the user types `@…`
 * directly in the prompt — this component is a *presentational* list: it owns no
 * input and no keyboard, so the caret never leaves the prompt.
 */
@Component({
  selector: 'morse-file-picker',
  imports: [EnterDirective],
  templateUrl: './file-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
      }
      .picker {
        display: flex;
        flex-direction: column;
        max-height: var(--morse-popover-max-height, 300px);
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-md);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 10px 28px rgb(0 0 0 / 30%);
        overflow: hidden;
      }
      ul {
        margin: 0;
        padding: 4px 0;
        list-style: none;
        overflow-y: auto;
      }
      li {
        display: flex;
        align-items: center;
      }
      li .row {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--morse-fg);
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }
      li.active .row {
        background: var(--morse-active);
      }
      /*
       * The quote affordance: the row is a plain mention, and this second
       * target opens the file so a line range can be dragged into the prompt.
       */
      .quote {
        flex: none;
        width: 26px;
        height: 26px;
        margin-right: 4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 12px;
        cursor: pointer;
        opacity: 0.55;
      }
      .quote:hover:not(:disabled) {
        background: var(--morse-hover);
        color: var(--morse-fg);
        opacity: 1;
      }
      .icon {
        flex: none;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--morse-font-mono);
      }
      .dir {
        color: var(--morse-fg-muted);
      }
      .empty,
      .busy {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        color: var(--morse-fg-muted);
        font-size: 12px;
      }
      .reload {
        padding: 1px 8px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        font-size: 11px;
        cursor: pointer;
      }
      .reload:hover {
        background: var(--morse-hover);
      }
      .hint {
        padding: 5px 10px;
        border-top: 1px solid var(--morse-border);
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      kbd {
        font-family: var(--morse-font-mono);
        font-size: 10px;
        padding: 0 3px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
      }
    `,
  ],
})
export class FilePicker {
  /** The already-ranked rows to show; the composer owns filtering. */
  readonly files = input.required<string[]>();
  readonly busy = input(false);
  /** Query typed after `@`, only used to phrase the "no match" state. */
  readonly query = input('');
  /** Highlighted row, owned by the composer so the prompt keeps the keyboard. */
  readonly active = input(0);

  readonly pick = output<string>();
  /** A row's quote target: mention it *and* open it to drag a line range. */
  readonly quote = output<string>();
  readonly close = output<void>();
  /** Ask the host for the list again (a cold cache, a new branch, ...). */
  readonly reload = output<void>();
  readonly activeChange = output<number>();

  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  constructor() {
    // The composer owns the keyboard, so nothing scrolls the list on its own and
    // the highlighted row can sit below the fold. Reveal it after the DOM settles.
    effect(() => {
      this.active();
      this.files();
      setTimeout(() => this.revealActive(), 0);
    });
  }

  /** Nudges the active row into the list viewport without scrolling the page. */
  private revealActive(): void {
    const container = this.list()?.nativeElement;
    const row = container?.children.item(this.active()) as HTMLElement | null;
    if (!container || !row) {
      return;
    }
    const view = container.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < view.top) {
      container.scrollTop -= view.top - rect.top;
    } else if (rect.bottom > view.bottom) {
      container.scrollTop += rect.bottom - view.bottom;
    }
  }

  protected split(path: string): { dir: string; base: string } {
    const cut = path.lastIndexOf('/');
    return cut === -1
      ? { dir: '', base: path }
      : { dir: path.slice(0, cut + 1), base: path.slice(cut + 1) };
  }

  protected isDirectory(path: string): boolean {
    return isDirectory(path);
  }
}

/**
 * Rank like pi's mention list: directories first (so a folder is one Enter away),
 * then the top hits for the query, capped so a picker never renders thousands of
 * rows. A directory is a path with a trailing `/`, matching pi's completion.
 */
export function rankFiles(files: readonly string[], filter: string, limit = 50): string[] {
  const needle = filter.trim().toLowerCase();
  return files
    .map((file) => ({ file, score: needle.length === 0 ? 0 : scoreMatch(file, needle) }))
    .filter((entry) => entry.score < Number.POSITIVE_INFINITY)
    .sort(
      (left, right) =>
        directoryRank(left.file) - directoryRank(right.file) ||
        left.score - right.score ||
        left.file.length - right.file.length ||
        left.file.localeCompare(right.file),
    )
    .slice(0, limit)
    .map((entry) => entry.file);
}

/** True for an entry the host marked as a directory (trailing slash). */
export function isDirectory(path: string): boolean {
  return path.endsWith('/');
}

function directoryRank(path: string): number {
  return isDirectory(path) ? 0 : 1;
}

/**
 * Score of one entry: a name match comes first, and among equals the shallower
 * path wins — so `readme` puts `README.md` above `packages/extension/README.md`,
 * and `docs` puts the `docs/` directory above `docs/INSTALL.md`.
 */
export function scoreMatch(file: string, needle: string): number {
  const lower = (isDirectory(file) ? file.slice(0, -1) : file).toLowerCase();
  const cut = lower.lastIndexOf('/');
  const name = cut === -1 ? lower : lower.slice(cut + 1);
  if (name.startsWith(needle)) {
    return 0;
  }
  if (name.includes(needle)) {
    return 1;
  }
  if (lower.startsWith(needle)) {
    return 2;
  }
  if (lower.includes(needle)) {
    return 3;
  }
  return Number.POSITIVE_INFINITY;
}
