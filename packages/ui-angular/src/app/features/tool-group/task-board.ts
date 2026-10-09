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
  styleUrl: './task-board.css',
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
