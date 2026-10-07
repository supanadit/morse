import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { App } from '../../app';
import { ViewState } from '../../core/view-state';

/**
 * One session as a whole document: the chat app embedded, with the Morse
 * sidebar left out because the host window already has one.
 *
 * A VS Code editor tab opens this bundle routed to `#/session?id=<id>`. The host
 * pins its `HostSessionController` to that same id, so the tab shows exactly
 * that conversation and its prompts, Stop and model picks stay in it — the tab
 * never switches to whatever the sidebar panel is showing.
 *
 * The id is read from the query rather than from `session/state` on purpose: a
 * pinned host already has the session in front, so this page has nothing to
 * decide, and a missing id is the only case worth wording.
 */
@Component({
  selector: 'morse-session-page',
  imports: [App],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (sessionId() === undefined) {
      <div class="missing" role="alert">
        <strong>This tab is not bound to a session.</strong>
        <p>Open one from the Morse sidebar's session menu instead.</p>
      </div>
    } @else {
      <app-root [embedded]="true" />
    }
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100vh;
        background: var(--morse-bg);
      }
      app-root {
        display: block;
        height: 100%;
      }
      .missing {
        padding: 16px;
        font-family: var(--vscode-font-family, system-ui);
        color: var(--vscode-foreground, #ccc);
      }
      .missing p {
        color: var(--vscode-descriptionForeground, #999);
      }
    `,
  ],
})
export class SessionPage {
  /**
   * The session this tab is, from `?id=`. Stable for the tab's life: the host
   * pins the controller to the same id and never tells the tab otherwise.
   */
  protected readonly sessionId = computed(() => sessionIdFromLocation());

  constructor() {
    // Record which session this tab shows, in the host's webview state, so a
    // window reload can restore the tab pinned to the same conversation (the
    // extension reads the same key in `registerWebviewPanelSerializer`).
    const id = this.sessionId();
    if (id !== undefined) {
      inject(ViewState).write(SESSION_TAB_STATE_KEY, id);
    }
  }
}

/**
 * The webview-state key the extension reads back on restore. It is `morse.view.`
 * prefixed because `ViewState` namespaces everything it writes that way.
 */
const SESSION_TAB_STATE_KEY = 'sessionTab';

/** The `id` query parameter of the current hash route, when it is set. */
function sessionIdFromLocation(): string | undefined {
  if (typeof location === 'undefined') {
    return undefined;
  }
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const query = hash.split('?')[1];
  if (query === undefined) {
    return undefined;
  }
  const id = new URLSearchParams(query).get('id');
  return id !== null && id.length > 0 ? id : undefined;
}
