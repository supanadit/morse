import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SshStatus } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { CopyButton } from '../../ui/copy-button/copy-button';

/**
 * SSH settings: the signed-in member's own keys (generate, view public +
 * private, edit authorized_keys). Strictly self-service — even admins manage
 * only their own keys here. The terminal command is printed alongside, since
 * a fresh install can use either path. GPG lives on its own page.
 */
@Component({
  selector: 'morse-access-panel',
  imports: [FormsModule, CopyButton],
  templateUrl: './access-panel.html',
  styleUrl: './access-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccessPanel {
  private readonly morse = inject(MorseService);

  protected readonly ssh = signal<SshStatus | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly privateKey = signal<string | null>(null);
  protected readonly privateName = signal('');
  protected readonly confirmDelete = signal<string | null>(null);
  protected readonly authKeys = signal('');

  constructor() {
    void this.refresh();
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.privateKey.set(null);
    try {
      const ssh = (await this.morse.requestHostCommand('sshStatus')) as SshStatus;
      this.ssh.set(ssh);
      this.authKeys.set((ssh.authorizedKeys ?? []).join('\n'));
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not load SSH keys.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async generateSsh(type: 'ed25519' | 'rsa'): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const ssh = (await this.morse.requestHostCommand('sshGenerate', {
        type,
      })) as SshStatus;
      this.ssh.set(ssh);
      this.notice.set('A fresh SSH key was generated. The old one is replaced.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not generate the key.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async showPrivate(name: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const answer = (await this.morse.requestHostCommand('sshPrivate', {
        name,
      })) as { privateKey?: string };
      this.privateKey.set(answer.privateKey ?? null);
      this.privateName.set(name);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not read the private key.');
    } finally {
      this.busy.set(false);
    }
  }

  protected hidePrivate(): void {
    this.privateKey.set(null);
    this.privateName.set('');
  }

  protected async deleteSsh(name: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const ssh = (await this.morse.requestHostCommand('sshDelete', { name })) as SshStatus;
      this.ssh.set(ssh);
      this.confirmDelete.set(null);
      if (this.privateName() === name) {
        this.hidePrivate();
      }
      this.notice.set(`SSH key ${name} was deleted.`);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not delete the key.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveAuthorized(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const keys = this.authKeys()
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const ssh = (await this.morse.requestHostCommand('authorizedKeysSave', {
        keys,
      })) as SshStatus;
      this.ssh.set(ssh);
      this.notice.set('authorized_keys was saved.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not save authorized_keys.');
    } finally {
      this.busy.set(false);
    }
  }
}
