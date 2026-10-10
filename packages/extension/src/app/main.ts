import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { createPiRpcAdapter, findOnPathBinary, type PiRpcAdapterConfig } from '@morse/adapter-pi-rpc';
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
import { loginShellPath } from '../internal/vscode/shell-path';
import { warmFileIndex } from '../internal/vscode/workspace-index';

/**
 * VS Code composition root (clean-architecture R7). The only file that knows
 * both the concrete pi adapter and the VS Code delivery — exactly like
 * `packages/server/src/main.ts` does for the NestJS host. Wiring only.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new OutputChannelLogger();
  try {
    // A first-time window opens the folder untrusted, and trust can be granted
    // while the sidebar view is already visible. A trust change does not re-fire
    // `onView`, so without this an already-drawn panel would stay blank until a
    // manual window reload. Start on the trust grant instead.
    if (!vscode.workspace.isTrusted) {
      logger.info('Morse is waiting for the workspace to be trusted');
      const granted = vscode.workspace.onDidGrantWorkspaceTrust(() => {
        granted.dispose();
        void startHost(context, logger);
      });
      context.subscriptions.push(granted);
      return;
    }
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
  const piConfig = readPiAdapterConfig();
  const env = await resolvePiEnv(piConfig, logger);
  const adapter = createPiRpcAdapter(
    {
      ...piConfig,
      removeSessionFile: deleteSessionFile,
      clientVersion: frontendIdentity(manifest)?.version,
      ...(env ? { env } : {}),
    },
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
    mcp: adapter.mcp,
    inspector: adapter.inspector,
    prompts: adapter.prompts,
    mcpAvailable: adapter.describeCli() !== undefined,
    piVersion: adapter.version(),
    workbenchDataDir: workbenchDataDir(context),
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
    // A whole session in an editor tab. With no session named (the palette, a
    // keybinding) it asks which one; the sidebar's own session menu passes the
    // id it was opened on, so that click never asks.
    vscode.commands.registerCommand('morse.openSessionTab', (sessionId?: string, title?: string) =>
      typeof sessionId === 'string' && sessionId.length > 0
        ? provider.openSessionTab(sessionId, title)
        : provider.pickSessionTab(),
    ),
    vscode.commands.registerCommand('morse.showOutput', () => logger.show()),
  );
  // A window reload restores the MCP editor panel (and its half-filled form).
  provider.registerSerializers(context);

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

/**
 * Where this window stores its shell layout. `storageUri` is per-workspace, so two
 * windows on two folders keep their own sessions in front instead of fighting over
 * one file; a window with no folder open (an empty window) falls back to the
 * extension's global storage.
 */
function workbenchDataDir(context: vscode.ExtensionContext): string {
  return (context.storageUri ?? context.globalStorageUri).fsPath;
}

function describePi(adapter: { describe(): { source: string; command: string } }): string {
  try {
    const spawn = adapter.describe();
    return `${spawn.source} (${spawn.command})`;
  } catch (error: unknown) {
    return `not found (${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'})`;
  }
}

/**
 * The environment the pi adapter resolves and spawns with.
 *
 * VS Code started from the Dock/launcher does not source the user's profile, so
 * a `pi` installed through nvm, asdf, volta or fnm is on the login shell's PATH
 * but not the extension host's — the setup screen then claims pi is missing
 * while it works in the integrated terminal. Only when pi is not already visible
 * do we pay for running the login shell, and an explicit `morse.pi.path` always
 * wins. The enriched PATH is handed to the adapter as `env`, so the spawned pi
 * finds its own `node` too.
 */
async function resolvePiEnv(
  config: Pick<PiRpcAdapterConfig, 'piPath'>,
  logger: OutputChannelLogger,
): Promise<NodeJS.ProcessEnv | undefined> {
  if (config.piPath !== undefined || findOnPathBinary('pi', process.env) !== undefined) {
    return undefined;
  }
  const path = await loginShellPath(process.env);
  if (path === undefined || findOnPathBinary('pi', { ...process.env, PATH: path }) === undefined) {
    return undefined;
  }
  logger.info('pi was not on the extension host PATH; using the login shell PATH instead');
  return { ...process.env, PATH: path };
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
