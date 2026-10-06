import { Inject, Injectable } from '@nestjs/common';
import { ChatService, SessionRegistry, UnsupportedByHostError, type MorseLogger } from '@morse/core';
import type { PiRpcAdapter } from '@morse/adapter-pi-rpc';
import { parseMcpServerInput, parseMcpServerSpec } from '@morse/adapter-pi-rpc';
import {
  HostSessionController,
  type HostCommandContext,
  type HostSessionServices,
  type SessionTranscriptStore,
} from '@morse/host-runtime';
import type { HostCapabilities, HostToClientMessage } from '@morse/protocol';
import type { MorseServerConfig } from '../../app/config.js';
import {
  MORSE_CONFIG,
  MORSE_LOGGER,
  MORSE_PI_ADAPTER,
  MORSE_PROJECT_POLICY,
  MORSE_SESSION_REGISTRY,
  MORSE_TRANSCRIPT_STORE,
} from '../../app/tokens.js';
import { saveUpload } from '../uploads/upload-store.js';
import { browseDirectory } from '../workspace/directory-browser.js';
import { readWorkspaceFile } from '../workspace/file-store.js';
import {
  checkoutGit,
  commitGit,
  pullGit,
  pushGit,
  readCommitDiff,
  readCommitFiles,
  readGitBranches,
  readGitDiff,
  readGitLog,
  readGitStatus,
  readGitSync,
  stageGitPaths,
  unstageGitPaths,
} from '../workspace/git-log.js';
import { workspaceFiles } from '../workspace/workspace-index.js';
import { readWorkbench, saveWorkbench, readDrafts, saveDrafts } from '../workspace/workbench-store.js';
import { ServerProjectPolicy } from '../projects/project-policy.js';
import { ServerTerminalBackend } from '../terminal/terminal.service.js';

/**
 * Composition root for one client connection (clean-architecture R7): the only
 * place that knows the concrete pi adapter, the core services and the WebSocket
 * delivery. Wiring only — no business logic lives here.
 *
 * The session registry is shared by every connection, so sessions and projects
 * keep running while clients come and go.
 */
@Injectable()
export class MorseSessionFactory {
  constructor(
    @Inject(MORSE_SESSION_REGISTRY) private readonly registry: SessionRegistry,
    @Inject(MORSE_TRANSCRIPT_STORE) private readonly transcripts: SessionTranscriptStore,
    @Inject(MORSE_PROJECT_POLICY) private readonly policy: ServerProjectPolicy,
    @Inject(MORSE_LOGGER) private readonly logger: MorseLogger,
    @Inject(MORSE_CONFIG) private readonly config: MorseServerConfig,
    @Inject(ServerTerminalBackend) private readonly terminal: ServerTerminalBackend,
    @Inject(MORSE_PI_ADAPTER) private readonly pi: PiRpcAdapter,
  ) {}

  capabilities(): HostCapabilities {
    return {
      hostKind: 'server',
      // The browser host is global: every project pi knows about.
      scope: 'global',
      // A browser has no local editor to read, so there is nothing to pin.
      editorContext: false,
      // No QuickPick/InputBox here, so the frontend renders interactions.
      nativeDialogs: false,
      insertIntoEditor: false,
      revealFile: false,
      // The server can walk the active session's directory, so the composer's
      // `@` picker works here too — the same list VS Code offers for a workspace.
      filePicker: true,
      // A browser has no editor of its own, so this host reads files for the
      // frontend's Explorer and preview tabs. VS Code keeps its native ones.
      filePreview: true,
      // The same reasoning for history: VS Code has Source Control, so the
      // browser host is the one that answers `gitLog` for its own git panel.
      gitPanel: true,
      // VS Code already has an integrated terminal; the browser host has none, so
      // the bottom panel's terminal is this host's. It runs in the viewing
      // session's directory and is gated by `ProjectPolicy`, like a session.
      terminal: true,
      // The browser host restores the tabs, panel, terminals and half-written
      // prompts the reader left open, kept under `<MORSE_HOME>`. VS Code has its
      // own tab restoration and leaves this off.
      workbench: true,
      // A browser cannot hand a dragged file's path to pi, so the host takes the
      // bytes and writes them next to the session; the frontend then `@mentions`
      // the path it gets back.
      fileUpload: true,
      // The browser host has no workspace folder, so "New session" has to ask
      // which directory the agent should run in. The frontend opens its folder
      // modal; VS Code has a folder already and leaves this off.
      directoryPicker: true,
      // pi's fork re-parents the conversation, so a past prompt can be edited.
      editMessage: true,
      // The same fork can branch a new session and hand the prompt back instead.
      forkMessage: true,
      // A page served by this host may ask the registry for the latest release, so
      // the sidebar can say when a newer Morse is out. A host without it stays
      // quiet; this one is on unless `MORSE_UPDATE_CHECK=0` says otherwise.
      updateCheck: this.config.updateCheck,
      // The same notice covers pi itself: the version this host runs, so the
      // frontend can compare it against the published one.
      piVersion: this.pi.version(),
      // Managing MCP servers runs the `pi` CLI, so this host offers it only when
      // it found one. A host without it hides the affordance.
      mcp: this.pi.describeCli() !== undefined,
    };
  }

