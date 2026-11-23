/**
 * The VS Code panel's pure helpers: argument readers, selection payloads and the
 * failure page shown when the webview itself cannot load.
 */
import * as vscode from 'vscode';
import { selectionSpan } from '@morse/system';
import { escapeHtml } from './webview-html';

/** The span of an editor's current selections, if any. */
export function selectionSpanOf(editor: vscode.TextEditor) {
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

/** The selection span of an editor, if any, as a `context/selection` payload. */
export function toSelectionPayload(
  path: string,
  editor: vscode.TextEditor,
): {
  path: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  characters?: number;
  text?: string;
} {
  const span = selectionSpanOf(editor);
  return span === undefined ? { path } : { path, ...span };
}

/** Mention paths are workspace-relative; the editor usually wants an absolute one. */
export function toWorkspacePath(path: string): vscode.Uri {
  const roots = vscode.workspace.workspaceFolders ?? [];
  const inside = roots.some(
    (root) =>
      path === root.uri.fsPath ||
      path.startsWith(`${root.uri.fsPath}${process.platform === 'win32' ? '\\' : '/'}`),
  );
  if (inside || roots.length === 0) {
    return vscode.Uri.file(path);
  }
  return vscode.Uri.joinPath(roots[0]!.uri, path);
}

/**
 * Shown when the frontend bundle itself cannot be loaded. Without this the view
 * would just be blank, which tells the user (and us) nothing.
 */
export function renderFailureHtml(title: string, detail: string, hint: string): string {
  const csp = `default-src 'none'; style-src 'unsafe-inline'`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
</head>
<body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px">
  <strong>${escapeHtml(title)}</strong>
  <p style="color: var(--vscode-descriptionForeground)">${escapeHtml(detail)}</p>
  <p style="color: var(--vscode-descriptionForeground)">${escapeHtml(hint)}</p>
</body>
</html>`;
}
