import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { InteractionRequest, SelectOption } from '@morse/protocol';
import { MorseService } from '../../core/morse.service';

/**
 * Rendered only when the host cannot show native dialogs (the browser/NestJS
 * host). Inside VS Code the extension answers `extension_ui_request`s with
 * QuickPick/InputBox and this panel stays hidden.
 */
@Component({
  selector: 'morse-interaction-panel',
  templateUrl: './interaction-panel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .dialog {
        margin: 8px;
        padding: 8px 10px;
        border: 1px solid var(--morse-focus);
        border-radius: 4px;
        background: var(--morse-blockquote);
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      header {
        font-weight: 600;
      }
      p {
        margin: 0;
        white-space: pre-wrap;
      }
      .options {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
    `,
  ],
})
export class InteractionPanel {
  private readonly morse = inject(MorseService);

  protected readonly request = this.morse.pendingInteraction;
  protected readonly value = signal('');
  protected readonly visible = computed(
    () => this.request() !== null && this.morse.capabilities()?.nativeDialogs !== true,
  );

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement | HTMLTextAreaElement).value);
  }

  protected choose(option: string): void {
    this.respond({ value: option });
  }

  protected decide(confirmed: boolean): void {
    this.respond({ confirmed });
  }

  protected submit(): void {
    this.respond({ value: this.value() });
    this.value.set('');
  }

  protected cancel(): void {
    this.respond({ cancelled: true });
    this.value.set('');
  }

  protected messageOf(request: InteractionRequest): string {
    return request.kind === 'select' || request.kind === 'confirm' ? (request.message ?? '') : '';
  }

  protected optionsOf(request: InteractionRequest): SelectOption[] {
    return request.kind === 'select' ? request.options : [];
  }

  protected placeholderOf(request: InteractionRequest): string {
    return request.kind === 'input' ? (request.placeholder ?? '') : '';
  }

  protected prefillOf(request: InteractionRequest): string {
    return request.kind === 'editor' || request.kind === 'input' ? (request.value ?? '') : '';
  }

  private respond(partial: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    const request = this.request();
    if (!request) {
      return;
    }
    this.morse.respond({ requestId: request.requestId, ...partial });
  }
}
