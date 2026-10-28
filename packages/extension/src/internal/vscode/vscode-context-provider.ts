import * as vscode from 'vscode';
import { selectionSpan, type EditorContextProvider, type EditorContextSnapshot } from '@morse/system';

/**
 * `EditorContextProvider` implemented with the VS Code editor APIs. The host
 * only reads: what becomes an attachment (a pinned selection chip) is decided
 * by the user in the composer, and the prompt itself is never padded with
 * editor state behind their back (R8: no prompt editing outside the chat).
 */
export class VsCodeContextProvider implements EditorContextProvider {
  snapshot(): Promise<EditorContextSnapshot | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return Promise.resolve(undefined);
    }

    const span = selectionSpan(
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

    return Promise.resolve({
      path: vscode.workspace.asRelativePath(editor.document.uri, false),
      languageId: editor.document.languageId,
      ...(span === undefined ? {} : { selection: { ...span } }),
      openEditors: vscode.window.visibleTextEditors.map((visible) =>
        vscode.workspace.asRelativePath(visible.document.uri, false),
      ),
    });
  }
}
