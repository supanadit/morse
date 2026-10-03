import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { createPiRpcAdapter } from '@morse/adapter-pi-rpc';
import { ChatService, SessionRegistry } from '@morse/core';
import { SessionTranscriptStore } from '@morse/host-runtime';
import {
  FRONTEND_MANIFEST_FILE,
  PROTOCOL_VERSION,
  frontendIdentity,
  parseFrontendManifest,
  type FrontendManifest,
} from '@morse/protocol';
import { MorseChatViewProvider } from '../internal/vscode/chat-view-provider';
import { readHotLimit, readPiAdapterConfig, readWorkspaceRef, readWorkspaceRoots } from '../internal/vscode/config';
import { OutputChannelLogger } from '../internal/vscode/logger';
import { VsCodeProjectPolicy } from '../internal/vscode/project-policy';
import { VsCodeContextProvider } from '../internal/vscode/vscode-context-provider';
import { deleteSessionFile } from '../internal/vscode/session-files';
import { warmFileIndex } from '../internal/vscode/workspace-index';

/**
 * VS Code composition root (clean-architecture R7). The only file that knows
 * both the concrete pi adapter and the VS Code delivery — exactly like
 * `packages/server/src/main.ts` does for the NestJS host. Wiring only.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new OutputChannelLogger();
  try {
    await startHost(context, logger);
  } catch (error: unknown) {
    // An unhandled activation error leaves the view contributed by the manifest
    // but never registered, which looks exactly like a blank panel.
    logger.error('Morse failed to activate', error);
    const action = await vscode.window.showErrorMessage(
      `Morse could not start: ${describeError(error)}`,
      'Show log',
    );
    if (action === 'Show log') {
      logger.show();
    }
  }
}

async function startHost(context: vscode.ExtensionContext, logger: OutputChannelLogger): Promise<void> {
  const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'webview');
  const manifest = await readFrontendManifest(webviewRoot);

  if (!manifest) {
    logger.warn(
      'No frontend build found in media/webview. Run `npm run sync-webview` in packages/extension.',
    );
  } else if (manifest.protocolVersion !== PROTOCOL_VERSION) {
    logger.error(
      `Frontend ${manifest.name}@${manifest.version} speaks protocol ${manifest.protocolVersion}, ` +
        `but this host speaks ${PROTOCOL_VERSION}. Rebuild the webview bundle.`,
    );
  }

  // The catalog deletes a session the VS Code way (workspace filesystem, into
  // the OS trash); the browser host keeps the adapter's default `unlink`.
  const adapter = createPiRpcAdapter(
    { ...readPiAdapterConfig(), removeSessionFile: deleteSessionFile },
    logger,
  );
  const workspace = readWorkspaceRef();

  const sessions = new SessionRegistry({
    factory: adapter.factory,
    catalog: adapter.catalog,
    defaultWorkspace: workspace,
    hotLimit: readHotLimit(),
    logger,
  });
  const chat = new ChatService({ agent: sessions, logger });
  const editor = new VsCodeContextProvider();

  const transcripts = new SessionTranscriptStore();

  const provider = new MorseChatViewProvider({
    registry: sessions,
    transcripts,
    chat,
    editor,
    policy: new VsCodeProjectPolicy(),
    roots: readWorkspaceRoots(),
    logger,
    webviewRoot,
    frontend: frontendIdentity(manifest),
  });

  context.subscriptions.push(
    logger,
    { dispose: () => void sessions.dispose() },
    { dispose: () => transcripts.dispose() },
    vscode.window.registerWebviewViewProvider(MorseChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('morse.openChat', () => provider.focus()),
    vscode.commands.registerCommand('morse.newSession', () => provider.newSession()),
    vscode.commands.registerCommand('morse.attachSelection', () => provider.attachSelection()),
    vscode.commands.registerCommand('morse.showOutput', () => logger.show()),
  );

  // Index the workspace while the user is still reading the panel, so the file
  // picker opens with its list ready.
  warmFileIndex(logger);

  logger.info(
    `Morse activated — workspace ${workspace.cwd}, pi from ${describePi(adapter)}` +
      (manifest ? `, frontend ${manifest.name}@${manifest.version}` : ''),
  );
}

export function deactivate(): void {
  // Nothing else to do: every disposable is registered in the extension context.
}

function describePi(adapter: { describe(): { source: string; command: string } }): string {
  try {
    const spawn = adapter.describe();
    return `${spawn.source} (${spawn.command})`;
  } catch (error: unknown) {
    return `not found (${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'})`;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

async function readFrontendManifest(
  webviewRoot: vscode.Uri,
): Promise<FrontendManifest | undefined> {
  const manifestUri = vscode.Uri.joinPath(webviewRoot, FRONTEND_MANIFEST_FILE);
  const raw = await readFile(manifestUri.fsPath, 'utf8').catch(() => undefined);
  return parseFrontendManifest(raw);
}
