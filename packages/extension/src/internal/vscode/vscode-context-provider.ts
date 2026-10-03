import * as vscode from 'vscode';
import type { EditorContextProvider, EditorContextSnapshot } from '@morse/core';

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

    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;

    return Promise.resolve({
      path: vscode.workspace.asRelativePath(editor.document.uri, false),
      languageId: editor.document.languageId,
      selection:
        editor && hasSelection
          ? {
              startLine: selection.start.line + 1,
              endLine: selection.end.line + 1,
              text: editor.document.getText(selection),
            }
          : undefined,
      openEditors: vscode.window.visibleTextEditors.map((visible) =>
        vscode.workspace.asRelativePath(visible.document.uri, false),
      ),
    });
  }
}