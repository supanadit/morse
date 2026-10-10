import { Inject, Injectable } from '@nestjs/common';
import { ChatService, SessionRegistry, UnsupportedByHostError, type MorseLogger } from '@morse/core';
import type { PiRpcAdapter } from '@morse/adapter-pi-rpc';
import { McpWatcher, parseMcpServerInput, parseMcpServerSpec, parsePromptTemplateInput } from '@morse/adapter-pi-rpc';
import {
  HostSessionController,
  type HostCommandContext,
  type HostSessionServices,
  type SessionTranscriptStore,
} from '@morse/host-runtime';
import type { HostCapabilities, HostToClientMessage, LspPosition, UpdateHostResult } from '@morse/protocol';
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
import { readWorkbench, saveWorkbench, readDrafts, saveDrafts } from '@morse/host-runtime';
import { ServerProjectPolicy } from '../projects/project-policy.js';
import { ServerTerminalBackend } from '../terminal/terminal.service.js';
import { ServerLanguageServers } from '../lsp/lsp.service.js';
import { canSelfUpdate, performSelfUpdate } from '../self-update/self-update.js';

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
  private readonly mcpWatch: McpWatcher;

  constructor(
    @Inject(MORSE_SESSION_REGISTRY) private readonly registry: SessionRegistry,
    @Inject(MORSE_TRANSCRIPT_STORE) private readonly transcripts: SessionTranscriptStore,
    @Inject(MORSE_PROJECT_POLICY) private readonly policy: ServerProjectPolicy,
    @Inject(MORSE_LOGGER) private readonly logger: MorseLogger,
    @Inject(MORSE_CONFIG) private readonly config: MorseServerConfig,
    @Inject(ServerTerminalBackend) private readonly terminal: ServerTerminalBackend,
    @Inject(ServerLanguageServers) private readonly lsp: ServerLanguageServers,
    @Inject(MORSE_PI_ADAPTER) private readonly pi: PiRpcAdapter,
  ) {
    // One watcher for the whole host: every connected client subscribes, so a
    // config edited in a terminal (or by another window) reaches all of them.
    // It polls nothing until a controller is subscribed.
    this.mcpWatch = new McpWatcher({
      signature: (cwd) => this.pi.mcp.configSignature(cwd),
      // The global file always; a project file only while one of its sessions is
      // warm — exactly when the indicator can show it.
      cwds: () =>
        this.registry
          .hotKeys()
          .map((key) => this.registry.stateOf(key)?.workspace.cwd ?? '')
          .filter((cwd) => cwd.length > 0),
    });
  }

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
      // Same reasoning for a language server: VS Code's own LSP already answers
      // for the files it edits, and a browser cannot spawn one. This host runs
      // them on its machine and answers `lspHover` and friends, so the preview
      // can be hovered and jumped through. Which *files* it covers is reported
      // per request (`LspDiagnostics.available`), because a project in a language
      // with no server installed is still a project.
      lsp: true,
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
      // Editing prompt templates is plain file I/O into pi's prompt directories,
      // which this host already owns. The editor works without the pi CLI.
      promptEditor: true,
      // One-click self-update: only when the operator opted in
      // (`MORSE_SELF_UPDATE=1`). The frontend turns the footer's update notice into
      // a button when this is set; the command itself re-checks the install and
      // the caller's address before it runs anything.
      selfUpdate: this.config.selfUpdate,
    };
  }

  createFor(emit: (message: HostToClientMessage) => void, remoteAddress?: string): HostSessionController {
    const services: HostSessionServices = {
      registry: this.registry,
      chat: new ChatService({ agent: this.registry, logger: this.logger }),
      mcpWatch: this.mcpWatch,
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
      // The caller's address rides along so `updateHost` can refuse anyone who is
      // not on this machine.
      onHostCommand: (command, args, context) =>
        this.runHostCommand(command, args, context, remoteAddress),
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
    remoteAddress?: string,
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
      case 'lspHover': {
        // The preview's hover card. The host owns the language server (a browser
        // cannot spawn one) and the project scoping, exactly like `readFile`.
        const { cwd, path } = this.lspFile(context, args);
        return this.lsp.hover(cwd, path, lspPosition(args));
      }
      case 'lspDefinition': {
        const { cwd, path } = this.lspFile(context, args);
        return this.lsp.definition(cwd, path, lspPosition(args));
      }
      case 'lspReferences': {
        const { cwd, path } = this.lspFile(context, args);
        return this.lsp.references(cwd, path, lspPosition(args));
      }
      case 'lspDiagnostics': {
        // No position: a problem list is about the whole file. This is the one
        // LSP command that waits for a cold server, because the preview asked for
        // an answer and "still starting" must not read as "no problems".
        const { cwd, path } = this.lspFile(context, args);
        return this.lsp.diagnostics(cwd, path);
      }
      case 'uploadFile': {
        const cwd = this.requireWritableCwd(context);
        const saved = await saveUpload(cwd, args ?? {}, this.config.uploadDir);
        this.logger.info(`Upload stored: ${saved.path} (${saved.bytes} bytes)`);
        return saved;
      }
      case 'gitLog': {        // The git panel's history and graph. Like `readFile`, the repository is
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
        // `scope: 'global'` is the empty-session view: no project, so no session
        // is required and only the user's `mcp.json` is read.
        const cwd = args?.scope === 'global' ? undefined : this.requireWritableCwd(context);
        try {
          return await this.pi.mcp.status(cwd);
        } catch (error: unknown) {
          return { servers: [], errors: [describeError(error)] };
        }
      }
      case 'mcpAdd': {
        const input = parseMcpServerInput(args);
        const cwd = input.scope === 'project' ? this.requireWritableCwd(context) : undefined;
        return this.pi.mcp.add(input, cwd);
      }
      case 'mcpInspect': {
        // Probing spawns the server, so its directory is policy-checked like a
        // session's. Nothing is written: this answers "would it work?" before
        // the reader commits an entry to `mcp.json`. With no project the probe
        // runs in the host's default workspace.
        const spec = parseMcpServerSpec(args);
        const cwd = this.optionalCwd(context, args);
        if (spec.cwd === undefined && cwd.length > 0) {
          spec.cwd = cwd;
        }
        return this.pi.inspector.inspect(spec, {
          cwd: spec.cwd ?? this.registry.defaultWorkspace.cwd,
        });
      }
      case 'mcpRemove': {
        const scope = mcpScope(args);
        const cwd = scope === 'project' ? this.requireWritableCwd(context) : undefined;
        return this.pi.mcp.remove(stringArg(args, 'name'), cwd, scope);
      }
      case 'mcpSetEnabled': {
        const scope = mcpScope(args);
        const cwd = scope === 'project' ? this.requireWritableCwd(context) : undefined;
        return this.pi.mcp.setEnabled(
          stringArg(args, 'name'),
          args?.enabled === true,
          cwd,
          scope,
        );
      }
      case 'trustProject': {
        // Trusting loads the project's `.pi` resources for every future pi
        // process (mcp.json, settings, skills, prompts), the same decision pi's
        // own prompt writes. Nothing else about the project is touched.
        const cwd = this.requireWritableCwd(context);
        return this.pi.mcp.trustProject(cwd);
      }
      case 'promptTemplates': {
        // The user's prompts, plus this project's once it is trusted. No session
        // is required: with no directory, the user templates still list.
        return this.pi.prompts.list(this.optionalCwd(context, args));
      }
      case 'promptTemplateSave': {
        return this.pi.prompts.save(parsePromptTemplateInput(args), this.optionalCwd(context, args));
      }
      case 'promptTemplateDelete': {
        return this.pi.prompts.delete(
          stringArg(args, 'name'),
          promptScope(args),
          this.optionalCwd(context, args),
        );
      }
      case 'updateHost': {
        return this.updateHost(remoteAddress);
      }
      default:
        throw new UnsupportedByHostError(`This host does not support "${command}".`);
    }
  }

  /**
   * Install a newer Morse and relaunch this host.
   *
   * Every gate is checked here, at the moment of the call, rather than trusted
   * from the capability the frontend saw at handshake time:
   *
   * - the operator opted in (`MORSE_SELF_UPDATE=1`),
   * - the caller is on this machine (the browser UI has no auth, so a `--lan`
   *   host must not expose a remote `npm install -g`),
   * - the running module is an npm-global install this user can rewrite.
   *
   * A refused request answers with `ok: false` and a reason; the frontend falls
   * back to the command it already prints in the hint.
   */
  private async updateHost(remoteAddress?: string): Promise<UpdateHostResult> {
    const from = this.config.frontend?.version ?? 'unknown';
    if (!this.config.selfUpdate) {
      return {
        ok: false,
        from,
        message: 'This host was not started with MORSE_SELF_UPDATE=1. Run npm install -g @supanadit/morse-web@latest and restart it.',
      };
    }
    if (!isLoopback(remoteAddress)) {
      this.logger.warn(`Refused a self-update from ${remoteAddress ?? 'an unknown address'}`);
      return {
        ok: false,
        from,
        message: 'Self-update is only allowed from this machine.',
      };
    }
    if (!(await canSelfUpdate())) {
      return {
        ok: false,
        from,
        message: 'This Morse is not a writable npm-global install, so it cannot replace itself. Run npm install -g @supanadit/morse-web@latest yourself.',
      };
    }
    return performSelfUpdate({
      dataDir: this.config.dataDir,
      currentVersion: from,
      logger: this.logger,
    });
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

  /**
   * The file a language-server command is about: its directory by `commandCwd`'s
   * rule (a restored preview tab carries the project it was read from) and the
   * path the client named, which the LSP layer resolves inside it with the same
   * `resolveWithin` the preview uses.
   */
  private lspFile(
    context?: HostCommandContext,
    args?: Record<string, unknown>,
  ): { cwd: string; path: string } {
    const path = typeof args?.path === 'string' ? args.path : '';
    if (path.length === 0) {
      throw new UnsupportedByHostError('An LSP command needs a "path" argument.');
    }
    return { cwd: this.commandCwd(context, args), path };
  }

  /**
   * Like `commandCwd`, but an absent directory is not an error: `''` means "no
   * project", which the prompt editor uses to edit only the user templates.
   */
  private optionalCwd(context?: HostCommandContext, args?: Record<string, unknown>): string {
    // An explicit `cwd` is authoritative, even when empty: the editor sends `''`
    // for "no project in front", which must not fall back to a default workspace.
    if (args !== undefined && typeof args['cwd'] === 'string') {
      const requested = args['cwd'];
      return requested.length > 0 && this.policy.canOpen(requested) ? requested : '';
    }
    const active = context?.cwd ?? this.activeCwd();
    return active && this.policy.canOpen(active) ? active : '';
  }

  /** The cwd of the session this connection is showing. */
  private activeCwd(): string | undefined {    const key = this.registry.activeKeyOf();
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

/**
 * Whether an address is on this machine. `updateHost` runs a global install, so
 * it must never answer anyone but the person sitting at the host: a `--lan`
 * server exposes the UI with no auth, and `::ffff:127.0.0.1` is how a
 * dual-stack socket spells IPv4 loopback. An address we cannot see is refused.
 *
 * Exported for its spec: it is the only thing between the browser UI and a
 * remote `npm install -g`, so it is tested on its own rather than through a host.
 */
export function isLoopback(address: string | undefined): boolean {
  if (address === undefined || address.length === 0) {
    return false;
  }
  // An IPv6-mapped IPv4 address (`::ffff:127.0.0.1`) or a bare IPv6 loopback.
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === 'localhost' ||
    normalized.startsWith('127.')
  );
}

/**
 * The zero-based position an LSP command names, in LSP's own frame (`lsp.ts`
 * says why the wire keeps it). A request without one is a client bug, so it is
 * refused rather than defaulted to the top of the file.
 */
function lspPosition(args: Record<string, unknown> | undefined): LspPosition {
  const line = args?.line;
  const character = args?.character;
  if (
    !Number.isInteger(line) ||
    !Number.isInteger(character) ||
    (line as number) < 0 ||
    (character as number) < 0
  ) {
    throw new UnsupportedByHostError('An LSP command needs a zero-based "line" and "character".');
  }
  return { line: line as number, character: character as number };
}

/** The scope a mutation edits, when the panel named one. */
function mcpScope(args: Record<string, unknown> | undefined): 'global' | 'project' | undefined {
  return args?.scope === 'global' || args?.scope === 'project' ? args.scope : undefined;
}

/** The scope a prompt-template mutation targets; only an explicit "project" moves off global. */
function promptScope(args: Record<string, unknown> | undefined): 'global' | 'project' {
  return args?.scope === 'project' ? 'project' : 'global';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}