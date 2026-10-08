import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MorseService } from '../../../host/morse.service';

/**
 * Pi's own TUI chrome, rendered by Morse: the text widgets and footer status
 * lines extensions set through `ctx.ui.setWidget` / `ctx.ui.setStatus`.
 *
 * RPC mode forwards those as plain strings (never component factories), so this
 * is a text strip — not a second terminal. It sits just above the bottom panel
 * in the browser host, and at the foot of the chat in VS Code, which has no
 * bottom panel. Both hosts share the agent state, so both render it.
 *
 * It belongs to the session in front: `state.widgets`/`state.statuses` are that
 * session's, and a draft has none.
 */
@Component({
  selector: 'morse-pi-ui',
  templateUrl: './pi-ui.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
      }
      .pi-ui {
        max-height: 180px;
        overflow-y: auto;
        padding: 5px 10px;
        border-top: 1px solid var(--morse-border);
        background: var(--morse-panel, var(--morse-bg));
        color: var(--morse-fg-muted);
        font-family: var(--morse-font-mono);
        font-size: 11.5px;
        line-height: 1.35;
      }
      .widget + .widget {
        margin-top: 4px;
      }
      .line {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .status {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 12px;
        margin-top: 4px;
      }
      .entry {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class PiUi {
  private readonly morse = inject(MorseService);

  /**
   * Pi's above-editor widgets first, then its below-editor ones, so the order is
   * stable without pretending Morse has the two separate slots pi's TUI has.
   */
  protected readonly widgets = computed(() => {
    const widgets = this.morse.state().widgets ?? [];
    return [
      ...widgets.filter((widget) => widget.placement === 'aboveEditor'),
      ...widgets.filter((widget) => widget.placement === 'belowEditor'),
    ];
  });
  protected readonly statuses = computed(() => this.morse.state().statuses ?? []);
  protected readonly visible = computed(
    () => this.widgets().length > 0 || this.statuses().length > 0,
  );
}
