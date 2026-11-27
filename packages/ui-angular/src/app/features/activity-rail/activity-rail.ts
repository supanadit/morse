import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LayoutState } from '../../state/layout-state';
import { ShellState, type LeftPane } from '../../state/shell-state';
import { WorkspaceTabs } from '../../state/workspace-tabs';
import { MorseService } from '../../host/morse.service';
import { AuthState } from '../../host/auth-state';

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
  private readonly tabs = inject(WorkspaceTabs);
  private readonly morse = inject(MorseService);
  private readonly auth = inject(AuthState);

  protected readonly leftPane = this.shell.leftPane;
  /**
   * The third entry: host settings, a cog, not a face. Everyone gets it:
   * regular members manage their own access keys there, admins get Members
   * and Providers too. The menu itself decides which sections to draw.
   */
  protected readonly settingsVisible = computed(() => true);
  protected readonly settingsOpen = computed(() => this.leftPane() === 'settings');
  /** The login user on multi-user hosts; absent everywhere else. */
  protected readonly currentUser = computed(() => this.morse.user());
  /** The account card open under the rail's foot. */
  protected readonly menuOpen = signal(false);
  /** A stable tint for the avatar, hashed from the display name. */
  protected readonly avatarHue = computed(() => {
    const name = this.currentUser()?.name || this.currentUser()?.username || '';
    let hash = 0;
    for (let index = 0; index < name.length; index += 1) {
      hash = (hash * 31 + name.charCodeAt(index)) | 0;
    }
    return Math.abs(hash) % 360;
  });
  protected readonly avatarInitial = computed(() => {
    const name = this.currentUser()?.name || this.currentUser()?.username || '';
    return name.charAt(0).toUpperCase();
  });

  protected select(pane: LeftPane): void {
    // CSS decides which toggle is on screen; the handler only has to match it.
    const wide = globalThis.matchMedia?.('(min-width: 760px)').matches ?? true;
    if (pane !== this.shell.leftPane()) {
      this.shell.setLeftPane(pane);
      // The cog shows the settings menu only. Opening a page is an explicit
      // choice from that menu (or the admin's own card), never a side effect.
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

  /** Opens the account card; the rail's foot, like the reference sidebar. */
  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  /** Admins jump to user management from their own card. */
  protected manageUsers(): void {
    this.closeMenu();
    this.shell.setLeftPane('settings');
    this.tabs.openSettingsPage();
  }

  /** Ends this login session and reloads into the login screen. */
  protected logout(): void {
    this.closeMenu();
    void this.auth.logout();
  }
}
