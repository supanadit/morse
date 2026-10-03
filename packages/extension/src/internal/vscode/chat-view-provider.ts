import * as vscode from 'vscode';
import {
  ChatService,
  SessionRegistry,
  UnsupportedByHostError,
  type EditorContextProvider,
  type MorseLogger,
} from '@morse/core';
import {
  HostSessionController,
  type HostSessionServices,
  type ProjectPolicy,
  type SessionTranscriptStore,
} from '@morse/host-runtime';
import {
  parseClientMessage,
  type ClientToHostMessage,
  type HostCapabilities,
  type HostToClientMessage,
  type NoticeLevel,
} from '@morse/protocol';
import { VsCodeDialogs } from './vscode-dialogs';
import { renderWebviewHtml } from './webview-html';
import { SelectionPreviewTracker } from './selection-preview';
import { workspaceFiles } from './workspace-index';

export interface ChatViewProviderDeps {
  registry: SessionRegistry;
  transcripts: SessionTranscriptStore;
  chat: ChatService;
  editor: EditorContextProvider;
  policy: ProjectPolicy;
  /** Directories this window is scoped to. */
  roots: string[];
  logger: MorseLogger & { show(): void };
  webviewRoot: vscode.Uri;
  frontend?: { name: string; version: string };
}

/** What this host can do — the frontend reads this instead of guessing. */
const CAPABILITIES: HostCapabilities = {
  hostKind: 'vscode',
  // VS Code is scoped to the folders this window has open:
  // no project switcher, only sessions inside them.
  scope: 'workspace',
  // The host can answer `getEditorContext` so the frontend can pin a selection
  // chip; the context itself is an attachment, never prompt text.
  editorContext: true,
  // The host streams what the user selects (`context/selectionLive`), so the
  // composer can show a live chip that follows the drag until it is clicked.
  selectionLive: true,
  nativeDialogs: true,
  insertIntoEditor: true,
  revealFile: true,
  filePicker: true,
  // pi's fork re-parents the conversation, so a past prompt can be edited.
  editMessage: true,
  // The same fork can branch a new session and hand the prompt back instead.
  forkMessage: true,
  // The panel may ask the registry for the latest release, so a reader of a VSIX
  // installed by hand still hears about a newer one. VS Code itself only does
  // that for a Marketplace install. The webview's CSP names the registry origin
  // for exactly this request (see `webview-html.ts`).
  updateCheck: true,
};

/**
 * Driving adapter: hosts the Morse chat webview inside VS Code and bridges it to
 * `HostSessionController` — the same controller the NestJS host uses.
 */
