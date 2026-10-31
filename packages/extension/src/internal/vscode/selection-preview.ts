import * as vscode from 'vscode';
import { selectionSpan } from '@morse/system';

/** What the host reports about the editor's current state. */
export interface LiveSelectionPreview {
  path: string;
  /**
   * 1-based; missing together with `endLine` when nothing is selected, which
   * means the whole focused file is the preview, not that there is no preview.
   */
  startLine?: number;
  endLine?: number;
  /** 1-based first selected column, absent for a line-only preview. */
  startColumn?: number;
  /** 1-based last selected column. */
  endColumn?: number;
  /** Selected UTF-16 character count, line breaks included. */
  characters?: number;
  /** The selected words for a one-line selection, capped by the host. */
  text?: string;
}

/**
 * How often the host reports a moving selection. Leading + trailing throttle:
 * the first event posts at once (a drag feels realtime), and while events keep
 * arriving they coalesce into one trailing report instead of never firing.
 */
const SELECTION_REPORT_INTERVAL_MS = 100;

/**
 * Watches the editor and streams what it is showing before the user has pinned
 * anything: a selection while they drag it, and the merely focused file when
 * nothing is selected, like a chip that follows the editor. The frontend owns
 * what happens next — an unlocked chip that follows this stream until the user
 * clicks it to lock. The host only reports what it sees; the prompt itself is
 * never padded with editor state behind their back.
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

/**
 * The current state envelope, 1-based like everywhere else in Morse. A focused
 * file with no selection reports its path alone (the whole-file chip); no editor
 * at all clears the preview with an empty path.
 *
 * One non-empty selection keeps its exact columns, count and excerpt; several
 * carets collapse to the line envelope they cover, exactly like the span helper
 * in `@morse/system` decides.
 */
export function toLivePreview(editor: vscode.TextEditor | undefined): LiveSelectionPreview {
  if (!editor) {
    return { path: '' };
  }
  const path = vscode.workspace.asRelativePath(editor.document.uri, false);
  const span = toSpan(editor);
  // Focused, nothing selected: the whole file is the preview.
  return span === undefined ? { path } : { path, ...span };
}

/** The shared span for the editor's current selections, if any. */
function toSpan(editor: vscode.TextEditor) {
  return selectionSpan(
    editor.selections,
    (selection) =>
      editor.document.getText(
        new vscode.Range(
          selection.start.line,
          selection.start.character,
          selection.end.line,
          selection.end.character,
        ),
      ),
    (line) => editor.document.lineAt(line).text.length,
  );
}