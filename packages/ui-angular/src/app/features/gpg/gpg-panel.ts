import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { GpgStatus } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';

/**
 * GPG settings: the signed-in member's own keys — generate, list, and view
 * the armored public block (for GitHub/GitLab) and the armored private block
 * (for backup). Strictly self-service, like SSH. The terminal command is
 * printed alongside, since a fresh install can use either path.
 */
@Component({
  selector: 'morse-gpg-panel',
  imports: [FormsModule],
  templateUrl: './gpg-panel.html',
  styleUrl: './gpg-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GpgPanel {
  private readonly morse = inject(MorseService);

  protected readonly status = signal<GpgStatus | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly armor = signal<string | null>(null);
  protected readonly armorKind = signal<'public' | 'private'>('public');
  protected readonly armorKeyId = signal('');
  protected readonly confirmDelete = signal<string | null>(null);
  protected readonly formName = signal('');
  protected readonly formEmail = signal('');

  constructor() {
    void this.refresh();
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.armor.set(null);
    try {
      const status = (await this.morse.requestHostCommand('gpgStatus')) as GpgStatus;
      this.status.set(status);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not load GPG keys.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async generate(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.armor.set(null);
    try {
      const status = (await this.morse.requestHostCommand('gpgGenerate', {
        ...(this.formName().trim().length > 0 ? { name: this.formName().trim() } : {}),
        ...(this.formEmail().trim().length > 0 ? { email: this.formEmail().trim() } : {}),
      })) as GpgStatus;
      this.status.set(status);
      this.notice.set('A fresh GPG key was generated.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not generate the GPG key.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async showArmor(keyId: string, kind: 'public' | 'private'): Promise<void> {    this.busy.set(true);
    this.error.set(null);
    try {
      const command = kind === 'public' ? 'gpgPublic' : 'gpgPrivate';
      const answer = (await this.morse.requestHostCommand(command, {
        keyId,
      })) as { armor?: string };
      this.armor.set(answer.armor ?? null);
      this.armorKind.set(kind);
      this.armorKeyId.set(keyId);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not export the GPG key.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async deleteKey(keyId: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const status = (await this.morse.requestHostCommand('gpgDelete', { keyId })) as GpgStatus;
      this.status.set(status);
      this.confirmDelete.set(null);
      this.armor.set(null);
      this.notice.set(`GPG key ${keyId} was deleted.`);
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not delete the GPG key.');
    } finally {
      this.busy.set(false);
    }
  }
}
