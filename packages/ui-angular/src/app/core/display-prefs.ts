import { Injectable, signal } from '@angular/core';

/**
 * How a turn's tool calls read:
 *
 * - `compact` (default): one summary line per turn with the newest action as a
 *   preview, and the steps as a tree with file children. Thinking notes are
 *   folded into the tree nodes, and detail is a click away.
 * - `timeline` (legacy): the detailed cards — every tool call and thinking note
 *   as its own row, and the live turn opens itself so progress is visible.
 *
 * The default is deliberately the calmer one; the toggle is there for readers
 * who want the old, always-open cards back.
 */
export type ToolDisplay = 'timeline' | 'compact';

/**
 * Where the choice is remembered. A webview or a browser with storage disabled
 * simply forgets it — the toggle still works for the session.
 */
const TOOL_DISPLAY_KEY = 'morse.chat.toolDisplay';

function isToolDisplay(value: unknown): value is ToolDisplay {
  return value === 'timeline' || value === 'compact';
}

export function readToolDisplay(): ToolDisplay {
  try {
    const raw = globalThis.localStorage?.getItem(TOOL_DISPLAY_KEY);
    return isToolDisplay(raw) ? raw : 'compact';
  } catch {
    return 'compact';
  }
}

export function storeToolDisplay(display: ToolDisplay): void {
  try {
    globalThis.localStorage?.setItem(TOOL_DISPLAY_KEY, display);
  } catch {
    // Storage is a nicety, not a requirement: the signal still holds the choice.
  }
}

/**
 * Interface preferences that are not part of the wire protocol and not the
 * host's to decide — a browser and a VS Code webview read the same conversation,
 * so the display choice belongs to whoever is reading it.
 */
@Injectable({ providedIn: 'root' })
export class DisplayPrefs {
  private readonly toolDisplaySignal = signal<ToolDisplay>(readToolDisplay());
  readonly toolDisplay = this.toolDisplaySignal.asReadonly();

  setToolDisplay(display: ToolDisplay): void {
    this.toolDisplaySignal.set(display);
    storeToolDisplay(display);
  }

  /** `timeline` and `compact` are the only two, so a toggle is the whole choice. */
  toggleToolDisplay(): void {
    this.setToolDisplay(this.toolDisplaySignal() === 'compact' ? 'timeline' : 'compact');
  }
}