  createFor(emit: (message: HostToClientMessage) => void): HostSessionController {
    const services: HostSessionServices = {
      registry: this.registry,
      chat: new ChatService({ agent: this.registry, logger: this.logger }),
    };

    return new HostSessionController({
      services,
      capabilities: this.capabilities(),
      emit,
      logger: this.logger,
      transcripts: this.transcripts,
      policy: this.policy,
      scope: { kind: 'global' },
      // The bundle this host serves, so the panel can name its own version.
      ...(this.config.frontend ? { frontend: this.config.frontend } : {}),
      // The registry outlives this connection on purpose.
      ownsRegistry: false,
      // A page load must not create a session; the first prompt opens one.
      autoOpen: false,
      onHostCommand: (command, args, context) => this.runHostCommand(command, args, context),
      // The bottom panel's shell: this host can spawn one on its own machine.
      terminal: this.terminal,
      agentHint:
        'Install the pi CLI and make sure it is on PATH, or start the server with MORSE_PI_PATH set.',
    });
  }

  /**
   * The host commands this host answers: browsing the filesystem for a project
   * folder, listing the active session's files for the composer's `@mention`
   * picker, and writing a browser upload down next to the session.
   *
   * `listDirectories` is read-only and may look anywhere the server can read;
   * the commands that touch a session are scoped to its cwd (which
   * `ProjectPolicy` already approved when the session was opened), never to a
   * path the client names.
   */
  private async runHostCommand(
    command: string,
    args: Record<string, unknown> | undefined,
    context?: HostCommandContext,
  ): Promise<unknown> {
    switch (command) {
      case 'listDirectories': {
        // Feeds the frontend's "New session" folder modal. Browsing is harmless,
        // but the chosen folder still has to pass the policy before a session
        // may run there, so the result says so (`canOpen`).
        const requested = typeof args?.path === 'string' ? args.path : undefined;
        const listing = await browseDirectory(requested, {
          roots: this.policy.allowList,
          defaultPath: this.registry.defaultWorkspace.cwd,
        });
        return { ...listing, canOpen: this.policy.canOpen(listing.path) };
      }
      case 'readWorkbench': {
        // The shell layout the reader left behind. Read-only and host-scoped (a
        // file under `MORSE_HOME`), so it never consults the project policy.
        return readWorkbench(this.config.dataDir) ?? null;
      }
      case 'saveWorkbench': {
        // The frontend owns the inner shape; the store guards version and size.
        return { ok: saveWorkbench(this.config.dataDir, args) };
      }
      case 'readDrafts': {
        // The half-written prompts, keyed by tab. Same host-scoped file as the
        // layout, but its own file because a draft can carry inline images.
        return readDrafts(this.config.dataDir) ?? null;
      }
      case 'saveDrafts': {
        return { ok: saveDrafts(this.config.dataDir, args) };
      }
      case 'listFiles': {
        const cwd = this.requireWritableCwd(context);
        // There is no workspace folder here, so the list is the directory the
        // client is viewing (its session, or the draft it is about to open) —
        // exactly what pi resolves a mention against. `fresh` skips the index
        // cache: the Explorer polls, so a file added on disk has to appear.
        const files = await workspaceFiles(cwd, this.logger, { fresh: args?.fresh === true });
        return { files };
      }
      case 'readFile': {
        // The Explorer and the preview tabs. `readWorkspaceFile` resolves the
        // path inside the session's directory and refuses anything that escapes.
        const cwd = this.commandCwd(context, args);
        const path = typeof args?.path === 'string' ? args.path : '';
        if (path.length === 0) {
          throw new UnsupportedByHostError('readFile needs a "path" argument.');
        }
        return readWorkspaceFile(cwd, path);
      }
      case 'uploadFile': {
        const cwd = this.requireWritableCwd(context);
        const saved = await saveUpload(cwd, args ?? {}, this.config.uploadDir);
        this.logger.info(`Upload stored: ${saved.path} (${saved.bytes} bytes)`);
        return saved;
      }
      case 'gitLog': {
        // The git panel's history and graph. Like `readFile`, the repository is
        // the viewing session's directory, never a path the client names. `skip`
        // pages towards the root commit as the panel scrolls.
        const cwd = this.requireWritableCwd(context);
        const max = typeof args?.max === 'number' ? args.max : undefined;
        const skip = typeof args?.skip === 'number' ? args.skip : undefined;
        return readGitLog(cwd, max, skip);
      }
      case 'gitStatus': {
        // The working tree's changes, for the Explorer's per-file badges. Polled
        // alongside `listFiles`, so the two always describe the same moment.
        const cwd = this.requireWritableCwd(context);
        return readGitStatus(cwd);
      }
      case 'gitDiff': {
        // One file's unified diff for the preview's diff modes. The path is
        // resolved inside the session's directory, exactly like `readFile`.
        const cwd = this.commandCwd(context, args);
        const path = typeof args?.path === 'string' ? args.path : '';
        if (path.length === 0) {
          throw new UnsupportedByHostError('gitDiff needs a "path" argument.');
        }
        return readGitDiff(cwd, path);
      }
      case 'gitStage': {
        // Staging writes the index of the viewing session's repository. Paths are
        // resolved inside it, exactly like `readFile`, and the answer is the
        // fresh working tree so the panel updates in one round trip.
        const cwd = this.requireWritableCwd(context);
        return stageGitPaths(cwd, gitPaths(args));
      }
      case 'gitUnstage': {
        const cwd = this.requireWritableCwd(context);
        return unstageGitPaths(cwd, gitPaths(args));
      }
      case 'gitCommitFiles': {
        // The graph's expandable row: the paths one commit touched. The hash is
        // client-named, so it is validated as a hex object id, never a ref.
        const cwd = this.requireWritableCwd(context);
        const hash = typeof args?.hash === 'string' ? args.hash : '';
        return readCommitFiles(cwd, hash);
      }
      case 'gitCommitDiff': {
        const cwd = this.commandCwd(context, args);
        const hash = typeof args?.hash === 'string' ? args.hash : '';
        const path = typeof args?.path === 'string' ? args.path : '';
        if (path.length === 0) {
          throw new UnsupportedByHostError('gitCommitDiff needs a "path" argument.');
        }
        return readCommitDiff(cwd, hash, path);
      }
      case 'gitSync': {
        // How far HEAD is from its upstream, for the panel's pull/push controls.
        const cwd = this.requireWritableCwd(context);
        return readGitSync(cwd);
      }
      case 'gitPull': {
        // Network commands: git runs with prompts disabled, so a missing
        // credential fails instead of blocking the host on stdin.
        const cwd = this.requireWritableCwd(context);
        return pullGit(cwd);
      }
      case 'gitPush': {
        const cwd = this.requireWritableCwd(context);
        return pushGit(cwd);
      }
      case 'gitCommit': {
        // Commits the staged changes. The message is client-named but passed as
        // a single argv element, never through a shell.
        const cwd = this.requireWritableCwd(context);
        const message = typeof args?.message === 'string' ? args.message : '';
        return commitGit(cwd, message);
      }
      case 'gitBranches': {
        const cwd = this.requireWritableCwd(context);
        return readGitBranches(cwd);
      }
      case 'gitCheckout': {
        const cwd = this.requireWritableCwd(context);
        const branch = typeof args?.branch === 'string' ? args.branch : '';
        return checkoutGit(cwd, branch, args?.create === true);
      }
      case 'mcpStatus': {
        // The viewing session's MCP servers. `pi mcp list --json` connects every
        // enabled server, so a failure is reported as a value (the panel renders
        // it) rather than thrown — the panel has something to say either way.
        const cwd = this.requireWritableCwd(context);
        try {
          return await this.pi.mcp.status(cwd);
        } catch (error: unknown) {
          return { servers: [], errors: [describeError(error)] };
        }
      }
      case 'mcpAdd': {
        const cwd = this.requireWritableCwd(context);
        return this.pi.mcp.add(parseMcpServerInput(args), cwd);
      }
      case 'mcpInspect': {
        // Probing spawns the server, so its directory is policy-checked like a
        // session's. Nothing is written: this answers "would it work?" before
        // the reader commits an entry to `mcp.json`.
        const spec = parseMcpServerSpec(args);
        const cwd = this.commandCwd(context, { cwd: spec.cwd ?? '' });
        if (spec.cwd === undefined) {
          spec.cwd = cwd;
        }
        return this.pi.inspector.inspect(spec, { cwd });
      }
      case 'mcpRemove': {
        const cwd = this.requireWritableCwd(context);
        return this.pi.mcp.remove(stringArg(args, 'name'), cwd, mcpScope(args));
      }
      case 'mcpSetEnabled': {
        const cwd = this.requireWritableCwd(context);
        return this.pi.mcp.setEnabled(
          stringArg(args, 'name'),
          args?.enabled === true,
          cwd,
          mcpScope(args),
        );
      }
      case 'trustProject': {
        // Trusting loads the project's `.pi` resources for every future pi
        // process (mcp.json, settings, skills, prompts), the same decision pi's
        // own prompt writes. Nothing else about the project is touched.
        const cwd = this.requireWritableCwd(context);
        return this.pi.mcp.trustProject(cwd);
      }
      default:
        throw new UnsupportedByHostError(`This host does not support "${command}".`);
    }
  }

