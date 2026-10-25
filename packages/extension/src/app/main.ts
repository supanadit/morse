import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createPiRpcAdapter, findOnPathBinary, type PiRpcAdapterConfig } from '@morse/integration-pi';
import { findOpenCodeBinary, openOpenCodeEngine } from '@morse/integration-opencode';
import { AgentRouter, ChatService, FileSessionStore, SessionRegistry } from '@morse/system';
import { bindTranscriptsToRegistry, SessionTranscriptStore } from '@morse/system';
import {
  FRONTEND_MANIFEST_FILE,
  PROTOCOL_VERSION,
  frontendIdentity,
  parseFrontendManifest,
  type FrontendManifest,
} from '@morse/protocol';
import { MorseChatViewProvider } from '../internal/vscode/chat-view-provider';
import {
  readDefaultEngine,
  readHotLimit,
  readOpenCodeConfig,
  readPiAdapterConfig,
  readWorkspaceRef,
  readWorkspaceRoots,
} from '../internal/vscode/config';
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
  const openCodeConfig = readOpenCodeConfig();
  const env = await resolveSpawnEnv(piConfig, openCodeConfig, logger);
  const adapter = createPiRpcAdapter(
    {
      ...piConfig,
      removeSessionFile: deleteSessionFile,
      clientVersion: frontendIdentity(manifest)?.version,
      // Derived session stats (speed) live beside this window's other state,
      // exactly like the workbench layout.
      dataDir: workbenchDataDir(context),
      ...(env ? { env } : {}),
    },
    logger,
  );
  const workspace = readWorkspaceRef();

  // Morse's index lives in the extension's *global* storage: the derived ids are
  // the same in every window, and the sidebar should keep listing a session
  // after another window created it. The shell layout stays per-workspace.
  // OpenCode registers only when this window can reach it: a configured server,
  // or a binary on PATH (including the login shell's, resolved above). A
  // pi-only window never starts an OpenCode server.
  const openCode = await openOpenCodeEngine({
    logger,
    ...openCodeConfig,
    ...(env ? { env } : {}),
    maxSessionsPerProject: piConfig.maxSessionsPerProject,
  });
  const defaultIsOpenCode = readDefaultEngine() === 'opencode' && openCode !== undefined;

  const store = new FileSessionStore(join(context.globalStorageUri.fsPath, 'sessions'));
  const router = new AgentRouter({ store, defaultWorkspace: workspace, logger });
  router.register(adapter.engine, { catalog: adapter.catalog, default: !defaultIsOpenCode });
  if (openCode !== undefined) {
    router.register(openCode.engine, { catalog: openCode.catalog, default: defaultIsOpenCode });
  }

  const extras = router.defaultExtras();
  const sessions = new SessionRegistry({
    factory: router,
    catalog: router,
    defaultWorkspace: workspace,
    hotLimit: readHotLimit(),
    logger,
    engines: router.registeredEngines(),
  });
  const chat = new ChatService({ agent: sessions, logger });
  const editor = new VsCodeContextProvider();

  const transcripts = new SessionTranscriptStore();
  // Warm transcripts follow the registry's hot set: a session retired by the hot
  // limit drops its transcript and paging cursor with its process, instead of
  // holding them in the singleton store until the window closes.
  const detachTranscripts = bindTranscriptsToRegistry(sessions, transcripts);

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
    ...(extras?.mcp === undefined ? {} : { mcp: extras.mcp }),
    inspector: adapter.inspector,
    ...(extras?.prompts === undefined ? {} : { prompts: extras.prompts }),
    mcpAvailable: extras?.mcp !== undefined && extras.cli !== undefined,
    ...(extras?.version === undefined ? {} : { piVersion: extras.version() }),
    workbenchDataDir: workbenchDataDir(context),
  });

  context.subscriptions.push(
    logger,
    { dispose: () => void sessions.dispose() },
    // Engine-wide resources (an owned OpenCode server, its stream) stop with the
    // window; an attached server and pi's per-session processes are untouched by
    // this — the registry above already disposed the sessions.
    {
      dispose: () => {
        for (const engine of router.registeredEngines()) {
          void engine.dispose?.();
        }
      },
    },
    { dispose: detachTranscripts },
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
 * The environment the adapters resolve and spawn with.
 *
 * VS Code started from the Dock/launcher does not source the user's profile, so
 * a `pi` (or `opencode`) installed through nvm, asdf, volta or fnm is on the
 * login shell's PATH but not the extension host's — the setup screen then claims
 * the agent is missing while it works in the integrated terminal. Only when an
 * engine is not already visible do we pay for running the login shell, and an
 * explicit path always wins. The enriched PATH is handed to both adapters, so a
 * spawned agent finds its own `node` too.
 */
async function resolveSpawnEnv(
  piConfig: Pick<PiRpcAdapterConfig, 'piPath'>,
  openCodeConfig: { url?: string; bin?: string },
  logger: OutputChannelLogger,
): Promise<NodeJS.ProcessEnv | undefined> {
  const piVisible =
    piConfig.piPath !== undefined || findOnPathBinary('pi', process.env) !== undefined;
  const openCodeVisible =
    openCodeConfig.url !== undefined ||
    openCodeConfig.bin !== undefined ||
    findOpenCodeBinary('opencode', process.env) !== undefined;
  if (piVisible && openCodeVisible) {
    return undefined;
  }
  const path = await loginShellPath(process.env);
  if (path === undefined) {
    return undefined;
  }
  const enriched = { ...process.env, PATH: path };
  const gainedPi = !piVisible && findOnPathBinary('pi', enriched) !== undefined;
  const gainedOpenCode = !openCodeVisible && findOpenCodeBinary('opencode', enriched) !== undefined;
  if (!gainedPi && !gainedOpenCode) {
    return undefined;
  }
  logger.info(
    `An agent was not on the extension host PATH; using the login shell PATH instead` +
      `${gainedPi ? ' (pi)' : ''}${gainedOpenCode ? ' (opencode)' : ''}`,
  );
  return enriched;
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
