/**
 * Host -> frontend: every message a host pushes or answers with, and the host
 * commands the frontend may ask for.
 */

import type {
  AuthUser,
  BotConfig,
  BotConversationSummary,
  BotRoutingState,
  BotSummary,
  BotTranscriptEntry,
  BotUsage,
  ComposerSeed,
  FrontendIdentity,
  HostCapabilities,
  InteractionRequest,
  ModelOption,
  NoticeLevel,
  ProjectSummary,
  SessionActivity,
  SessionSummary,
  SessionViewState,
  SharedComposerDraft,
  SharedComposerState,
  TranscriptItem,
} from '../dto.js';

export type PromptMode = 'new' | 'steer' | 'followUp';

/**
 * The host command surface, grouped by who owns the answer. The groups ARE the
 * parity contract:
 *
 * - `SharedHostCommand` — every host must answer it. Adding a member breaks
 *   both hosts' command switches until each implements it, so a shared feature
 *   cannot land in one host while the other silently refuses.
 * - `ServerHostCommand` / `VsCodeHostCommand` — one host's own surface, offered
 *   only where its capability is on. The other host's switch reaches them only
 *   in its exhaustive default, which refuses by name.
 * - `ControllerHostCommand` — answered by the shared session controller before
 *   any host handler runs, so hosts never see one.
 *
 * Never add a member to `HostCommand` directly: assign it to the group that
 * owns the answer, or the command exists on the wire while no switch is forced
 * to decide what it does.
 */
export type ControllerHostCommand =
  /**
   * Sessions whose title or project path matches a query, across the whole pi
   * catalog (not just the pages the sidebar loaded). Backs the command palette's
   * `#` session search. Answered by the controller because the registry — and so
   * the scope filter — lives there, not in a host.
   */
  | 'searchSessions'
  /**
   * Re-read the viewing engine's own configuration — its models, modes/agents,
   * commands and skills — without restarting the host (`{ force? }` →
   * `{ reloaded, requiresConfirmation?, running }`). Refused while a turn of that
   * engine runs unless `force` is set, because the engine rebuilds its catalogs
   * mid-turn; the answer carries how many sessions were running so the control
   * can say so. Answered by the controller: the registry owns the engine and
   * every warm gateway that must re-read.
   */
  | 'reloadAgentConfig';

/** Commands every host answers, in its own way. */
export type SharedHostCommand =
  | 'listFiles'
  /** The shell layout the reader left behind (`~/.morse/workbench.json`). */
  | 'readWorkbench'
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
  /**
   * Connect to an MCP server *before* it is added, so the reader can see what it
   * offers (or exactly why it will not connect). Writes nothing.
   */
  | 'mcpInspect'
  /** Mark the viewing project trusted, so pi loads its `.pi` resources. */
  | 'trustProject'
  /**
   * pi's prompt templates for the viewing directory: the user's and this
   * project's, with their bodies and frontmatter, so the editor can rewrite them.
   */
  | 'promptTemplates'
  /** Write one prompt template (create, update or move between scopes). */
  | 'promptTemplateSave'
  /** Remove one prompt template file. */
  | 'promptTemplateDelete'
  /**
   * Rewrite one engine config file so a later write can land (a JSONC file
   * rewritten as strict JSON). Named by the `ConfigIssue` the panel shows:
   * `{ engine?, fileId, path, scope, cwd? }`. The engine validates `path`
   * against its own resolved config paths, never an arbitrary file.
   */
  | 'configFix';

/**
 * Commands only the browser host answers: it has no Source Control view, no
 * Search, no Explorer and no terminal of its own, so its panels stand in — and
 * each rides a capability (`gitPanel`, `searchPanel`, `fileUpload`,
 * `filePreview`, `selfUpdate`) that VS Code leaves off. A VS Code window never
 * asks for one; its switch still names the whole group in its refusal default.
 */
