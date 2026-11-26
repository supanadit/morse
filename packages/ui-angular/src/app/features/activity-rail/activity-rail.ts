import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { LayoutState } from '../../state/layout-state';
import { ShellState, type LeftPane } from '../../state/shell-state';
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
  private readonly morse = inject(MorseService);
  private readonly auth = inject(AuthState);

  protected readonly leftPane = this.shell.leftPane;
  /** Multi-user admins get the third entry: user management. */
  protected readonly adminVisible = computed(() => this.morse.user()?.role === 'admin');
  protected readonly adminOpen = this.shell.adminOpen;
  /** The login user on multi-user hosts; absent everywhere else. */
  protected readonly currentUser = computed(() => this.morse.user());
  /** The account card open under the rail's foot. */
  protected readonly menuOpen = signal(false);
  /** A stable tint for the avatar, hashed from the username. */
  protected readonly avatarHue = computed(() => {
    const name = this.currentUser()?.username ?? '';
    let hash = 0;
    for (let index = 0; index < name.length; index += 1) {
      hash = (hash * 31 + name.charCodeAt(index)) | 0;
    }
    return Math.abs(hash) % 360;
  });
  protected readonly avatarInitial = computed(
    () => this.currentUser()?.username.charAt(0).toUpperCase() ?? '',
  );

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

  protected toggleAdmin(): void {
    this.shell.toggleAdmin();
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
    if (!this.shell.adminOpen()) {
      this.shell.toggleAdmin();
    }
  }

  /** Ends this login session and reloads into the login screen. */
  protected logout(): void {
    this.closeMenu();
    void this.auth.logout();
  }
}
