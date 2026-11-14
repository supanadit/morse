import { Injectable, inject, signal } from '@angular/core';
import { ViewState } from '../host/view-state';

/**
 * Which product the shell shows: the code conversation, or bot mode's roster and
 * bot chats. Spelled as a union so a stored value this build cannot read falls
 * back to `code` instead of inventing a third mode.
 */
export type ShellMode = 'code' | 'bot';

const MODE_KEY = 'mode.current';
const BOT_CONVERSATION_KEY = 'mode.botConversation';

function isShellMode(value: unknown): value is ShellMode {
  return value === 'code' || value === 'bot';
}

/**
 * Where the reader was: the tab they were in (Code or Bot), and in bot mode the
 * conversation that was in front.
 *
 * Both are the reader's, not the host's — the same machine read from a browser
 * and from VS Code may want different ones — so they outlive the page through
 * `ViewState` (`localStorage` in a browser, the webview's own state in VS Code).
 * A reload then lands on the conversation they left, instead of dropping them in
 * Code mode with nothing open.
 *
 * The conversation is only a *memory*: the roster decides whether it still exists,
 * and bot mode forgets it when the host no longer lists it (see `BotNav`).
 */
@Injectable({ providedIn: 'root' })
export class ModePrefs {
  private readonly viewState = inject(ViewState);

  /** What was on record at start-up; anything this build cannot read falls back. */
  private readonly storedMode = this.viewState.read<unknown>(MODE_KEY);
  private readonly storedConversation = this.viewState.read<unknown>(BOT_CONVERSATION_KEY);

  private readonly modeSignal = signal<ShellMode>(isShellMode(this.storedMode) ? this.storedMode : 'code');
  /** The tab the shell was on when the page was last left. */
  readonly mode = this.modeSignal.asReadonly();

  private readonly botConversationSignal = signal<string | null>(
    typeof this.storedConversation === 'string' && this.storedConversation.length > 0
      ? this.storedConversation
      : null,
  );
  /** The bot conversation that was open, or `null` when none was. */
  readonly botConversation = this.botConversationSignal.asReadonly();

  setMode(mode: ShellMode): void {
    this.modeSignal.set(mode);
    this.viewState.write(MODE_KEY, mode);
  }

  /** Writes the open conversation down; `null` forgets one the host dropped. */
  rememberBotConversation(id: string | null): void {
    if (this.botConversationSignal() === id) {
      return;
    }
    this.botConversationSignal.set(id);
    this.viewState.write(BOT_CONVERSATION_KEY, id ?? undefined);
  }
}
