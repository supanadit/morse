import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthState } from '../../host/auth-state';

/**
 * The login / first-run gate for gated hosts, rendered full-page while the
 * shell steps aside (see `app.html`): multi-user login when users exist, the
 * create-first-admin wizard when the table is empty, and the single-password
 * gate (`MORSE_AUTH_PASSWORD`, username only with `MORSE_AUTH_USERNAME`)
 * otherwise. One page, one style; the mode only decides which fields show.
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
  /** Single-password gate, when the host runs one instead of multi-user. */
  protected readonly singleAuth = computed(() => this.auth.status()?.singleAuth ?? null);
  /** The username field shows everywhere except password-only single mode. */
  protected readonly showUsername = computed(() => {
    const single = this.singleAuth();
    return single === null || single.usernameRequired;
  });
  protected readonly ssoName = computed(() => this.auth.status()?.oidc?.displayName ?? null);
  /** SSO is the only door: the local form stays hidden (server refuses it too). */
  protected readonly ssoOnly = computed(
    () => this.auth.status()?.oidc !== undefined && this.auth.status()?.oidc?.allowPassword === false,
  );
  protected readonly working = this.auth.working;
  protected readonly error = this.auth.error;
  protected readonly username = signal('');
  protected readonly password = signal('');
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly showPassword = signal(false);

  protected canSubmit(): boolean {
    if (this.working()) {
      return false;
    }
    const single = this.singleAuth();
    if (single !== null) {
      // An env password has no length policy: any non-empty attempt is submittable.
      return (
        this.password().length > 0 && (!single.usernameRequired || this.username().trim().length > 0)
      );
    }
    return this.username().trim().length > 0 && this.password().length >= 8;
  }

  protected async submit(): Promise<void> {
    if (!this.canSubmit()) {
      return;
    }
    if (this.singleAuth() !== null) {
      await this.auth.singleLogin(this.username().trim(), this.password());
      // Success reloads the page (the cookie authenticates the new connection);
      // failure leaves the error signal for the form to render.
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
