import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { highlightCode } from '../../core/highlight';
import { WorkspaceTabs, type FileTab } from '../../core/workspace-tabs';

/**
 * A file opened from the Explorer, read by the host (`readFile`) and shown with
 * the same highlight.js the transcript uses. Read-only on purpose: this is a
 * preview, and the browser host is not a text editor — VS Code opens the real
 * editor for a file the user wants to change.
 */
@Component({
  selector: 'morse-file-preview',
  templateUrl: './file-preview.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        min-width: 0;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: none;
        min-height: var(--morse-head-height);
        padding: 0 10px 0 14px;
        border-bottom: 1px solid var(--morse-border);
      }
      .path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--morse-font-mono);
        font-size: 12px;
        color: var(--morse-fg);
      }
      .meta {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: none;
      }
      .badge {
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--morse-badge-bg, var(--morse-hover));
        color: var(--morse-fg-muted);
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .stat {
        color: var(--morse-fg-muted);
        font-size: 11px;
      }
      .icon {
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: var(--morse-radius-sm);
        background: none;
        color: var(--morse-fg-muted);
        cursor: pointer;
      }
      .icon:hover {
        background: var(--morse-hover);
        color: var(--morse-fg);
      }
      .code {
        display: flex;
        flex: 1;
        min-height: 0;
        overflow: auto;
        padding: 8px 0;
        background: var(--morse-code-bg, var(--morse-bg));
      }
      pre {
        margin: 0;
        font-family: var(--morse-font-mono);
        font-size: 12px;
        line-height: 1.6;
      }
      .gutter {
        flex: none;
        position: sticky;
        left: 0;
        padding: 0 10px 0 14px;
        color: var(--morse-fg-muted);
        text-align: right;
        user-select: none;
        background: var(--morse-code-bg, var(--morse-bg));
        opacity: 0.65;
      }
      .source {
        flex: 1;
        min-width: 0;
        padding: 0 16px 0 4px;
        white-space: pre;
      }
      .hint {
        margin: 0;
        padding: 12px 16px;
        color: var(--morse-fg-muted);
        font-size: 12px;
      }
      .hint.error {
        color: var(--morse-warn);
      }
    `,
  ],
})
export class FilePreview {
  readonly tab = input.required<FileTab>();

  private readonly tabs = inject(WorkspaceTabs);
  private readonly sanitizer = inject(DomSanitizer);

  /** The text without its final newline, so the gutter and the code line up. */
  private readonly source = computed(() => {
    const content = this.tab().content ?? '';
    return content.endsWith('\n') ? content.slice(0, -1) : content;
  });

  protected readonly highlighted = computed<SafeHtml>(() => {
    const tab = this.tab();
    if (tab.content === undefined || tab.binary) {
      return this.sanitizer.bypassSecurityTrustHtml('');
    }
    return this.sanitizer.bypassSecurityTrustHtml(highlightCode(this.source(), tab.language).html);
  });

  protected readonly lineNumbers = computed(() => {
    const source = this.source();
    const count = source.length === 0 ? 1 : source.split('\n').length;
    let numbers = '';
    for (let line = 1; line <= count; line += 1) {
      numbers += `${line === 1 ? '' : '\n'}${line}`;
    }
    return numbers;
  });

  protected readonly language = computed(() => this.tab().language ?? 'text');
  protected readonly size = computed(() => formatBytes(this.tab().size ?? 0));

  protected reload(): void {
    this.tabs.reload(this.tab().id);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
