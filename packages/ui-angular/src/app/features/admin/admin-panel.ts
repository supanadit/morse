import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AuthRole, AuthUser } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';

interface ListedUser extends AuthUser {
  createdAt: number;
}

/**
 * User management for admins: the roster, creation, role changes and deletes.
 * Rendered in the center column while `ShellState.adminOpen` is up (the
 * settings menu's Members page). Every action rides an `admin/*` host command, which the
 * host re-authorizes per call — this page is display, the command is the gate.
 */
@Component({
  selector: 'morse-admin-panel',
  imports: [FormsModule],
  templateUrl: './admin-panel.html',
  styleUrl: './admin-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminPanel {
  private readonly morse = inject(MorseService);

  protected readonly users = signal<ListedUser[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly newUsername = signal('');
  protected readonly newPassword = signal('');
  protected readonly newRole = signal<AuthRole>('regular');
  protected readonly me = signal<string | null>(null);

  constructor() {
    void this.refresh();
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const users = (await this.morse.requestHostCommand('adminUsers')) as ListedUser[] | undefined;
      this.users.set(users ?? []);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not load users.');
    } finally {
      this.loading.set(false);
    }
  }

  protected canCreate(): boolean {
    return this.newUsername().trim().length > 0 && this.newPassword().length >= 8 && !this.loading();
  }

  protected async createUser(): Promise<void> {
    if (!this.canCreate()) {
      return;
    }
    this.error.set(null);
    this.notice.set(null);
    try {
      await this.morse.requestHostCommand('adminCreateUser', {
        username: this.newUsername().trim(),
        password: this.newPassword(),
        role: this.newRole(),
      });
      this.newUsername.set('');
      this.newPassword.set('');
      this.newRole.set('regular');
      this.notice.set('User created.');
      await this.refresh();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not create the user.');
    }
  }

  protected async setRole(user: ListedUser, role: AuthRole): Promise<void> {
    if (user.role === role) {
      return;
    }
    this.error.set(null);
    try {
      await this.morse.requestHostCommand('adminSetRole', { userId: user.id, role });
      await this.refresh();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not change the role.');
    }
  }

  protected async deleteUser(user: ListedUser): Promise<void> {
    this.error.set(null);
    this.notice.set(null);
    try {
      await this.morse.requestHostCommand('adminDeleteUser', { userId: user.id });
      this.notice.set(`Deleted ${user.username} and their sessions.`);
      await this.refresh();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not delete the user.');
    }
  }
}
