import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { GitIdentity, GpgStatus } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';

/**
 * Git settings: the signed-in member's own global identity (`~/.gitconfig`) —
 * who their commits say they are from, plus the everyday essentials. Strictly
 * self-service, like SSH/GPG: only the allowlisted keys are readable and
 * writable, so repository or credential state is unreachable from here.
 */
@Component({
  selector: 'morse-git-identity-panel',
  imports: [FormsModule],
  templateUrl: './git-identity-panel.html',
  styleUrl: './git-identity-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GitIdentityPanel {
  private readonly morse = inject(MorseService);

  protected readonly status = signal<GitIdentity | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly formName = signal('');
  protected readonly formEmail = signal('');
  protected readonly formEditor = signal('');
  protected readonly formDefaultBranch = signal('');
  protected readonly formPullRebase = signal('');
  protected readonly formAutoSetupRemote = signal('');
  protected readonly formGpgSign = signal(false);
  protected readonly formSigningKey = signal('');
  /** The member's own GPG keys: the signing-key picker. Loads with identity. */
  protected readonly gpgKeys = signal<GpgStatus['keys']>([]);

  constructor() {
    void this.refresh();
  }

  protected async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const status = (await this.morse.requestHostCommand('gitIdentityStatus')) as GitIdentity;
      this.fill(status);
      try {
        const gpg = (await this.morse.requestHostCommand('gpgStatus')) as GpgStatus;
        this.gpgKeys.set(gpg.keys);
      } catch {
        this.gpgKeys.set([]);
      }
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not load git identity.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const status = (await this.morse.requestHostCommand('gitIdentitySave', {
        identity: {
          name: this.formName().trim(),
          email: this.formEmail().trim(),
          editor: this.formEditor().trim(),
          defaultBranch: this.formDefaultBranch().trim(),
          pullRebase: this.formPullRebase(),
          autoSetupRemote: this.formAutoSetupRemote(),
          gpgSign: this.formGpgSign() ? 'true' : '',
          signingKey: this.formSigningKey().trim(),
        },
      })) as GitIdentity;
      this.fill(status);
      this.notice.set('Git identity saved to your ~/.gitconfig.');
    } catch (error: unknown) {
      this.error.set(error instanceof Error ? error.message : 'Could not save git identity.');
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * One-click off-ramp: clears signing and its key, then saves at once — the
   * "nevermind, no more GPG" button. A no-op save when already off.
   */
  protected async disableSigning(): Promise<void> {
    this.formGpgSign.set(false);
    this.formSigningKey.set('');
    await this.save();
  }

  private fill(status: GitIdentity): void {
    this.status.set(status);
    this.formName.set(status.name);
    this.formEmail.set(status.email);
    this.formEditor.set(status.editor);
    this.formDefaultBranch.set(status.defaultBranch);
    this.formPullRebase.set(status.pullRebase);
    this.formAutoSetupRemote.set(status.autoSetupRemote);
    this.formGpgSign.set(status.gpgSign === 'true');
    this.formSigningKey.set(status.signingKey);
  }
}
