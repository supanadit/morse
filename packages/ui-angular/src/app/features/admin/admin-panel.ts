import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { AuthRole, AuthUser } from '@morse/protocol';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { Dialog } from '../../ui/dialog/dialog';
import { MorseService } from '../../host/morse.service';

interface ListedUser extends AuthUser {
  name: string;
  email: string;
  createdAt: number;
}

type Editor = { mode: 'create' } | { mode: 'edit'; user: ListedUser };

function validEmail(value: string): boolean {
  const email = value.trim();
  return email.length === 0 || /^[^\s@]+@[^\s@]+$/.test(email);
}

/**
 * User management for admins: a searchable roster, add/edit dialogs, role
 * changes and deletes. Every action rides an `admin/*` host command, which the
 * host re-authorizes per call — this page is display, the command is the gate.
 */
@Component({
  selector: 'morse-admin-panel',
  imports: [FormsModule, Dialog, ConfirmDialog],
  templateUrl: './admin-panel.html',
  styleUrl: './admin-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminPanel {
  private readonly morse = inject(MorseService);

  protected readonly users = signal<ListedUser[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly editor = signal<Editor | null>(null);
  protected readonly pendingDelete = signal<ListedUser | null>(null);

  protected readonly formName = signal('');
  protected readonly formEmail = signal('');
  protected readonly formUsername = signal('');
  protected readonly formPassword = signal('');
  protected readonly formRole = signal<AuthRole>('regular');

  protected readonly me = computed(() => this.morse.user());
  protected readonly adminCount = computed(
    () => this.users().filter((user) => user.role === 'admin').length,
  );
  protected readonly filtered = computed(() => {
    const text = this.query().trim().toLowerCase();
    if (text.length === 0) {
      return this.users();
    }
    return this.users().filter((user) =>
      [user.name, user.username, user.email].some((value) =>
        value.toLowerCase().includes(text),
      ),
    );
  });
  protected readonly canSave = computed(() => {
    if (this.saving()) {
      return false;
    }
    if (this.editor()?.mode === 'create') {
      return (
        this.formUsername().trim().length > 0 &&
        this.formPassword().length >= 8 &&
        validEmail(this.formEmail())
      );
    }
    return (
      this.formName().trim().length > 0 &&
      validEmail(this.formEmail()) &&
      (this.formPassword().length === 0 || this.formPassword().length >= 8)
    );
  });

  constructor() {
    void this.refresh();
  }

  protected displayName(user: ListedUser): string {
    return user.name || user.username;
  }

  protected initial(user: ListedUser): string {
    return this.displayName(user).charAt(0).toUpperCase();
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const users = (await this.morse.requestHostCommand('adminUsers')) as ListedUser[] | undefined;
      this.users.set(users ?? []);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not load members.');
    } finally {
      this.loading.set(false);
    }
  }

  protected openCreate(): void {
    this.error.set(null);
    this.notice.set(null);
    this.formName.set('');
    this.formEmail.set('');
    this.formUsername.set('');
    this.formPassword.set('');
    this.formRole.set('regular');
    this.editor.set({ mode: 'create' });
  }

  protected openEdit(user: ListedUser): void {
    this.error.set(null);
    this.notice.set(null);
    this.formName.set(user.name || user.username);
    this.formEmail.set(user.email);
    this.formUsername.set(user.username);
    this.formPassword.set('');
    this.formRole.set(user.role);
    this.editor.set({ mode: 'edit', user });
  }

  protected closeEditor(): void {
    this.editor.set(null);
  }

  protected async save(): Promise<void> {
    const editor = this.editor();
    if (editor === null || !this.canSave()) {
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    const name = this.formName().trim();
    const email = this.formEmail().trim();
    const password = this.formPassword();
    try {
      if (editor.mode === 'create') {
        await this.morse.requestHostCommand('adminCreateUser', {
          username: this.formUsername().trim(),
          name,
          email,
          password,
          role: this.formRole(),
        });
        this.notice.set(`${name || this.formUsername().trim()} was added.`);
      } else {
        await this.morse.requestHostCommand('adminUpdateUser', {
          userId: editor.user.id,
          name,
          email,
          role: this.formRole(),
          ...(password.length > 0 ? { password } : {}),
        });
        const wasSelf = editor.user.id === this.me()?.id;
        if (password.length > 0 && wasSelf) {
          // The host revoked this session along with the password; the cookie no
          // longer authenticates, so land on the login screen instead of a shell
          // that will fail on its next request.
          globalThis.location?.reload();
          return;
        }
        this.notice.set(
          password.length > 0
            ? `${this.displayName(editor.user)} was updated and signed out of other sessions.`
            : `${this.displayName(editor.user)} was updated.`,
        );
      }
      this.editor.set(null);
      await this.refresh();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not save the member.');
    } finally {
      this.saving.set(false);
    }
  }

  protected askDelete(user: ListedUser): void {
    this.error.set(null);
    this.pendingDelete.set(user);
  }

  protected async confirmDelete(): Promise<void> {
    const user = this.pendingDelete();
    if (user === null) {
      return;
    }
    this.pendingDelete.set(null);
    this.notice.set(null);
    this.error.set(null);
    try {
      await this.morse.requestHostCommand('adminDeleteUser', { userId: user.id });
      this.notice.set(`${this.displayName(user)} and their sessions were deleted.`);
      await this.refresh();
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not delete the member.');
    }
  }
}
