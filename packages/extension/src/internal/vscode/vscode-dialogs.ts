import * as vscode from 'vscode';
import type { NativeDialogs } from '@morse/host-runtime';

/**
 * `NativeDialogs` implemented with VS Code UI. Because this host answers agent
 * interaction requests itself, the webview never shows the browser fallback form
 * (that is what `capabilities.nativeDialogs` communicates).
 */
export class VsCodeDialogs implements NativeDialogs {
  async select(
    request: Parameters<NativeDialogs['select']>[0],
  ): Promise<string | undefined> {
    const items = request.options.map((option) => ({
      label: option.label,
      description: option.description,
      value: option.value,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: request.title,
      placeHolder: request.message,
      ignoreFocusOut: true,
    });
    return picked?.value;
  }

  async confirm(request: Parameters<NativeDialogs['confirm']>[0]): Promise<boolean> {
    const answer = await vscode.window.showWarningMessage(
      `${request.title}\n\n${request.message}`,
      { modal: true },
      'Yes',
      'No',
    );
    return answer === 'Yes';
  }

  async input(request: Parameters<NativeDialogs['input']>[0]): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: request.title,
      placeHolder: request.placeholder,
      value: request.value ?? '',
      ignoreFocusOut: true,
    });
  }

  async editor(request: Parameters<NativeDialogs['editor']>[0]): Promise<string | undefined> {
    const document = await vscode.workspace.openTextDocument({
      content: request.value ?? '',
      language: request.language ?? 'markdown',
    });
    await vscode.window.showTextDocument(document, { preview: false });
    const answer = await vscode.window.showInformationMessage(
      `Morse: edit the document, then submit it to the agent.`,
      'Submit',
      'Cancel',
    );
    return answer === 'Submit' ? document.getText() : undefined;
  }
}