export type ServerHostCommand =
  /**
   * One directory's entries for the Explorer's lazy tree (`{ path? }` →
   * `{ entries, missing? }`): the level drawn first, and each folder's level fetched as
   * it opens. Cwd-relative and in `listFiles`' vocabulary — directories carry the
   * trailing `/` — and ignored entries are included, since the Explorer is how the
   * reader reaches a `.env` or a file under `node_modules`. `missing` says the directory
   * itself is gone, so the tree can drop its row.
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
  /** Stage the named paths in the viewing session's repository. */
  | 'gitStage'
  /** Unstage the named paths (keep the working-tree change). */
  | 'gitUnstage'
  /**
   * Text across the viewing project's files (`{ query, caseSensitive?,
   * include?, exclude? }` → `WorkspaceSearchResult`): matches grouped by file,
   * each line carrying its number, a window of its text and where the matches
   * fall in it. Backs the search panel — ripgrep where the host has it, a
   * built-in walk otherwise, which the result's `engine` reports so the panel
   * can suggest ripgrep.
   */
  | 'searchWorkspace'
  /**
   * Install the latest published build for this host and relaunch it, so the
   * browser footer's update notice can act instead of only linking. Only offered
   * where `capabilities.selfUpdate` is set — an npm-global install the host can
   * rewrite — and answered with an `UpdateHostResult`.
   */
  | 'updateHost'
  /** Every login identity on this host, newest last (admin only). */
  | 'adminUsers'
  /** Create a login identity `{ username, password, role? }` (admin only). */
  | 'adminCreateUser'
  /** Change one identity's role `{ userId, role }` (admin only). */
  | 'adminSetRole'
  /**
   * Edit one identity `{ userId, name?, email?, role?, password? }` (admin only).
   * A password change revokes that user's existing login sessions.
   */
  | 'adminUpdateUser'
  /** Delete one identity `{ userId }` (admin only, never the last admin). */
  | 'adminDeleteUser';

/**
 * Commands only the VS Code host answers: they reach into the editor, the workbench
 * and the OS — surfaces a browser page does not have. Only offered where the
 * matching capability is set, so a browser page never asks.
 */
export type VsCodeHostCommand =
  | 'openSettings'
  | 'showOutput'
  | 'copyToClipboard'
  | 'insertIntoEditor'
  | 'revealFile'
  | 'getEditorContext'
  /** Open the host's MCP editor (VS Code's editor panel; the browser host tabs). */
  | 'openMcpEditor'
  /** Open the host's prompt-template editor (VS Code's editor panel). */
  | 'openPromptEditor'
  /**
   * Show one session as its own editor tab (VS Code), revealing the tab when it
   * is already open instead of opening a second one. Only offered where
   * `capabilities.sessionTabs` is set.
   */
  | 'openSessionTab'
  /** Drop a session's editor tab; the session itself stays open and resumable. */
  | 'closeSessionTab'
  /** Ask the host to confirm a destructive action in its own dialog. */
  | 'confirmDeleteSession'
  /**
   * The project-wide twin: deleting a project removes every session it holds, so
   * the host's own modal names the count and says the folder stays on disk.
   */
  | 'confirmDeleteProject'
  /**
   * Show a notification of the host's own (a finished run the reader stepped
   * away from). Only offered where `capabilities.notify` is set.
   */
  | 'notify';

export type HostCommand =
  | ControllerHostCommand
  | SharedHostCommand
  | ServerHostCommand
  | VsCodeHostCommand;

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
    /**
     * Who this connection authenticated as. Null on single-user hosts (and
     * for the pre-login handshake, which never reaches `ready`). The
     * frontend gates the admin surface on `role === 'admin'`; the backend
     * re-checks per command, so this is display, not authority.
     */
    user: AuthUser | null;
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

/**
 * One session's host-owned queue and pause state. Every connected client gets
 * it: a queue edit on a phone shows up on the desktop. An empty queue with no
 * pause is never sent (and a client treats it as "forget this session").
 */
