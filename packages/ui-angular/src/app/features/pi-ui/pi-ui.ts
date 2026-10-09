import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MorseService } from '../../host/morse.service';

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
  styleUrl: './pi-ui.css',
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
