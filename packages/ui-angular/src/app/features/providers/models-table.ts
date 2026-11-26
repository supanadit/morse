import {
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
} from '@angular/core';
import type { ModelInput, ProviderModel, ThinkingLevel } from '@morse/protocol';
import { ModelInputs, modelInputBadges } from '../model-picker/model-inputs';
import { BRAIN_PATHS } from '../thinking-picker/thinking-brain';

const INPUTS: readonly ModelInput[] = ['text', 'image', 'audio', 'video', 'pdf'];
const LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** One colour per level, the composer's own palette: louder is warmer. */
export const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  off: 'var(--morse-fg-muted)',
  minimal: 'var(--morse-info)',
  low: 'var(--morse-success)',
  medium: 'var(--morse-warn)',
  high: 'var(--morse-error)',
  xhigh: 'color-mix(in srgb, var(--morse-error) 55%, var(--morse-typename))',
  max: 'var(--morse-typename)',
};

/** An editable model row. Blank numbers stay blank so the engine keeps its default. */
interface ModelRow {
  id: string;
  name: string;
  context: string;
  output: string;
  input: Set<ModelInput>;
  reasoning: boolean;
  thinking: Set<ThinkingLevel>;
}

function toRow(model?: ProviderModel): ModelRow {
  const thinking = new Set<ThinkingLevel>(model?.thinkingLevels ?? []);
  for (const level of LEVELS) {
    if (model?.thinking?.[level] !== undefined && model.thinking[level] !== null) {
      thinking.add(level);
    }
  }
  return {
    id: model?.id ?? '',
    name: model?.name ?? '',
    context: model?.contextWindow === undefined ? '' : String(model.contextWindow),
    output: model?.maxTokens === undefined ? '' : String(model.maxTokens),
    input: new Set<ModelInput>(model?.input ?? []),
    reasoning: model?.reasoning ?? false,
    thinking,
  };
}

/** A row as engine data, including blank-id rows while they are typed in. */
function toModel(row: ModelRow): ProviderModel {
  const id = row.id.trim();
  const context = Number.parseInt(row.context, 10);
  const output = Number.parseInt(row.output, 10);
  // pi writes a level→value map; OpenCode writes variants. An empty set means
  // the engine's own default, so only an explicit range is written at all.
  const thinking: Partial<Record<ThinkingLevel, string | null>> = {};
  const thinkingLevels: ThinkingLevel[] = [];
  if (row.reasoning && row.thinking.size > 0) {
    for (const level of LEVELS) {
      const on = row.thinking.has(level);
      thinking[level] = on ? level : null;
      if (on) {
        thinkingLevels.push(level);
      }
    }
  }
  return {
    id,
    ...(row.name.trim().length > 0 ? { name: row.name.trim() } : {}),
    ...(Number.isFinite(context) && context > 0 ? { contextWindow: context } : {}),
    ...(Number.isFinite(output) && output > 0 ? { maxTokens: output } : {}),
    ...(row.input.size > 0 ? { input: [...row.input] } : {}),
    ...(row.reasoning ? { reasoning: true } : {}),
    ...(row.reasoning && row.thinking.size > 0 ? { thinking, thinkingLevels } : {}),
  };
}

/**
 * The shared per-model editor: an inline-edit table with popup multi-selects.
 * Settings custom endpoints and bot-local providers both mount it, so a fix to
 * capabilities or thinking lands in both places at once.
 */