export class MorseChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'morse.chat';

  private controller: HostSessionController | undefined;
  private view: vscode.WebviewView | undefined;
  private frontendConnected = false;

  constructor(private readonly deps: ChatViewProviderDeps) {}

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.deps.webviewRoot],
    };

    try {
      view.webview.html = await renderWebviewHtml(view.webview, this.deps.webviewRoot, {
        title: 'Morse',
        frontend: this.deps.frontend,
      });
    } catch (error: unknown) {
      // A rejected resolveWebviewView leaves the panel blank with no explanation,
      // so a failure to read the bundle is shown in the webview itself.
      this.deps.logger.error('Could not load the Morse frontend bundle', error);
      view.webview.html = renderFailureHtml(
        'Morse could not load its frontend bundle.',
        describeError(error),
        'Run `npm run build:ui && npm run sync-webview` in packages/extension, then reload the window.',
      );
      return;
    }

    const services: HostSessionServices = {
      registry: this.deps.registry,
      chat: this.deps.chat,
    };

    const controller = new HostSessionController({
      services,
      capabilities: CAPABILITIES,
      emit: (message) => this.post(message),
      logger: this.deps.logger,
      dialogs: new VsCodeDialogs(),
      transcripts: this.deps.transcripts,
      // The registry belongs to the window, not to the webview.
      ownsRegistry: false,
      // Do not spawn a session on load: an empty panel must stay empty until the
      // user actually says something. Every reload used to create a throwaway
      // "New session".
      autoOpen: false,
      policy: this.deps.policy,
      scope: { kind: 'workspace', roots: this.deps.roots },
      frontend: this.deps.frontend,
      onHostCommand: (command, args) => this.runHostCommand(command, args),
      agentHint: 'Set "morse.pi.path" or install the pi CLI so that it is on PATH.',
    });
    this.controller = controller;

    // Live selection preview: the chip in the composer follows what the user is
    // drawing in the editor, in real time, until they click it to lock it. The
    // tracker dies with the view, so the host stops posting into a dead webview.
    const liveSelection = new SelectionPreviewTracker((preview) =>
      this.post({ type: 'context/selectionLive', payload: preview }),
    );
    // Something may already be selected right now (the user selected, then
    // opened the panel): show it, do not wait for a selection event.
    liveSelection.flush();

    const subscription = view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseClientMessage(raw);
      if (!message) {
        this.deps.logger.warn('Ignoring an unrecognised webview message');
        return;
      }
      // The handshake is the only proof that the frontend actually booted inside
      // the webview; a blank panel and a silent log look identical otherwise.
      if (message.type === 'client/ready' && !this.frontendConnected) {
        this.frontendConnected = true;
        this.deps.logger.info(
          `The Morse webview connected${this.deps.frontend ? ` (${this.deps.frontend.name}@${this.deps.frontend.version})` : ''}`,
        );
        // The webview booted fresh, so it does not know about the preview we
        // already posted while it was starting up: repost the current state.
        liveSelection.flush();
      }
      void controller.handleClientMessage(message);
    });

    view.onDidDispose(() => {
      subscription.dispose();
      liveSelection.dispose();
      this.controller = undefined;
      this.view = undefined;
      // A reload re-resolves this view with a fresh webview, so treat it as a
      // brand-new frontend: the next handshake logs again instead of being
      // swallowed by the stale "already connected" flag.
      this.frontendConnected = false;
      void controller.dispose();
    });

    try {
      await controller.start();
    } catch (error: unknown) {
      // The webview is already showing, so report this where the user can see it
      // instead of failing the whole view.
      this.deps.logger.error('Morse could not start its session controller', error);
      this.postNotice('error', `Morse could not start: ${describeError(error)}`);
    }
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${MorseChatViewProvider.viewType}.focus`);
  }

  async newSession(): Promise<void> {
    await this.dispatch({ type: 'session/new', payload: {} });
  }

  async attachSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Morse: select some text in the editor first.');
      return;
    }
    if (!this.view) {
      // The chip lives in the chat webview, so an unpinned webview cannot show it.
      void vscode.window.showInformationMessage('Morse: open the chat panel first.');
      return;
    }
    // The frontend owns the attachment: it renders the chip and the prompt keeps
    // the words the user typed. The host only reports what it can see.
    this.post({
      type: 'context/selection',
      payload: toSelectionPayload(vscode.workspace.asRelativePath(editor.document.uri, false), editor),
    });
  }

  postNotice(level: NoticeLevel, text: string): void {
    this.post({ type: 'notice', payload: { level, text, at: Date.now() } });
  }

  private async dispatch(message: ClientToHostMessage): Promise<void> {
    if (!this.controller) {
      await this.focus();
      this.postNotice('warn', 'Morse chat is still starting — try again in a moment.');
      return;
    }
    await this.controller.handleClientMessage(message);
  }

  private post(message: HostToClientMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private async runHostCommand(
    command: string,
    args: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    switch (command) {
      case 'listFiles': {
        // Feeds the frontend's file picker. A webview cannot read the workspace,
        // and VS Code does not deliver Explorer drags to it, so this is how files
        // get attached in this host.
        const files = await workspaceFiles(this.deps.logger);
        // The count is reported to the UI as well: an empty picker with this
        // number in front of it is diagnosable without opening any devtools.
        this.postNotice(
          files.length === 0 ? 'warn' : 'info',
          files.length === 0
            ? 'No workspace files were found for the picker.'
            : `File picker: ${files.length} workspace files.`,
        );
        return { files };
      }
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'morse.');
        return;
      case 'showOutput':
        this.deps.logger.show();
        return;
      case 'copyToClipboard':
        await vscode.env.clipboard.writeText(stringArg(args, 'text'));
        return;
      case 'insertIntoEditor': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          throw new UnsupportedByHostError('There is no active editor to insert into.');
        }
        const text = stringArg(args, 'text');
        await editor.edit((builder) => builder.insert(editor.selection.active, text));
        return;
      }
      case 'getEditorContext': {
        // Read-only editor snapshot for the frontend's pinned-selection chip;
        // what the agent should read is decided by the user in the composer.
        return this.deps.editor.snapshot();
      }
      case 'revealFile': {
        const raw = stringArg(args, 'path');
        if (!raw) {
          throw new UnsupportedByHostError('revealFile needs a "path" argument.');
        }
        const document = await vscode.workspace.openTextDocument(toWorkspacePath(raw));
        await vscode.window.showTextDocument(document, { preview: true });
        return;
      }
      case 'confirmDeleteSession': {
        // Deleting a stored conversation cannot be undone, so VS Code asks with
        // its own modal warning. The browser host has no native dialogs and
        // renders the question in the session menu instead (see `nativeDialogs`
        // in the capabilities).
        const title = stringArg(args, 'title');
        const answer = await vscode.window.showWarningMessage(
          `Delete \u201c${title || 'this session'}\u201d and its conversation? This cannot be undone.`,
          { modal: true },
          'Delete',
        );
        return { confirmed: answer === 'Delete' };
      }
      default:
        throw new UnsupportedByHostError(`VS Code does not implement "${command}".`);
    }
  }
}

/**
 * Shown when the frontend bundle itself cannot be loaded. Without this the view
 * would just be blank, which tells the user (and us) nothing.
 */
function stringArg(args: Record<string, unknown> | undefined, key: string): string {
  const value = args?.[key];
  return typeof value === 'string' ? value : '';
}

/** The selection lines of an editor, if any, as a `context/selection` payload. */
function toSelectionPayload(
  path: string,
  editor: vscode.TextEditor,
): { path: string; startLine?: number; endLine?: number } {
  const selection = editor.selection;
  if (selection.isEmpty) {
    return { path };
  }
  return {
    path,
    startLine: selection.start.line + 1,
    endLine: selection.end.line + 1,
  };
}

/** Mention paths are workspace-relative; the editor usually wants an absolute one. */
function toWorkspacePath(path: string): vscode.Uri {
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

function renderFailureHtml(title: string, detail: string, hint: string): string {
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}
