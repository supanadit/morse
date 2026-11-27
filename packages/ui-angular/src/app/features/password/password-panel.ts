import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * Self-service password under Access: the same credential SSH and local login
 * read. SSO-provisioned members (random password nobody knows) set one with
 * no current password; everyone else proves the current one first. Saving ends
 * every session of that user — the page reloads onto the login screen, where
 * the new credential is proven immediately.
 */
@Component({
  selector: 'morse-password-panel',
  imports: [FormsModule],
  templateUrl: './password-panel.html',
  styleUrl: './password-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PasswordPanel {
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly needsCurrent = signal(true);
  protected readonly current = signal('');
  protected readonly next = signal('');
  protected readonly confirm = signal('');
  protected readonly showCurrent = signal(false);
  protected readonly showNext = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);

  protected readonly canSave = computed(
    () =>
      !this.saving() &&
      this.next().length >= 8 &&
      this.next() === this.confirm() &&
      (this.needsCurrent() ? this.current().length > 0 : true),
  );

  constructor() {
    void this.refresh();
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const response = await fetch('/api/auth/password', { headers: { accept: 'application/json' } });
      if (!response.ok) {
        this.error.set('Could not load the password settings.');
        return;
      }
      const payload = (await response.json()) as { needsCurrent?: unknown };
      this.needsCurrent.set(payload.needsCurrent !== false);
    } catch {
      this.error.set('Cannot reach the Morse host.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) {
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ currentPassword: this.current(), newPassword: this.next() }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
        const message = payload !== undefined && typeof payload.error === 'string' ? payload.error : 'Could not set the password.';
        this.error.set(message);
        return;
      }
      this.notice.set('Password set — sign in again with it.');
      globalThis.setTimeout(() => globalThis.location?.reload(), 1200);
    } catch {
      this.error.set('Cannot reach the Morse host.');
    } finally {
      this.saving.set(false);
    }
  }
}
