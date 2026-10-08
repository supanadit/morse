import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import { EnterDirective } from '../../../../ui/enter.directive';

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
  styleUrl: './command-picker.css',
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
