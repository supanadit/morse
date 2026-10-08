import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { ShellState } from '../../../state/shell-state';
import { ShortcutService } from '../../../services/shortcut.service';
import {
  SHORTCUTS,
  bindingLabel,
  isManagedShortcut,
  type ShortcutGroup,
  type ShortcutId,
} from '../../../services/shortcuts.catalog';

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
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: contents;
      }
      .modal-layer {
        position: fixed;
        inset: 0;
        z-index: 66;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgb(0 0 0 / 45%);
      }
      .modal-card {
        display: flex;
        flex-direction: column;
        width: min(560px, 100%);
        max-height: min(620px, 90vh);
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-lg);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 18px 48px rgb(0 0 0 / 40%);
        overflow: hidden;
      }
      .modal-head {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--morse-border);
      }
      .modal-head strong {
        font-size: 13px;
      }
      .modal-head .stamp {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-size: 11px;
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
      .intro {
        margin: 0;
        padding: 10px 14px 0;
        color: var(--morse-fg-muted);
        font-size: 11.5px;
        line-height: 1.55;
      }
      .scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 4px 14px 12px;
      }
      .group {
        margin-top: 12px;
      }
      .group h3 {
        margin: 0 0 4px;
        color: var(--morse-fg-muted);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }
      ul {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      /* One row per key: what it does on the left, the keys on the right. */
      li {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: start;
        gap: 8px;
        padding: 6px 8px;
        border-radius: var(--morse-radius-sm);
      }
      li + li {
        border-top: 1px solid var(--morse-hover);
      }
      li:hover {
        background: var(--morse-hover);
      }
      /* A row whose owner is off screen reads as a note, not as an offer. */
      li.unavailable .label,
      li.unavailable kbd {
        opacity: 0.55;
      }
      .what {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .label {
        font-size: 12px;
        font-weight: 600;
      }
      .why {
        margin-left: 6px;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--morse-badge-bg);
        color: var(--morse-badge-fg);
        font-size: 10px;
        font-weight: 400;
      }
      .detail {
        color: var(--morse-fg-muted);
        font-size: 11px;
        line-height: 1.5;
      }
      kbd {
        justify-self: end;
        padding: 2px 7px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-sm);
        background: var(--morse-bg);
        color: var(--morse-fg);
        font-family: var(--morse-font-mono);
        font-size: 11px;
        white-space: nowrap;
      }
      .modal-foot {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        border-top: 1px solid var(--morse-border);
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .modal-foot .spacer {
        flex: 1;
        min-width: 0;
      }
    `,
  ],
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

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.close();
  }
}
