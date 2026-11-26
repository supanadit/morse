import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ShellState } from '../../state/shell-state';
import { Pane } from '../../ui/pane/pane';

/**
 * The settings menu: the left column's third face, in front while the rail's
 * cog is. One row per settings page — members today, more as host settings
 * grow — so a new page is a row here and a face in the center, nothing else.
 */
@Component({
  selector: 'morse-settings-nav',
  templateUrl: './settings-nav.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './settings-nav.css',
  imports: [Pane],
})
export class SettingsNav {
  private readonly shell = inject(ShellState);

  /** The Members page is the center while the menu lists it. */
  protected readonly membersOpen = this.shell.adminOpen;

  protected openMembers(): void {
    this.shell.openAdmin();
  }
}
