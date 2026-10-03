import * as vscode from 'vscode';

/** What the host reports about the editor's current selection. */
export interface LiveSelectionPreview {
  path: string;
  /** 1-based; missing together with `endLine` when nothing is selected. */
  startLine?: number;
  endLine?: number;
}

/**
 * How often the host reports a moving selection. Leading + trailing throttle:
 * the first event posts at once (a drag feels realtime), and while events keep
 * arriving they coalesce into one trailing report instead of never firing.
 */
const SELECTION_REPORT_INTERVAL_MS = 100;

/**
 * Watches the editor and streams the user's current selection before they have
 * pinned anything, like drawing a highlight that keeps counting lines while it
 * moves. The frontend owns what happens next — an unlocked chip that follows
 * this stream until the user clicks it to lock. The host only reports what it
 * sees; the prompt itself is never padded with editor state behind their back.
 */
export class SelectionPreviewTracker {
  /** One timer, so a storm of drag events costs one pending callback at most. */
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastReportedAt = 0;

  private readonly disposables: vscode.Disposable[];

  constructor(private readonly post: (preview: LiveSelectionPreview) => void) {
    this.disposables = [
      vscode.window.onDidChangeTextEditorSelection((event) => {
        // Inactive editors report too (pane switches, peek widgets); the chip
        // belongs to the editor the user is actually in.
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.track();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.track()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.track()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        // Editing the selected text shifts the numbers under the chip; report
        // without waiting for the next selection event to stay honest.
        const editor = vscode.window.activeTextEditor;
        if (editor && event.document === editor.document) {
          this.track();
        }
      }),
    ];
  }

  /** Reposts the current selection immediately, even if it has not changed. */
  flush(): void {
    this.lastReportedAt = Date.now();
    this.post(toLivePreview(vscode.window.activeTextEditor ?? undefined));
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private track(): void {
    const elapsed = Date.now() - this.lastReportedAt;
    if (elapsed >= SELECTION_REPORT_INTERVAL_MS) {
      this.flush();
      return;
    }
    if (this.timer !== undefined) {
      return;
    }
    // Trailing report: the last state of a burst is what the chip should keep,
    // so it catches the final numbers without waiting for a next event.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, SELECTION_REPORT_INTERVAL_MS - elapsed);
  }
}

/** The current selection envelope, 1-based like everywhere else in Morse. */
export function toLivePreview(editor: vscode.TextEditor | undefined): LiveSelectionPreview {
  if (!editor) {
    // No editor at all clears the preview; the path alone already does.
    return { path: '' };
  }
  const envelope = selectionEnvelope(editor.selections);
  const path = vscode.workspace.asRelativePath(editor.document.uri, false);
  if (!envelope) {
    // No (non-empty) selection: hide the chip, locked pins are unaffected.
    return { path };
  }
  return { path, startLine: envelope.startLine, endLine: envelope.endLine };
}

/**
 * One line span out of any number of disjoint selections: the envelope from
 * the earliest start to the latest end. Multi-cursor selections then read as a
 * single `start-end` on the chip, which matches how a user reports what they
 * highlighted ("this file, lines 150 to 200") rather than listing every range.
 */
export function selectionEnvelope(
  selections: readonly { isEmpty: boolean; start: { line: number }; end: { line: number } }[],
): { startLine: number; endLine: number } | undefined {
  let startLine: number | undefined;
  let endLine = 0;
  for (const selection of selections) {
    if (selection.isEmpty) {
      continue;
    }
    startLine = startLine === undefined ? selection.start.line : Math.min(startLine, selection.start.line);
    endLine = Math.max(endLine, selection.end.line);
  }
  if (startLine === undefined) {
    return undefined;
  }
  return { startLine: startLine + 1, endLine: endLine + 1 };
}