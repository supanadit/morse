import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthState } from '../../host/auth-state';

/**
 * The login / first-run gate for multi-user hosts. Rendered full-page while
 * the shell steps aside (see `app.html`): login when users exist, the
 * create-first-admin wizard when the table is empty.
 *
 * The layout follows the product reference — a photo panel on the left, the
 * form on the right — skinned in Morse's own CSS variables.
 * Local credentials only: no OAuth buttons (those need per-deploy secrets).
 */
@Component({
  selector: 'morse-auth-screen',
  imports: [FormsModule],
  templateUrl: './auth-screen.html',
  styleUrl: './auth-screen.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthScreen {
  private readonly auth = inject(AuthState);

  protected readonly setupRequired = computed(() => this.auth.status()?.setupRequired === true);
  protected readonly working = this.auth.working;
  protected readonly error = this.auth.error;
  protected readonly username = signal('');
  protected readonly password = signal('');
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly showPassword = signal(false);

  protected canSubmit(): boolean {
    return this.username().trim().length > 0 && this.password().length >= 8 && !this.working();
  }

  protected async submit(): Promise<void> {
    if (!this.canSubmit()) {
      return;
    }
    const username = this.username().trim();
    const password = this.password();
    if (this.setupRequired()) {
      await this.auth.setup(username, password, { name: this.name(), email: this.email() });
    } else {
      await this.auth.login(username, password);
    }
    // Success reloads the page (the cookie authenticates the new connection);
    // failure leaves the error signal for the form to render.
  }

  protected togglePassword(): void {
    this.showPassword.update((visible) => !visible);
  }
}