export interface ComposerStateMessage extends HostMessageBase {
  type: 'composer/state';
  payload: SharedComposerState;
}

/**
 * The words one device is typing in a session's composer, relayed to the
 * others. The sender ignores its own echo by `origin`.
 */
export interface ComposerDraftMessage extends HostMessageBase {
  type: 'composer/draft';
  payload: SharedComposerDraft;
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
  payload: {
    path: string;
    startLine?: number;
    endLine?: number;
    /** 1-based first selected column; present with `endColumn` for a partial-line range. */
    startColumn?: number;
    /** 1-based last selected column. */
    endColumn?: number;
    /** Selected UTF-16 character count, line breaks included. */
    characters?: number;
    /** The selected words for a one-line range, capped by the host. */
    text?: string;
  };
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
  payload: {
    path: string;
    startLine?: number;
    endLine?: number;
    /** 1-based first selected column, matching the editor's status bar. */
    startColumn?: number;
    /** 1-based last selected column; the selection's end is exclusive. */
    endColumn?: number;
    /** Selected UTF-16 character count, line breaks included. */
    characters?: number;
    /** The selected words for a one-line range, capped by the host. */
    text?: string;
  };
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

/** The full bot roster: every bot and conversation, pushed whenever either changes. */
export interface BotRosterMessage extends HostMessageBase {
  type: 'bot/roster';
  payload: { bots: BotSummary[]; conversations: BotConversationSummary[] };
}

/**
 * A conversation's transcript, and the turns that produced it, as the host now
 * has it.
 *
 * - `replace: true` resets what the client holds: opening a conversation sends
 *   the newest page of it.
 * - `prepend: true` puts the entries *before* what the client holds: the answer
 *   to scrolling up.
 * - neither appends the lines a round just produced.
 *
 * `hasMore` says whether older entries exist past what was sent, which is what
 * the chat's own scroll decides to fetch next.
 */
export interface BotTranscriptMessage extends HostMessageBase {
  type: 'bot/transcript';
  payload: {
    conversationId: string;
    entries: BotTranscriptEntry[];
    replace: boolean;
    prepend?: boolean;
    hasMore?: boolean;
  };
}

/**
 * Who the host is asking right now, per conversation; `state: null` once that
 * conversation's round is over.
 *
 * The conversation id rides on the envelope, not only inside the state: a round
 * ending clears this conversation's row and no other, which is what lets a chat
 * the reader is not looking at keep its presence.
 */
export interface BotRoutingMessage extends HostMessageBase {
  type: 'bot/routing';
  payload: { conversationId: string; state: BotRoutingState | null };
}

/**
 * What one conversation's last answer cost, for the composer's context ring.
 *
 * Pushed whenever an engine session reports new counters (after a turn, a
 * compaction) and again when a conversation opens, so a chat the reader returns
 * to shows the ring it had without waiting for another answer. A conversation
 * with no usage yet — or one just cleared — sends the id alone.
 */
export interface BotUsageMessage extends HostMessageBase {
  type: 'bot/usage';
  payload: BotUsage;
}

/** Answer to `bot/inspect`: the bot's own record, for Edit bot to show. */
export interface BotConfigMessage extends HostMessageBase {
  type: 'bot/config';
  payload: BotConfig;
}

/** Answer to `bot/probeModels`: the models that engine offers with those credentials. */
export interface BotModelsMessage extends HostMessageBase {
  type: 'bot/models';
  payload: { requestId: string; kind: string; models: ModelOption[] };
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
  | ComposerStateMessage
  | ComposerDraftMessage
  | HostCommandResultMessage
  | ErrorMessage
  | TerminalOutputMessage
  | TerminalExitMessage
  | BotRosterMessage
  | BotTranscriptMessage
  | BotRoutingMessage
  | BotUsageMessage
  | BotConfigMessage
  | BotModelsMessage;
