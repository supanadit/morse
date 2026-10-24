/**
 * Host -> frontend: every message a host pushes or answers with, and the host
 * commands the frontend may ask for.
 */

import type {
  ComposerSeed,
  FrontendIdentity,
  HostCapabilities,
  InteractionRequest,
  NoticeLevel,
  ProjectSummary,
  SessionActivity,
  SessionSummary,
  SessionViewState,
  TranscriptItem,
} from '../dto.js';

export type PromptMode = 'new' | 'steer' | 'followUp';

export type HostCommand =
  | 'listFiles'
  /**
   * One directory's entries for the Explorer's lazy tree (`{ path? }` → `{ entries }`):
   * the level drawn first, and each folder's level fetched as it opens. Cwd-relative and
   * in `listFiles`' vocabulary — directories carry the trailing `/`. The browser host
   * answers it; VS Code never renders this Explorer and leaves `filePreview` off.
   */
  | 'listDir'
  | 'readFile'
  | 'listDirectories'
  | 'uploadFile'
  | 'gitLog'
  | 'gitStatus'
  /** The repositories under the viewing project, for the git panel's per-repo list. */
  | 'gitRepos'
  | 'gitDiff'
  /** The paths a single commit touched, for the graph's expandable row. */
  | 'gitCommitFiles'
  /** One file's unified diff inside a commit (not against HEAD). */
  | 'gitCommitDiff'
  /** How far HEAD is from its upstream, for the pull/push controls. */
  | 'gitSync'
  /** Pull the upstream into the working tree. */
  | 'gitPull'
  /** Push HEAD to its upstream. */
  | 'gitPush'
  /** Commit the staged changes with a message. */
  | 'gitCommit'
  /** The branches the panel can switch to. */
  | 'gitBranches'
  /** Switch to a branch, optionally creating it first. */
  | 'gitCheckout'
  /**
   * pi's MCP servers for the viewing session's directory: their connection
   * state, tools and configuration source (`pi mcp list --json`).
   */
  | 'mcpStatus'
  /** Add or replace an MCP server in the global or the project `mcp.json`. */
  | 'mcpAdd'
  /** Remove an MCP server from whichever `mcp.json` defines it. */
  | 'mcpRemove'
  /** Turn an MCP server on or off in the `mcp.json` that defines it. */
  | 'mcpSetEnabled'
  /** Open the host's prompt-template editor (VS Code's editor panel). */
  | 'openPromptEditor'
  /** Mark the viewing project trusted, so pi loads its `.pi` resources. */
  | 'trustProject'
  /**
   * Connect to an MCP server *before* it is added, so the reader can see what it
   * offers (or exactly why it will not connect). Writes nothing.
   */
  | 'mcpInspect'
  /** Open the host's MCP editor (VS Code's editor panel; the browser host tabs). */
  | 'openMcpEditor'
  /**
   * Show one session as its own editor tab (VS Code), revealing the tab when it
   * is already open instead of opening a second one. Only offered where
   * `capabilities.sessionTabs` is set.
   */
  | 'openSessionTab'
  /** Drop a session's editor tab; the session itself stays open and resumable. */
  | 'closeSessionTab'
  /**
   * pi's prompt templates for the viewing directory: the user's and this
   * project's, with their bodies and frontmatter, so the editor can rewrite them.
   */
  | 'promptTemplates'
  /** Write one prompt template (create, update or move between scopes). */
  | 'promptTemplateSave'
  /** Remove one prompt template file. */
  | 'promptTemplateDelete'
  /** Stage the named paths in the viewing session's repository. */
  | 'gitStage'
  /** Unstage the named paths (keep the working-tree change). */
  | 'gitUnstage'
  /** The shell layout the reader left behind (`~/.morse/workbench.json`). */
  | 'readWorkbench'
  /**
   * Sessions whose title or project path matches a query, across the whole pi
   * catalog (not just the pages the sidebar loaded). Backs the command palette's
   * `#` session search.
   */
  | 'searchSessions'
  /**
   * Text across the viewing project's files (`{ query, caseSensitive?,
   * include?, exclude? }` → `WorkspaceSearchResult`): matches grouped by file,
   * each line carrying its number, a window of its text and where the matches
   * fall in it. Backs the search panel — ripgrep where the host has it, a
   * built-in walk otherwise, which the result's `engine` reports so the panel
   * can suggest ripgrep. Only offered where `capabilities.searchPanel` is set.
   */
  | 'searchWorkspace'
  /** Writes the shell layout back, so the next visit opens the same tabs. */
  | 'saveWorkbench'
  /**
   * The half-written prompts the reader left behind, per tab (`~/.morse/drafts.json`).
   * Separate from the layout because a draft can carry inline images and is much
   * larger, and because it is rewritten as the reader types.
   */
  | 'readDrafts'
  | 'saveDrafts'
  /**
   * The language server's answers for a file the frontend is displaying. All
   * four name the file with `path` (relative to the viewing session) plus a
   * zero-based `line`/`character`, and answer `undefined` when no server covers
   * the language — `capabilities.lsp` says whether to ask at all.
   */
  | 'lspHover'
  | 'lspDefinition'
  | 'lspReferences'
  | 'lspDiagnostics'
  | 'openSettings'
  | 'showOutput'
  | 'copyToClipboard'
  | 'insertIntoEditor'
  | 'revealFile'
  | 'getEditorContext'
  /** Ask the host to confirm a destructive action in its own dialog. */
  | 'confirmDeleteSession'
  /**
   * Show a notification of the host's own (a finished run the reader stepped
   * away from). Only offered where `capabilities.notify` is set.
   */
  | 'notify'
  /**
   * Install the latest published build for this host and relaunch it, so the
   * browser footer's update notice can act instead of only linking. Only offered
   * where `capabilities.selfUpdate` is set — an npm-global install the host can
   * rewrite — and answered with an `UpdateHostResult`.
   */
  | 'updateHost';