@Component({
  selector: 'morse-models-table',
  imports: [ModelInputs],
  templateUrl: './models-table.html',
  styleUrl: './models-table.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModelsTable {
  /** The models to edit, as plain engine data. Every edit emits the whole list. */
  readonly models = input<ProviderModel[]>([]);
  readonly modelsChange = output<ProviderModel[]>();

  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly rows = signal<ModelRow[]>([]);
  /** The one open row popup, if any: capabilities multi-select or thinking list. */
  protected readonly openMenu = signal<{ row: number; kind: 'caps' | 'think' } | null>(null);
  /** Viewport rect of the trigger that opened it; the popup floats from here. */
  protected readonly menuAnchor = signal<{ top: number; bottom: number; left: number; right: number } | null>(null);

  /** Fixed position for the open popup, flipped inside the viewport when needed. */
  protected readonly menuPos = computed(() => {
    const menu = this.openMenu();
    const anchor = this.menuAnchor();
    if (!menu || !anchor) {
      return { top: 0, left: 0 };
    }
    const width = menu.kind === 'think' ? 250 : 210;
    const height = menu.kind === 'think' ? 210 : 220;
    const gap = 6;
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const left = Math.min(Math.max(menu.kind === 'think' ? anchor.right - width : anchor.left, margin), maxLeft);
    const below = anchor.bottom + gap;
    const top = below + height > window.innerHeight - margin
      ? Math.max(margin, anchor.top - gap - height)
      : below;
    return { top, left };
  });

  protected readonly levels = LEVELS;
  /** Modality rows for the capabilities popup, with the composer's own icons. */
  protected readonly badges = modelInputBadges(INPUTS);
  /** The thinking picker's brain, for the Reason row. */
  protected readonly brainPaths = BRAIN_PATHS;
  /** Brain colour per thinking level, the composer's own palette. */
  protected readonly levelColors = LEVEL_COLORS;

  constructor() {
    effect(() => {
      this.rows.set(this.models().map(toRow));
    });
    // A floating popup cannot follow its row while anything scrolls or the
    // viewport changes, so it dismisses instead of pointing stale.
    effect((onCleanup) => {
      if (!this.openMenu()) {
        return;
      }
      const close = (): void => this.closeMenu();
      document.addEventListener('scroll', close, true);
      window.addEventListener('resize', close);
      onCleanup(() => {
        document.removeEventListener('scroll', close, true);
        window.removeEventListener('resize', close);
      });
    });
  }

  /** Append a blank row for hand entry. */
  addModel(): void {
    this.rows.update((list) => [...list, toRow()]);
    this.emit();
  }

  protected removeModel(index: number): void {
    this.rows.update((list) => list.filter((_, at) => at !== index));
    this.openMenu.update((menu) => (menu !== null && menu.row === index ? null : menu));
    this.emit();
  }

  /** Update one editable field of a model row. */
  protected setModel(index: number, field: string, value: string | boolean): void {
    this.rows.update((list) =>
      list.map((row, at) => ({
        ...row,
        input: new Set(row.input),
        thinking: new Set(row.thinking),
        ...(at === index ? { [field]: value } : {}),
      }) as ModelRow),
    );
    this.emit();
  }

  /** Whether one row's popup of a kind is open. */
  protected menuOpen(row: number, kind: 'caps' | 'think'): boolean {
    const menu = this.openMenu();
    return menu !== null && menu.row === row && menu.kind === kind;
  }

  protected toggleMenu(row: number, kind: 'caps' | 'think', event?: MouseEvent): void {
    const menu = this.openMenu();
    if (menu !== null && menu.row === row && menu.kind === kind) {
      this.openMenu.set(null);
      this.menuAnchor.set(null);
      return;
    }
    const rect = (event?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
    this.menuAnchor.set(
      rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : null,
    );
    this.openMenu.set({ row, kind });
  }

  protected closeMenu(): void {
    this.openMenu.set(null);
    this.menuAnchor.set(null);
  }

  /** Click anywhere outside the panel's popups closes the open one. */
  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerdown(event: PointerEvent): void {
    const target = event.target as Node | null;
    if (this.openMenu() && target && !this.host.nativeElement.contains(target)) {
      this.closeMenu();
    }
  }

  protected toggleInput(index: number, input: ModelInput): void {
    this.rows.update((list) =>
      list.map((row, at) => {
        if (at !== index) {
          return { ...row, input: new Set(row.input), thinking: new Set(row.thinking) };
        }
        const next = new Set(row.input);
        if (next.has(input)) {
          next.delete(input);
        } else {
          next.add(input);
        }
        return { ...row, input: next, thinking: new Set(row.thinking) };
      }),
    );
    this.emit();
  }

  protected hasInput(index: number, input: ModelInput): boolean {
    return this.rows()[index]?.input.has(input) ?? false;
  }

  /** The selected modalities of a row, for the composer's icon badge. */
  protected capsList(index: number): ModelInput[] {
    return [...(this.rows()[index]?.input ?? [])];
  }

  protected toggleThinking(index: number, level: ThinkingLevel): void {
    this.rows.update((list) =>
      list.map((row, at) => {
        if (at !== index) {
          return { ...row, input: new Set(row.input), thinking: new Set(row.thinking) };
        }
        const next = new Set(row.thinking);
        if (next.has(level)) {
          next.delete(level);
        } else {
          next.add(level);
        }
        return { ...row, input: new Set(row.input), thinking: next };
      }),
    );
    this.emit();
  }

  /** Ordered picked levels of a row, for the comma-separated icon trigger. */
  protected thinkLevels(index: number): ThinkingLevel[] {
    const row = this.rows()[index];
    if (row === undefined) {
      return [];
    }
    return LEVELS.filter((level) => row.thinking.has(level));
  }

  /** Thinking label: Default, a span when contiguous, or the picked levels. */
  protected thinkLabel(index: number): string {
    const row = this.rows()[index];
    if (row === undefined || !row.reasoning) {
      return '—';
    }
    if (row.thinking.size === 0) {
      return 'Default';
    }
    const ordered = LEVELS.map((level, at) => (row.thinking.has(level) ? at : -1)).filter(
      (at) => at >= 0,
    );
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    if (last - first + 1 === ordered.length) {
      return ordered.length > 1 ? `${LEVELS[first]}–${LEVELS[last]}` : `${LEVELS[first]}`;
    }
    return ordered.map((at) => LEVELS[at]).join(', ');
  }

  /** Clear the range so the engine picks its own default levels. */
  protected resetThink(index: number): void {
    this.rows.update((list) =>
      list.map((row, at) =>
        at === index
          ? { ...row, input: new Set(row.input), thinking: new Set<ThinkingLevel>() }
          : { ...row, input: new Set(row.input), thinking: new Set(row.thinking) },
      ),
    );
    this.emit();
  }

  private emit(): void {
    this.modelsChange.emit(this.rows().map(toModel));
  }
}
