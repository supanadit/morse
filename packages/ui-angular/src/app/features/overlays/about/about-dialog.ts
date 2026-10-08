import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { MorseService } from '../../../host/morse.service';
import { ShellState } from '../../../state/shell-state';
import { UpdateCheck } from '../../../services/update';
import { CREDITS } from './credits';

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
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: contents;
      }
      .modal-layer {
        position: fixed;
        inset: 0;
        z-index: 60;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgb(0 0 0 / 45%);
      }
      .modal-card {
        display: flex;
        flex-direction: column;
        width: min(620px, 100%);
        max-height: min(680px, 90vh);
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-lg);
        background: var(--morse-panel, var(--morse-bg));
        box-shadow: 0 18px 48px rgb(0 0 0 / 40%);
        overflow: hidden;
      }
      .modal-head {
        display: flex;
        align-items: baseline;
        gap: 8px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--morse-border);
      }
      .modal-head strong {
        font-size: 13px;
      }
      .modal-head .stamp {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .modal-head .close {
        padding: 2px 8px;
        border: 0;
        background: transparent;
        color: var(--morse-fg-muted);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
      }
      .modal-head .close:hover {
        color: var(--morse-fg);
      }
      .intro {
        margin: 0;
        padding: 10px 14px 0;
        color: var(--morse-fg-muted);
        font-size: 11.5px;
        line-height: 1.55;
      }
      .intro code,
      .role code {
        font-family: var(--morse-font-mono);
        font-size: 11px;
        padding: 0 3px;
        border-radius: var(--morse-radius-sm);
        background: var(--morse-hover);
      }
      dl.identity {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 18px;
        margin: 10px 14px 0;
        padding: 8px 10px;
        border: 1px solid var(--morse-border);
        border-radius: var(--morse-radius-md);
        background: var(--morse-hover);
        font-size: 11px;
      }
      dl.identity div {
        display: flex;
        gap: 6px;
        min-width: 0;
      }
      dt {
        color: var(--morse-fg-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      dd {
        margin: 0;
        font-family: var(--morse-font-mono);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      dl.identity dd a {
        color: var(--morse-link);
      }
      dl.identity dd a:hover {
        text-decoration: underline;
      }
      .scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 6px 14px 12px;
      }
      .group {
        margin-top: 12px;
      }
      .group h3 {
        margin: 0 0 2px;
        color: var(--morse-fg-muted);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }
      .blurb {
        margin: 0 0 6px;
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      ul {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      /*
       * One row per technology: name + licence on the top line, the reason
       * under it. Dense on purpose — this is a reference list, not a page.
       */
      li {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 0 8px;
        padding: 6px 8px;
        border-radius: var(--morse-radius-sm);
      }
      li + li {
        border-top: 1px solid var(--morse-hover);
      }
      li:hover {
        background: var(--morse-hover);
      }
      .name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--morse-fg);
        font-size: 12px;
        font-weight: 600;
        text-decoration: none;
      }
      .name:hover {
        color: var(--morse-link);
        text-decoration: underline;
      }
      .by {
        margin-left: 6px;
        color: var(--morse-fg-muted);
        font-size: 11px;
        font-weight: 400;
      }
      .license {
        justify-self: end;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--morse-badge-bg);
        color: var(--morse-badge-fg);
        font-family: var(--morse-font-mono);
        font-size: 10px;
      }
      .role {
        grid-column: 1 / -1;
        margin: 2px 0 0;
        color: var(--morse-fg-muted);
        font-size: 11px;
        line-height: 1.5;
      }
      .modal-foot {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        border-top: 1px solid var(--morse-border);
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .modal-foot .spacer {
        flex: 1;
        min-width: 0;
      }
    `,
  ],
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

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.close();
  }
}
