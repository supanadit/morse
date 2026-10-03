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
 * One row of the composer palette: a slash command (built-in or from pi) or a
 * model in the `/model` sub-list.
 *
 * Presentational only, exactly like `morse-file-picker`: the composer owns the
 * keyboard and the filtering, so the caret never leaves the prompt.
 */
export interface PaletteItem {
  /** Opaque id the composer maps back to an action. */
  id: string;
  /** Primary label, e.g. `/new` or a model name. */
  label: string;
  description?: string;
  /** Small right-side badge: `built-in`, `skill`, `prompt`, `model`, ... */
  badge?: string;
  /** Single glyph shown before the label. */
  icon?: string;
}

@Component({
  selector: 'morse-command-picker',
  imports: [EnterDirective],
  templateUrl: './command-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
      }
      .picker {
        display: flex;
        flex-direction: column;
        max-height: var(--morse-popover-max-height, 320px);
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
      li button {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 5px 10px;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--morse-fg);
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }
      li button.active {
        background: var(--morse-active);
      }
      .icon {
        flex: none;
        width: 14px;
        color: var(--morse-fg-muted);
        text-align: center;
      }
      .text {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--morse-font-mono);
      }
      .description {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .badge {
        flex: none;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--morse-badge-bg);
        color: var(--morse-badge-fg);
        font-size: 10px;
      }
      .empty {
        padding: 8px 10px;
        color: var(--morse-fg-muted);
        font-size: 12px;
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
export class CommandPicker {
  /** Already-ranked rows; the composer owns filtering. */
  readonly items = input.required<PaletteItem[]>();
  /** Query typed after `/`, only used to phrase the "no match" state. */
  readonly query = input('');
  /** Highlighted row, owned by the composer so the prompt keeps the keyboard. */
  readonly active = input(0);

  readonly pick = output<string>();
  readonly close = output<void>();
  readonly activeChange = output<number>();

  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  constructor() {
    // The composer owns the keyboard, so nothing scrolls the list on its own and
    // the highlighted row can sit below the fold. Reveal it after the DOM settles.
    effect(() => {
      this.active();
      this.items();
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
}

/**
 * Rank like the mention list: a name that starts with the query first, then a
 * name that contains it, then a description hit. Mirrors `rankFiles`.
 */
export function rankPalette(
  items: readonly PaletteItem[],
  filter: string,
  limit = 50,
): PaletteItem[] {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) {
    return items.slice(0, limit);
  }
  return items
    .map((item) => ({ item, score: scorePalette(item, needle) }))
    .filter((entry) => entry.score < Number.POSITIVE_INFINITY)
    .sort((left, right) => left.score - right.score || left.item.label.length - right.item.label.length)
    .slice(0, limit)
    .map((entry) => entry.item);
}

function scorePalette(item: PaletteItem, needle: string): number {
  const label = item.label.toLowerCase();
  if (label.startsWith(needle)) {
    return 0;
  }
  if (label.includes(needle)) {
    return 1;
  }
  if (item.description?.toLowerCase().includes(needle)) {
    return 2;
  }
  return Number.POSITIVE_INFINITY;
}
