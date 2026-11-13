import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LayoutState } from '../../state/layout-state';
import { ShellState, type LeftPane } from '../../state/shell-state';

/**
 * The web shell's activity rail: the far-left strip that picks which face the
 * left column shows. Sessions first, the Explorer below it — the reference is VS
 * Code's activity bar, not a menu.
 *
 * It owns no state: the face lives in `ShellState` (and is remembered), the fold
 * in `LayoutState`. Clicking the face already in front folds the panel; clicking
 * the other one switches to it and opens the panel. On a narrow window the panel
 * is a drawer, so the same gesture drives `ShellState`'s drawer instead — the
 * stored desktop fold is not rewritten by using the drawer.
 */
@Component({
  selector: 'morse-activity-rail',
  templateUrl: './activity-rail.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './activity-rail.css',
})
export class ActivityRail {
  private readonly shell = inject(ShellState);
  private readonly layout = inject(LayoutState);

  protected readonly leftPane = this.shell.leftPane;

  protected select(pane: LeftPane): void {
    // CSS decides which toggle is on screen; the handler only has to match it.
    const wide = globalThis.matchMedia?.('(min-width: 760px)').matches ?? true;
    if (pane !== this.shell.leftPane()) {
      this.shell.setLeftPane(pane);
      if (wide) {
        this.layout.setVisible('left', true);
      } else {
        this.shell.openNavigation();
      }
      return;
    }
    if (wide) {
      this.layout.toggleVisible('left');
    } else {
      this.shell.toggleNavigation();
    }
  }
}
