import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { MorseService } from '../../../host/morse.service';
import { sessionTaskList } from '@morse/ui-runtime';
import { TaskBoard } from '../transcript/tool-group/task-board';

/**
 * The session's task list, docked above the composer.
 *
 * pi's TUI shows a todo extension's list as a widget above the editor. Over RPC
 * that widget cannot arrive — the extension registers a component factory, which
 * pi's RPC mode drops before Morse ever sees it — so Morse reconstructs the
 * strip from the one place the state *does* cross: the tool results in the
 * transcript. A todo-style tool returns its whole list on every call, so the
 * newest task-shaped `details` is the live list.
 *
 * It is plugin-agnostic by construction: `sessionTaskList` decides by *shape*
 * (`details.tasks` of task rows), so no extension name is consulted and any
 * tracker that follows the convention lights up. Nothing to reconstruct means
 * nothing to show — the strip stays out of the layout.
 *
 * It belongs to the session in front: `items` are that session's, and a draft
 * has none. It disappears once there is no open work left (`open === 0`), which
 * is pi's own auto-hide rule.
 */
@Component({
  selector: 'morse-task-overlay',
  imports: [TaskBoard],
  templateUrl: './tasks.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './tasks.css',
})
export class TaskOverlay {
  private readonly morse = inject(MorseService);

  /**
   * The newest task list in the session in front, or `undefined`. Tombstoned
   * rows were already dropped by the selector, so this is the live list.
   */
  protected readonly list = computed(() => sessionTaskList(this.morse.items()));

  /**
   * Visible while the strip is worth a row: a list exists and something is still
   * open. A finished list auto-hides, like pi's own widget.
   */
  protected readonly visible = computed(() => {
    const list = this.list();
    return list !== undefined && list.open > 0;
  });

  protected readonly tasks = computed(() => this.list()?.tasks ?? []);

  /** The reader's fold choice, remembered per session so a switch is not lost. */
  private readonly collapsed = signal(false);

  /**
   * Re-open when a *new* list arrives (a fresh batch of work), so a strip the
   * reader folded earlier does not stay shut for the next task set. Keyed on the
   * task ids, which change when the list is replaced.
   */
  private readonly listKey = computed(() => this.tasks().map((task) => task.id).join(','));
  private lastKey: string | undefined;

  constructor() {
    effect(() => {
      const key = this.listKey();
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.collapsed.set(false);
      }
    });
  }

  protected toggle(): void {
    this.collapsed.update((value) => !value);
  }
}
