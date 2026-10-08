import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { taskCounts, type TaskRow } from '@morse/ui-runtime';

/**
 * A task list a tool returned, drawn from the structured `details` of its
 * result. Purely presentational: it renders whatever `asTaskList` accepted, so
 * it is not tied to any one todo extension — the probe decides, this draws.
 *
 * Status is shown with a glyph + label, never color alone, so it reads at a
 * glance and in a high-contrast theme.
 */
@Component({
  selector: 'morse-task-board',
  templateUrl: './task-board.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
        font-family: var(--morse-font-mono);
        font-size: 11.5px;
      }
      .head {
        display: flex;
        align-items: baseline;
        gap: 6px;
        color: var(--morse-fg-muted);
        margin-bottom: 3px;
      }
      .head b {
        color: var(--morse-fg);
        font-weight: 600;
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .task {
        display: flex;
        align-items: baseline;
        gap: 6px;
        color: var(--morse-fg);
        line-height: 1.5;
      }
      .task.completed .subject {
        color: var(--morse-fg-muted);
        text-decoration: line-through;
      }
      .task.deleted {
        opacity: 0.55;
      }
      .glyph {
        flex: none;
      }
      .task.pending .glyph {
        color: var(--morse-fg-muted);
      }
      .task.in_progress .glyph {
        color: var(--morse-accent, var(--morse-fg));
      }
      .task.completed .glyph {
        color: var(--morse-success, var(--morse-fg-muted));
      }
      .id {
        flex: none;
        color: var(--morse-fg-muted);
        opacity: 0.75;
      }
      .subject {
        overflow-wrap: anywhere;
      }
      .task.in_progress .subject {
        font-weight: 600;
      }
      .form {
        color: var(--morse-fg-muted);
        font-style: italic;
      }
      .deps {
        color: var(--morse-fg-muted);
        flex: none;
      }
    `,
  ],
})
export class TaskBoard {
  readonly tasks = input.required<readonly TaskRow[]>();
  /**
   * Suppress the `Tasks · n/m done` heading. The persistent overlay draws its own
   * header (with a collapse control), so it asks for the rows alone; the inline
   * tool body keeps the heading that names the list.
   */
  readonly headless = input(false);

  protected readonly counts = computed(() => taskCounts(this.tasks()));

  protected glyph(status: TaskRow['status']): string {
    switch (status) {
      case 'completed':
        return '✓';
      case 'in_progress':
        return '◐';
      case 'deleted':
        return '✕';
      default:
        return '○';
    }
  }

  /** `⛓ 1, 2` — the ids this task is blocked by. */
  protected blockList(ids: readonly number[]): string {
    return ids.map((id) => `#${id}`).join(', ');
  }
}
