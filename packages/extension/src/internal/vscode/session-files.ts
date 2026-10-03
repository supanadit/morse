import * as vscode from 'vscode';

/**
 * Deleting a stored session the VS Code way: through the workspace filesystem
 * rather than `fs.unlink`. Two reasons this is not the same as the browser host:
 * the URI goes through whatever filesystem the window is using (a remote or
 * virtual workspace included), and the file lands in the OS trash, so a session
 * deleted by mistake is recoverable instead of gone.
 *
 * `@morse/adapter-pi-rpc` stays editor-free — the composition root injects this
 * as the catalog's `removeFile`.
 */
export async function deleteSessionFile(path: string): Promise<void> {
  await vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: true });
}
