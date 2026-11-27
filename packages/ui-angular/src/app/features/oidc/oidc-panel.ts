import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

interface OidcForm {
  enabled: boolean;
  displayName: string;
  discoveryUrl: string;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  endSessionUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  allowSignup: boolean;
  hasSecret: boolean;
}

/**
 * SSO provider management for admins: one generic OIDC/OAuth2 door beside the
 * local login. The form saves to the host's database; when the provider is
 * env-managed (`MORSE_OIDC_*`) the page stays visible but every input is
 * disabled — the environment is the configuration then.
 */
@Component({
  selector: 'morse-oidc-panel',
  imports: [FormsModule],
  templateUrl: './oidc-panel.html',
  styleUrl: './oidc-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OidcPanel {
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly discovering = signal(false);
  protected readonly managedByEnv = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);

  protected readonly enabled = signal(false);
  protected readonly displayName = signal('Single sign-on');
  protected readonly discoveryUrl = signal('');
  protected readonly authUrl = signal('');
  protected readonly tokenUrl = signal('');
  protected readonly userinfoUrl = signal('');
  protected readonly endSessionUrl = signal('');
  protected readonly clientId = signal('');
  protected readonly clientSecret = signal('');
  protected readonly scopes = signal('openid profile email');
  protected readonly allowSignup = signal(true);
  protected readonly hasSecret = signal(false);

  constructor() {
    void this.refresh();
  }

  private readError(payload: unknown, fallback: string): string {
    if (payload !== null && typeof payload === 'object' && 'error' in payload) {
      const message = (payload as { error?: unknown }).error;
      if (typeof message === 'string' && message.length > 0) {
        return message;
      }
    }
    return fallback;
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const response = await fetch('/api/auth/oidc/config', { headers: { accept: 'application/json' } });
      if (!response.ok) {
        this.error.set(this.readError(await response.json().catch(() => undefined), 'Could not load the sign-on settings.'));
        return;
      }
      const payload = (await response.json()) as {
        managedByEnv: boolean;
        config: OidcForm;
      };
      const form = payload.config;
      this.managedByEnv.set(payload.managedByEnv);
      this.enabled.set(form.enabled);
      this.displayName.set(form.displayName || 'Single sign-on');
      this.discoveryUrl.set(form.discoveryUrl ?? '');
      this.authUrl.set(form.authUrl ?? '');
      this.tokenUrl.set(form.tokenUrl ?? '');
      this.userinfoUrl.set(form.userinfoUrl ?? '');
      this.endSessionUrl.set(form.endSessionUrl ?? '');
      this.clientId.set(form.clientId ?? '');
      this.clientSecret.set('');
      this.scopes.set(form.scopes || 'openid profile email');
      this.allowSignup.set(form.allowSignup !== false);
      this.hasSecret.set(form.hasSecret);
    } catch {
      this.error.set('Cannot reach the Morse host.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Fills the endpoint fields from the discovery URL, like Grafana's discovery button. */
  protected async discover(): Promise<void> {
    const url = this.discoveryUrl().trim();
    if (url.length === 0 || this.discovering()) {
      return;
    }
    this.discovering.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const response = await fetch('/api/auth/oidc/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ discoveryUrl: url }),
      });
      const payload = (await response.json().catch(() => undefined)) as
        | { authUrl?: string; tokenUrl?: string; userinfoUrl?: string; endSessionUrl?: string; error?: string }
        | undefined;
      if (!response.ok) {
        this.error.set(this.readError(payload, 'Discovery failed.'));
        return;
      }
      this.authUrl.set(payload?.authUrl ?? '');
      this.tokenUrl.set(payload?.tokenUrl ?? '');
      this.userinfoUrl.set(payload?.userinfoUrl ?? '');
      if (payload?.endSessionUrl !== undefined) {
        this.endSessionUrl.set(payload.endSessionUrl);
      }
      this.notice.set('Endpoints filled from the discovery document.');
    } catch {
      this.error.set('Cannot reach the Morse host.');
    } finally {
      this.discovering.set(false);
    }
  }

  protected async save(): Promise<void> {
    if (this.saving() || this.managedByEnv()) {
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const response = await fetch('/api/auth/oidc/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          enabled: this.enabled(),
          displayName: this.displayName().trim(),
          discoveryUrl: this.discoveryUrl().trim(),
          authUrl: this.authUrl().trim(),
          tokenUrl: this.tokenUrl().trim(),
          userinfoUrl: this.userinfoUrl().trim(),
          endSessionUrl: this.endSessionUrl().trim(),
          clientId: this.clientId().trim(),
          // Empty means "keep the stored secret" (the read never returns it).
          clientSecret: this.clientSecret(),
          scopes: this.scopes().trim(),
          allowSignup: this.allowSignup(),
        }),
      });
      if (!response.ok) {
        this.error.set(this.readError(await response.json().catch(() => undefined), 'Could not save the sign-on settings.'));
        return;
      }
      this.notice.set(
        this.enabled()
          ? 'Single sign-on is on. The login page now offers it beside the password.'
          : 'Single sign-on is off. Only the local login shows.',
      );
      await this.refresh();
    } catch {
      this.error.set('Cannot reach the Morse host.');
    } finally {
      this.saving.set(false);
    }
  }
}
