import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { ModelOption } from '@morse/protocol';
import { EnterDirective } from '../../shared/enter.directive';
import { formatTokens } from '@morse/ui-runtime';
import { ModelInputs, modelInputKeywords } from './model-inputs';

export interface ModelGroup {
  provider: string;
  models: ModelOption[];
}

/**
 * Groups models by provider, dropping any that do not match the query.
 *
 * Provider grouping is the whole point: two providers can expose a model with
 * the same display name, so a flat list cannot tell them apart. Filtering keeps
 * a group when at least one of its models matches (the provider name itself
 * matches too, so `ollama` shows that provider's models). A modality matches
 * too, so `vision` narrows the list to the models that accept images.
 */
export function groupModels(models: readonly ModelOption[], filter: string): ModelGroup[] {
  const needle = filter.trim().toLowerCase();
  const groups = new Map<string, ModelOption[]>();
  for (const model of models) {
    if (needle.length > 0) {
      const haystack =
        `${model.provider} ${model.id} ${model.name} ${modelInputKeywords(model.input)}`.toLowerCase();
      if (!haystack.includes(needle)) {
        continue;
      }
    }
    const bucket = groups.get(model.provider);
    if (bucket) {
      bucket.push(model);
    } else {
      groups.set(model.provider, [model]);
    }
  }
  return [...groups].map(([provider, list]) => ({ provider, models: list }));
}

interface ModelRow {
  model: ModelOption;
  /** Index in the flattened, selectable order (group headers are skipped). */
  index: number;
}

/**
 * Model chooser: a search field, provider group headers, and one calm row per
 * model. Opened from the composer footer and from
 * the `/model` command; it owns its own filter and keyboard because focus moves
 * into the search box.
 */
@Component({
  selector: 'morse-model-picker',
  imports: [EnterDirective, ModelInputs],
  templateUrl: './model-picker.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
      }
      .panel {
        display: flex;
        flex-direction: column;
        max-height: var(--morse-popover-max-height, 340px);
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-md);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 12px 32px rgb(0 0 0 / 35%);
        overflow: hidden;
      }
      .search {
        position: relative;
        display: flex;
        align-items: center;
        padding: 8px 10px;
        border-bottom: 1px solid var(--morse-border);
      }
      /* Inside the field, where a search icon belongs. */
      .search-icon {
        position: absolute;
        left: 19px;
        display: inline-flex;
        color: var(--morse-fg-muted);
        pointer-events: none;
      }
      .search-icon svg {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.4;
        stroke-linecap: round;
      }
      /* Room for the icon, so the text never starts underneath it. */
      .search input {
        flex: 1;
        min-width: 0;
        padding-left: 28px;
        font-size: 12.5px;
      }
      .search input:focus-visible {
        outline: none;
      }
      .list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding-bottom: 4px;
      }
      .group {
        position: sticky;
        top: 0;
        padding: 8px 10px 4px;
        background: var(--morse-panel, var(--morse-bg));
        color: var(--morse-fg-muted);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      /*
       * Two lines: the model name and its selected check on top, the input
       * modalities and the context size below. One line per model forced the
       * badges and the token count to fight the name for the same run of
       * space, so every row read as a jumble.
       */
      .row {
        display: flex;
        flex-direction: column;
        gap: 1px;
        width: 100%;
        padding: 6px 10px;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--morse-fg);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .row.active,
      .row:hover {
        background: var(--morse-hover);
      }
      .row.selected {
        background: var(--morse-active);
      }
      .title,
      .details {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12.5px;
      }
      .details {
        /* Room for the widest badge row, so the names above stay aligned. */
        min-height: 13px;
      }
      .meta {
        margin-left: auto;
        color: var(--morse-fg-muted);
        font-size: 10.5px;
      }
      .check {
        flex: none;
        color: var(--morse-accent);
        font-size: 12px;
      }
      .empty {
        padding: 12px 10px;
        color: var(--morse-fg-muted);
        font-size: 12px;
      }
    `,
  ],
})
export class ModelPicker {
  readonly models = input.required<ModelOption[]>();
  /** `provider/id` of the active model, marked with a check. */
  readonly current = input('');
  readonly pick = output<ModelOption>();
  readonly close = output<void>();

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');
  protected readonly filter = signal('');
  protected readonly active = signal(0);

  /** Provider groups, each row carrying its index in the flattened order. */
  protected readonly groups = computed<{ provider: string; rows: ModelRow[] }[]>(() => {
    let index = 0;
    return groupModels(this.models(), this.filter()).map((group) => ({
      provider: group.provider,
      rows: group.models.map((model) => ({ model, index: index++ })),
    }));
  });
  protected readonly visible = computed(() =>
    this.groups().flatMap((group) => group.rows.map((row) => row.model)),
  );

  constructor() {
    afterNextRender(() => this.search()?.nativeElement.focus());

    /*
     * Opening the picker highlights the model that is actually active instead
     * of the first row. Without this, the highlight sat on whatever provider
     * happened to sort first, so the panel looked like it had selected the
     * wrong model and Enter re-picked that row. Only the unfiltered list does
     * this; while searching, the first match is the useful highlight.
     */
    effect(() => {
      this.groups();
      if (this.filter().trim().length > 0) {
        return;
      }
      const index = this.visible().findIndex((model) => this.keyOf(model) === this.current());
      if (index >= 0) {
        this.active.set(index);
      }
    });

    // Arrow keys move `active`; keep the highlighted row inside the list viewport.
    effect(() => {
      this.active();
      this.groups();
      setTimeout(() => this.revealActive(), 0);
    });
  }

  /** Nudges the active row into view, clearing the sticky provider headers. */
  private revealActive(): void {
    const container = this.list()?.nativeElement;
    const row = container?.querySelectorAll<HTMLElement>('.row')[this.active()];
    if (!container || !row) {
      return;
    }
    const view = container.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    const header = container.querySelector<HTMLElement>('.group')?.offsetHeight ?? 0;
    const top = view.top + header;
    if (rect.top < top) {
      container.scrollTop -= top - rect.top;
    } else if (rect.bottom > view.bottom) {
      container.scrollTop += rect.bottom - view.bottom;
    }
  }

  protected keyOf(model: ModelOption): string {
    return `${model.provider}/${model.id}`;
  }

  protected context(model: ModelOption): string {
    return model.contextWindow ? formatTokens(model.contextWindow) : '';
  }

  /**
   * Whether the second line has anything to say. A model pi described fully
   * (modalities and a context window) renders two lines; one with neither stays
   * a single line rather than an empty shelf under the name.
   */
  protected hasDetails(model: ModelOption): boolean {
    return (model.input?.length ?? 0) > 0 || model.contextWindow !== undefined;
  }

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
    // The highlighted row restarts at the top of the new result set.
    this.active.set(0);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const rows = this.visible();
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.close.emit();
        return;
      case 'ArrowDown':
        event.preventDefault();
        this.active.update((index) => Math.min(index + 1, Math.max(0, rows.length - 1)));
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.active.update((index) => Math.max(0, index - 1));
        return;
      case 'Enter': {
        const chosen = rows[this.active()];
        if (chosen) {
          event.preventDefault();
          this.pick.emit(chosen);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Click anywhere outside the panel closes it, like every other popover. */
  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerdown(event: PointerEvent): void {
    const target = event.target as Node | null;
    if (target && !this.host.nativeElement.contains(target)) {
      this.close.emit();
    }
  }
}