  /**
   * The directory the command should touch, after `ProjectPolicy` approved it.
   * The controller hands in what the client is viewing; the registry's active
   * session is only a fallback for a host command issued without one.
   */
  private requireWritableCwd(context?: HostCommandContext): string {
    const cwd = context?.cwd ?? this.activeCwd();
    if (!cwd) {
      throw new UnsupportedByHostError('No active Morse session yet.');
    }
    if (!this.policy.canOpen(cwd)) {
      throw new UnsupportedByHostError(`Morse is not allowed to work in ${cwd}.`);
    }
    return cwd;
  }

  /**
   * The directory a file command works in. A restored preview tab carries the
   * project it was read from (`args.cwd`), because the host may still be on
   * another session when that tab is loaded; the policy checks it exactly like a
   * terminal's directory. Without one, the viewing session's directory is used.
   */
  private commandCwd(context?: HostCommandContext, args?: Record<string, unknown>): string {
    const requested = args?.cwd;
    if (typeof requested === 'string' && requested.length > 0) {
      if (!this.policy.canOpen(requested)) {
        throw new UnsupportedByHostError(`Morse is not allowed to work in ${requested}.`);
      }
      return requested;
    }
    return this.requireWritableCwd(context);
  }

  /** The cwd of the session this connection is showing. */
  private activeCwd(): string | undefined {
    const key = this.registry.activeKeyOf();
    const workspace = key === undefined ? undefined : this.registry.stateOf(key)?.workspace;
    return workspace?.cwd ?? this.registry.defaultWorkspace.cwd;
  }
}

/** The `paths` argument of a `gitStage`/`gitUnstage` command, with bad entries dropped. */
function gitPaths(args: Record<string, unknown> | undefined): string[] {
  const paths = args?.paths;
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths.filter((path): path is string => typeof path === 'string' && path.length > 0);
}

function stringArg(args: Record<string, unknown> | undefined, key: string): string {
  const value = args?.[key];
  return typeof value === 'string' ? value : '';
}

/** The scope a mutation edits, when the panel named one. */
function mcpScope(args: Record<string, unknown> | undefined): 'global' | 'project' | undefined {
  return args?.scope === 'global' || args?.scope === 'project' ? args.scope : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}