/**
 * The shape every host -> frontend message shares: which message it is and its body.
 *
 * A base interface each message extends, so a message has a name (`SessionStateMessage`)
 * and a caller can write that name instead of restating the envelope. `type` stays the
 * discriminant, so `switch (message.type)` narrows exactly as the inline literals did.
 * The `HOST_MESSAGE_TYPES` list below is still the runtime mirror, and stays exhaustive
 * because `HostToClientMessage` remains a union.
 */
export interface HostMessageBase {
  type: string;
  payload: unknown;
}

export interface HostReadyMessage extends HostMessageBase {
  type: 'host/ready';
  payload: {
    protocolVersion: number;
    capabilities: HostCapabilities;
    state: SessionViewState;
    frontend?: FrontendIdentity;
  };
}

export interface SessionStateMessage extends HostMessageBase {
  type: 'session/state';
  payload: SessionViewState;
}

export interface ProjectListMessage extends HostMessageBase {
  type: 'project/list';
  payload: { projects: ProjectSummary[] };
}

/** Every live session, so the frontend can mark several as working at once. */
export interface SessionActivityMessage extends HostMessageBase {
  type: 'session/activity';
  payload: { sessions: SessionActivity[] };
}

export interface TranscriptAppendMessage extends HostMessageBase {
  type: 'transcript/append';
  payload: TranscriptItem;
}

export interface TranscriptUpdateMessage extends HostMessageBase {
  type: 'transcript/update';
  payload: TranscriptItem;
}

export interface TranscriptDeltaMessage extends HostMessageBase {
  type: 'transcript/delta';
  payload: { id: string; text?: string; thinking?: string };
}

export interface TranscriptReplaceMessage extends HostMessageBase {
  type: 'transcript/replace';
  payload: { items: TranscriptItem[] };
}

/** A page of older history, inserted in front of what the client already has. */
export interface TranscriptPrependMessage extends HostMessageBase {
  type: 'transcript/prepend';
  payload: { items: TranscriptItem[] };
}

