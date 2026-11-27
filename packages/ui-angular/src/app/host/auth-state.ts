import { Injectable, signal } from '@angular/core';
import type { AuthUser } from '@morse/protocol';

/**
 * Login state for multi-user hosts. Inert everywhere else: the status fetch
 * 404s (or fails) on single-user hosts, the mock transport and VS Code, and
 * this stays `{ multiuser: false }` — the shell renders exactly as before.
 *
 * After a successful login or setup the page reloads: the cookie the server
 * set replays on the WebSocket upgrade, so the new connection authenticates
 * with no state-machine surgery in the client.
 */
export interface AuthStatus {
  multiuser: boolean;
  setupRequired: boolean;
  user?: AuthUser;
  /** Present when an SSO provider is enabled and usable: the login page's second door. */
  oidc?: { enabled: boolean; displayName: string };
}

@Injectable({ providedIn: 'root' })
export class AuthState {
  readonly status = signal<AuthStatus | null>(null);
  readonly working = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const response = await fetch('/api/auth/status', { headers: { accept: 'application/json' } });
      if (!response.ok) {
        this.status.set({ multiuser: false, setupRequired: false });
        return;
      }
      this.status.set((await response.json()) as AuthStatus);
    } catch {
      this.status.set({ multiuser: false, setupRequired: false });
    }
  }

  /** True once we know the shell must step aside for login/setup. */
  needsAuth(): boolean {
    const status = this.status();
    return status !== null && status.multiuser && status.user === undefined;
  }

  async login(username: string, password: string): Promise<boolean> {
    return this.post('/api/auth/login', { username, password });
  }

  async setup(
    username: string,
    password: string,
    profile?: { name?: string; email?: string },
  ): Promise<boolean> {
    return this.post('/api/auth/setup', {
      username,
      password,
      name: profile?.name ?? '',
      email: profile?.email ?? '',
    });
  }

  async logout(): Promise<void> {
    // With SSO on, leave through the provider's own logout: it ends the
    // provider session too, so the next login can pick a different user
    // instead of silently reusing the last one. The server ends password
    // logins locally even then (it knows which door each session used).
    if (this.status()?.oidc?.enabled === true && typeof location !== 'undefined') {
      location.href = '/api/auth/oidc/logout';
      return;
    }
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // The cookie clear is best-effort; the reload drops the session anyway.
    }
    if (typeof location !== 'undefined') {
      location.reload();
    }
  }

  private async post(
    url: string,
    body: { username: string; password: string; name?: string; email?: string },
  ): Promise<boolean> {
    this.working.set(true);
    this.error.set(null);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as
          | { error?: string }
          | undefined;
        this.error.set(payload?.error ?? 'Login failed.');
        return false;
      }
      // The cookie is set: a fresh page load connects authenticated.
      if (typeof location !== 'undefined') {
        location.reload();
      }
      return true;
    } catch {
      this.error.set('Cannot reach the Morse host.');
      return false;
    } finally {
      this.working.set(false);
    }
  }
}
