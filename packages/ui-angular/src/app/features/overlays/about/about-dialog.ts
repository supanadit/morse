import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MorseService } from '../../../host/morse.service';
import { ShellState } from '../../../state/shell-state';
import { UpdateCheck } from '../../../services/update';
import { CREDITS } from './credits';
import { Dialog } from '../../../ui/dialog/dialog';

/**
 * About Morse: what this is, which build is talking, and who it stands on.
 *
 * Every technology the workspace depends on is credited here (see `credits.ts`,
 * kept honest by its spec). It is pure frontend data: no host work, no wire
 * message, so the VS Code panel and the browser show exactly the same list.
 */
@Component({
  selector: 'morse-about-dialog',
  templateUrl: './about-dialog.html',
  imports: [Dialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './about-dialog.css',
})
export class AboutDialog {
  private readonly morse = inject(MorseService);
  private readonly shell = inject(ShellState);
  private readonly update = inject(UpdateCheck);

  protected readonly groups = CREDITS;
  protected readonly protocolVersion = this.morse.protocolVersion;
  /** The newer release, when there is one: this is where a reader looks for versions. */
  protected readonly updateNotice = this.update.available;
  /** A newer pi, for the same reason the Morse notice rides here. */
  protected readonly piUpdateNotice = this.update.piAvailable;

  /** `name version` as the host read it from the frontend manifest. */
  protected readonly frontend = computed(() => {
    const identity = this.morse.frontend();
    return identity ? `${identity.name} ${identity.version}` : 'not reported by this host';
  });

  protected readonly host = computed(() => {
    const capabilities = this.morse.capabilities();
    return capabilities ? `${capabilities.hostKind} · ${capabilities.scope}` : 'not connected';
  });

  protected close(): void {
    this.shell.closeAbout();
  }
}