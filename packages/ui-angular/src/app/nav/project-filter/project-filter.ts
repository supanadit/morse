import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { EnterDirective } from '../../shared/enter.directive';

/** One project as the filter needs it: what to show, and how much is inside. */
export interface ProjectOption {
  path: string;
  name: string;
  sessionCount: number;
}

/** A row in the panel. `path: ''` is the "every project" row. */
export interface ProjectRow extends ProjectOption {
  /** True for the row that clears the filter. */
  all: boolean;
}

export const ALL_PROJECTS = 'All projects';

/**
 * Rows for the panel: the "all projects" row first, then the projects a query
 * matches (name or path).
 *
 * The first row is never filtered out. It is the way back to the full list, and
 * hiding it exactly when the reader is hunting for one project would strand them
 * in a filter with no obvious exit.
 */
export function projectRows(
  projects: readonly ProjectOption[],
  query: string,
  totalSessions: number,
): ProjectRow[] {
  const all: ProjectRow = { path: '', name: ALL_PROJECTS, sessionCount: totalSessions, all: true };
  const needle = query.trim().toLowerCase();
  const rows = projects
    .filter(
      (project) =>
        needle.length === 0 || `${project.name} ${project.path}`.toLowerCase().includes(needle),
    )
    .map((project) => ({ ...project, all: false }));
  return [all, ...rows];
}

/**
 * The sidebar's project filter: pick one project, or all of them.
 *
 * The search box below the session list searches *session titles* — a project name
 * typed there used to match the group and then show "No sessions yet" under it,
 * which read as "this project is empty". Projects get their own control, and this
 * one is searchable because "in case the reader has many projects" is the normal
 * case, not the edge case.
 *
 * It opens as a centred modal rather than an anchored dropdown: the sidebar is
 * ~270px wide, and a panel wedged under a chip in it was cramped and off-key with
 * the rest of the app, which asks its questions in the middle (project picker,
 * About, the compaction gate) and gets a full-size list to answer them in.
 */
@Component({
  selector: 'morse-project-filter',
  imports: [EnterDirective],
  templateUrl: './project-filter.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: contents;
      }
      .modal-layer {
        position: fixed;
        inset: 0;
        z-index: 65;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgb(0 0 0 / 45%);
      }
      .modal-card {
        display: flex;
        flex-direction: column;
        width: min(520px, 100%);
        max-height: min(640px, 90vh);
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-lg);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 18px 48px rgb(0 0 0 / 40%);
        overflow: hidden;
      }
      .modal-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--morse-border);
      }
      .modal-head strong {
        flex: 1;
        min-width: 0;
        font-size: 13px;
      }
      .modal-head .close {
        padding: 2px 8px;
        border: 0;
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
      }
      .modal-head .close:hover {
        color: var(--morse-fg);
      }
      .search {
        position: relative;
        display: flex;
        align-items: center;
        padding: 10px 14px;
        border-bottom: 1px solid var(--morse-border);
      }
      /* Inside the field, where a search icon belongs. */
      .search-icon {
        position: absolute;
        left: 23px;
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
        padding-left: 30px;
        font-size: 12.5px;
      }
      .list {
        flex: 1;
        min-height: 120px;
        overflow-y: auto;
        padding: 4px 6px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 8px;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: transparent;
        color: var(--morse-fg);
        font: inherit;
        font-size: 12.5px;
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
      /*
       * The "all projects" row is the exit from a filter, so it is separated from
       * the projects by a hairline instead of blending into the list.
       */
      .row.all {
        margin-bottom: 4px;
        border-bottom: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm) var(--morse-radius-sm) 0 0;
      }
      .name {
        /* Natural width: the project name is short, the path is not. */
        flex: 0 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /*
       * The path takes the rest of the row, truncated at the end. It used to be
       * direction: rtl (to keep the tail — the folder name — visible), but with a
       * leading slash the mirroring moved it to the end, so /work/morse read as
       * work/morse/. The name column already says which project this is; the path
       * is only context, so it reads normally and loses its tail.
       */
      .path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .count {
        flex: none;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .check {
        flex: none;
        color: var(--morse-accent);
        font-size: 12px;
      }
      .empty {
        padding: 12px 8px;
        color: var(--morse-fg-muted);
        font-size: 12px;
      }
    `,
  ],
})
export class ProjectFilter {
  /** Every project the host knows, in the order the sidebar shows them. */
  readonly projects = input.required<ProjectOption[]>();
  /** The project path currently filtering the list; `''` means all of them. */
  readonly selected = input('');
  /** Sessions across every project, for the first row. */
  readonly totalSessions = input(0);

  readonly select = output<string>();
  readonly close = output<void>();

  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');  protected readonly query = signal('');
  protected readonly active = signal(0);

  protected readonly rows = computed(() =>
    projectRows(this.projects(), this.query(), this.totalSessions()),
  );

  constructor() {
    // Focus moves into the panel: typing is the point of a searchable filter.
    afterNextRender(() => this.search()?.nativeElement.focus());

    // Opening on the current project (or on the first row when nothing is chosen)
    // means Enter never picks a project the reader did not look at.
    effect(() => {
      if (this.query().trim().length > 0) {
        return;
      }
      const index = this.rows().findIndex((row) => row.path === this.selected());
      if (index >= 0) {
        this.active.set(index);
      }
    });

    // Arrow keys move the highlight; keep it inside the panel's viewport.
    effect(() => {
      this.active();
      this.rows();
      setTimeout(() => this.revealActive(), 0);
    });
  }

  private revealActive(): void {
    const container = this.list()?.nativeElement;
    const row = container?.querySelectorAll<HTMLElement>('.row')[this.active()];
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

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.active.set(0);
  }

  protected pick(row: ProjectRow): void {
    this.select.emit(row.path);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const rows = this.rows();
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
          this.pick(chosen);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Click anywhere outside the card closes it, like every other dialog. */
  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.close.emit();
  }
}
