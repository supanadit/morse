import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ShellState } from '../../../state/shell-state';
import { ShortcutService } from '../../../services/shortcut.service';
import {
  SHORTCUTS,
  bindingLabel,
  isManagedShortcut,
  type ShortcutGroup,
  type ShortcutId,
} from '../../../services/shortcuts.catalog';
import { Dialog } from '../../../ui/dialog/dialog';

/** One printed row: the catalog entry, with its keys and whether it can run here. */
interface ShortcutRow {
  id: ShortcutId;
  label: string;
  detail: string;
  keys: string;
  /** `undefined` for a row the surface owns — nothing to promise or withdraw. */
  available: boolean | undefined;
}

/**
 * The keyboard help.
 *
 * It prints `SHORTCUTS` and asks `ShortcutService` which rows can actually run,
 * so the list is neither a second copy of the bindings nor a promise: a key whose
 * owner is not on screen (no models loaded, a host with a single project) is shown
 * as unavailable rather than offered.
 */
@Component({
  selector: 'morse-shortcuts-dialog',
  templateUrl: './shortcuts-dialog.html',
  imports: [Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './shortcuts-dialog.css',
})
export class ShortcutsDialog {
  private readonly shell = inject(ShellState);
  private readonly shortcuts = inject(ShortcutService);

  /**
   * The catalog in declaration order, grouped as a side effect of walking it —
   * there is no second ordering to keep in sync with `SHORTCUTS`.
   */
  protected readonly groups = computed<
    Array<{ name: ShortcutGroup; rows: ShortcutRow[] }>
  >(() => {
    const availability = this.shortcuts.available();
    const groups = new Map<ShortcutGroup, ShortcutRow[]>();
    for (const spec of SHORTCUTS) {
      const rows = groups.get(spec.group) ?? [];
      rows.push({
        id: spec.id,
        label: spec.label,
        detail: spec.detail,
        keys: isManagedShortcut(spec) ? bindingLabel(spec.binding) : spec.keys,
        available: isManagedShortcut(spec) ? availability.get(spec.id) === true : undefined,
      });
      groups.set(spec.group, rows);
    }
    return [...groups].map(([name, rows]) => ({ name, rows }));
  });

  protected close(): void {
    this.shell.closeShortcuts();
  }
}