export interface SessionListMessage extends HostMessageBase {
  type: 'session/list';
  payload: {
    sessions: SessionSummary[];
    /**
     * For the full first-page list: whether each project has sessions past the
     * page, keyed by cwd, so the sidebar can draw its "Load more" row.
     */
    hasMoreByProject?: Record<string, boolean>;
    /** Set when this payload is one project's page (see the request). */
    cwd?: string;
    /** For a scoped page: whether that project has yet more sessions. */
    hasMore?: boolean;
  };
}

/**
 * A watched `mcp.json` changed on disk, so the reader's MCP indicator and panel
 * should re-read that directory. `cwd` is `''` for the user-level file, which
 * every project inherits. Pushed because pi's own status is too expensive to
 * poll: the host watches file signatures instead.
 */
export interface McpChangedMessage extends HostMessageBase {
  type: 'mcp/changed';
  payload: { cwd: string };
}

export interface InteractionRequestMessage extends HostMessageBase {
  type: 'interaction/request';
  payload: InteractionRequest;
}

export interface InteractionDismissMessage extends HostMessageBase {
  type: 'interaction/dismiss';
  payload: { requestId: string };
}

export interface NoticeMessage extends HostMessageBase {
  type: 'notice';
  payload: { level: NoticeLevel; text: string; at: number };
}

/**
 * The host pinned the editor selection (the title-bar attach command). The
 * frontend owns the chip; the prompt text itself never changes behind the
 * user's back.
 */
export interface ContextSelectionMessage extends HostMessageBase {
  type: 'context/selection';
  payload: { path: string; startLine?: number; endLine?: number };
}

/**
 * What the user has selected (or merely focused) in the editor right now,
 * streamed as they move. This is a preview, not a pin: the frontend shows it as a
 * live chip that keeps updating until the user clicks it to lock. A payload with
 * `startLine` is a selection and reads as `Lstart-end`; a payload with just a
 * `path` is the focused file, shown as a whole-file chip with no line number. An
 * empty `path` means there is no editor in front; the frontend hides the preview
 * without touching the locked pins.
 */
export interface ContextSelectionLiveMessage extends HostMessageBase {
  type: 'context/selectionLive';
  payload: { path: string; startLine?: number; endLine?: number };
}

/**
 * Hands a forked prompt back to the composer: the message the branch re-opened,
 * with its attachments. Sent after a successful `chat/fork` — a fork that pi
 * cancelled leaves the composer alone.
 */
export interface ComposerSeedMessage extends HostMessageBase {
  type: 'composer/seed';
  payload: ComposerSeed;
}

/** Answer to `host/command` when the frontend asked for a value. */
export interface HostCommandResultMessage extends HostMessageBase {
  type: 'host/command/result';
  payload: { requestId: string; ok: boolean; data?: unknown; error?: string };
}

export interface ErrorMessage extends HostMessageBase {
  type: 'error';
  payload: { message: string; detail?: string; at: number };
}

/**
 * Bytes the shell wrote, as they arrive. A terminal is a stream, not a request:
 * `terminal/open` starts it and this carries everything after.
 */
export interface TerminalOutputMessage extends HostMessageBase {
  type: 'terminal/output';
  payload: { terminalId: string; data: string };
}

/** The shell ended (or never started); no more output follows for this id. */
export interface TerminalExitMessage extends HostMessageBase {
  type: 'terminal/exit';
  payload: { terminalId: string; code?: number; error?: string };
}

/** Host -> frontend. */
export type HostToClientMessage =
  | HostReadyMessage
  | SessionStateMessage
  | ProjectListMessage
  | SessionActivityMessage
  | TranscriptAppendMessage
  | TranscriptUpdateMessage
  | TranscriptDeltaMessage
  | TranscriptReplaceMessage
  | TranscriptPrependMessage
  | SessionListMessage
  | McpChangedMessage
  | InteractionRequestMessage
  | InteractionDismissMessage
  | NoticeMessage
  | ContextSelectionMessage
  | ContextSelectionLiveMessage
  | ComposerSeedMessage
  | HostCommandResultMessage
  | ErrorMessage
  | TerminalOutputMessage
  | TerminalExitMessage;

