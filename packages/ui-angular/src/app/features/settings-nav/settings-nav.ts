import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  WorkspaceTabs,
  SETTINGS_MEMBERS_TAB_ID,
  SETTINGS_PROVIDERS_TAB_ID,
} from '../../state/workspace-tabs';
import { Pane } from '../../ui/pane/pane';

/**
 * The settings menu: the left column's third face, in front while the rail's
 * cog is. One row per settings page — members today, more as host settings
 * grow — so a new page is a row here and a tab id in the strip, nothing else.
 */
@Component({
  selector: 'morse-settings-nav',
  templateUrl: './settings-nav.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './settings-nav.css',
  imports: [Pane],
})
export class SettingsNav {
  private readonly tabs = inject(WorkspaceTabs);

  /** The Members page is the tab in front. */
  protected readonly membersOpen = computed(
    () => this.tabs.activeId() === SETTINGS_MEMBERS_TAB_ID,
  );

  /** The Providers page is the tab in front. */
  protected readonly providersOpen = computed(
    () => this.tabs.activeId() === SETTINGS_PROVIDERS_TAB_ID,
  );

  protected openMembers(): void {
    this.tabs.openSettingsPage();
  }

  protected openProviders(): void {
    this.tabs.openProvidersPage();
  }
}
