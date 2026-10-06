/**
 * Serializable view DTOs. These are the ONLY shapes crossing the host <-> frontend
 * boundary, which is what keeps the frontend swappable (Angular today, React or
 * Svelte tomorrow) and lets the same frontend render inside a VS Code webview or
 * a plain browser talking to the NestJS host.
 */

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type NoticeLevel = 'info' | 'success' | 'warn' | 'error';

export type HostKind = 'vscode' | 'server';

export type ToolStatus = 'running' | 'ok' | 'error';

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}

export type CommandSource = 'extension' | 'prompt' | 'skill';

/**
 * A command the agent session offers in the composer: an extension command, a
 * prompt template or a skill (`/skill:name`). Run by sending `/name` as a
 * prompt. Morse's own built-ins (`/new`, `/compact`, ...) are merged in by the
 * frontend because pi keeps them in the TUI only.
 */
export interface CommandOption {
  name: string;
  description?: string;
  source: CommandSource;
  /** Raw prompt-template Markdown, for `source: 'prompt'` only (see `AgentCommand`). */
  template?: string;
}

export interface WorkspaceInfo {
  cwd: string;
  name: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Prompt tokens written into the provider's prompt cache. */
  cacheWriteTokens?: number;
  /** Reasoning tokens; a subset of `outputTokens`. */
  reasoningTokens?: number;
}

/** How full the model's context window is. */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Message/step counts for the session, for the usage panel. */
export interface SessionCounts {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  messageCount: number;
}

/**
 * Live state of one session the host is running right now (a hot agent
 * process). `session/list` is the persisted catalog; this is the subset that is
 * actually alive, so a frontend can show several sessions working at once
 * instead of pretending only the selected one exists.
 */
export interface SessionActivity {
  /** Registry key: the session id, or a synthetic key before a new session is persisted. */
  sessionKey: string;
  /** The agent is producing a response (thinking, tools or text). */
  streaming: boolean;
  /** The host is switching to/starting this session. */
  busy: boolean;
  agentReady: boolean;
  agentStarting: boolean;
  agentError?: string;
}

/** A project is a directory the agent has worked in (one pi session bucket). */
export interface ProjectSummary {
  path: string;
  name: string;
  sessionCount: number;
  lastUsedAt: number;
}

/**
 * How much of the machine this host exposes.
 *
 * `global` is the browser host: every project pi knows about.
 * `workspace` is VS Code, which is scoped to the folders the window has open
 * — no project switcher, only sessions inside those folders.
 */
export type HostScope = 'global' | 'workspace';

/** What the host can do; the frontend adapts instead of guessing. */
export interface HostCapabilities {
  hostKind: HostKind;
  scope: HostScope;
  /** Host can read the active editor selection / open files. */
  editorContext: boolean;
  /**
   * Host streams the active editor selection as it changes (`context/selectionLive`),
   * so the frontend can show a live chip whose line numbers follow the user's
   * drag until they click it to lock. Optional: hosts without an editor leave
   * it off.
   */
  selectionLive?: boolean;
  /** Host renders interaction requests natively (QuickPick, InputBox, ...). */
  nativeDialogs: boolean;
  /** Host can insert text into an editor. */
  insertIntoEditor: boolean;
  /** Host can reveal a file in the editor. */
  revealFile: boolean;
  /**
   * Host can list workspace files, so the frontend can offer a file picker.
   * Optional: hosts without it simply do not show the picker.
   */
  filePicker?: boolean;
  /**
   * Host can receive a file the browser read (base64) and store it on its own
   * disk, returning a path the frontend can `@mention`. Browsers cannot hand a
   * dragged file's path to the agent, so this is how a browser host attaches a
   * real file. Optional: hosts that cannot write files leave it off.
   */
  fileUpload?: boolean;
  /**
   * Host can list directories on its own filesystem, so the frontend can offer
   * a folder browser when the user has to choose which project a new session
   * belongs to. VS Code already has a workspace folder and leaves it off; the
   * browser host, where any directory is fair game, turns it on.
   */
  directoryPicker?: boolean;
  /**
   * Host can read a file's contents (`readFile`), so the frontend can render an
   * Explorer and open files in its own preview tabs. This is the browser host's
   * stand-in for a text editor; VS Code already has an Explorer and an editor,
   * so it leaves this off and keeps its native ones.
   */
  filePreview?: boolean;
  /**
   * Host can fork the conversation before a past user message, which is how a
   * user edits a prompt the agent already answered. Optional: an agent backend
   * without fork support leaves it off and the frontend hides the affordance.
   */
  editMessage?: boolean;
  /**
   * Host can branch a new session before a past user message (`chat/fork`) and
   * hand that prompt back to the composer. The same pi primitive as
   * `editMessage`, only without sending anything. Optional: an agent backend
   * without fork support leaves it off and the frontend hides the affordance.
   */
  forkMessage?: boolean;
  /**
   * Host allows the frontend to ask the registry whether a newer Morse has been
   * published, so the sidebar can say so instead of letting a reader run a stale
   * build forever. Optional and explicit because it is the only thing a frontend
   * ever does over the internet: a locked-down deployment (or a webview whose CSP
   * forbids it) leaves it off and the frontend stays quiet.
   */
  updateCheck?: boolean;
  /**
   * The installed pi version, so the frontend can tell when a newer pi is out
   * and say how this host updates it (`pi update`). Optional: a host that could
   * not read pi's package leaves it off and the pi notice stays quiet.
   */
  piVersion?: string;
  /**
   * Host can read the active project's git history (`gitLog`), so the frontend
   * can offer a git panel: a commit list and its branch graph. The browser host
   * serves a machine with no editor and turns it on; VS Code keeps its own
   * Source Control view and leaves it off.
   */
  gitPanel?: boolean;
  /**
   * Host can manage pi's MCP servers (`mcpStatus`/`mcpAdd`/`mcpRemove`/
   * `mcpSetEnabled`): list their connection state, add one, remove one, or turn
   * one off. On when the host found the `pi` CLI; a host without it leaves this
   * off and the frontend hides the affordance instead of promising it.
   */
  mcp?: boolean;
  /**
   * Host can run an interactive shell for the frontend's bottom panel
   * (`terminal/open` and friends), streaming its output back. VS Code already
   * has an integrated terminal and leaves it off; the browser host turns it on,
   * so the panel stands on its own.
   */
  terminal?: boolean;
  /**
   * Host can read and write the frontend's shell layout (`readWorkbench` /
   * `saveWorkbench`), so the tabs and terminal a reader had open come back on
   * the next visit. The browser host keeps it under `~/.morse`; VS Code has its
   * own editor/tab restoration and leaves it off.
   */
  workbench?: boolean;
  /**
   * Host can raise a notification of its own (`notify`), so the frontend can say
   * a run finished while the reader was elsewhere. VS Code turns it on (its
   * webview has no Web Notifications); the browser host leaves it off and uses
   * the `Notification` API instead.
   */
  notify?: boolean;
}

/**
 * The frontend's persisted shell layout: which tabs are open and in front, the
 * bottom panel's state and its terminals. The frontend owns the inner schema
 * (it is the only thing that reads it back), so the host stores the blob
 * verbatim and a frontend can add a field without a protocol change. `version`
 * lets a frontend ignore a layout it can no longer read instead of misreading it.
 */
export interface WorkbenchSnapshot {
  version: number;
  /** The frontend's own shape; opaque to the host. */
  data: unknown;
}

/**
 * One commit of the browser host's git panel. The panel draws both the history
 * list and the lane graph from this shape: `parents` gives the graph its edges,
 * and `refs` the branch and tag chips.
 */
export interface GitCommit {
  hash: string;
  shortHash: string;
  /** Parent hashes, newest-first order; empty on a root commit. */
  parents: string[];
  /** Decorations (`%D`), already split: `HEAD -> main`, `tag: v1.0`, `origin/main`. */
  refs: string[];
  author: string;
  /** ISO 8601 author date, so the frontend can render a relative time. */
  date: string;
  subject: string;
}

/** What the `gitLog` host command answers: the active project's recent commits. */
export interface GitLog {
  /** False when the directory is not inside a git repository. */
  isRepo: boolean;
  /** Repository root, when `isRepo`. */
  root?: string;
  /** Current branch (`HEAD` short name), when `isRepo`. */
  branch?: string;
  commits: GitCommit[];
}

/** One changed path in the working tree, for the Explorer's git badges. */
export interface GitFileStatus {
  /** Path relative to the viewing session's directory, like `listFiles`. */
  path: string;
  /** Two-letter porcelain code: ` M`, `??`, `A `, `D `, `R `, `UU`, … */
  status: string;
}

/** What the `gitStatus` host command answers: the working tree's changes. */
export interface GitStatus {
  isRepo: boolean;
  files: GitFileStatus[];
}

/**
 * What the `gitCommitFiles` host command answers: the paths a single commit
 * touched, with the status each had in that commit (`M`, `A`, `D`, `R`, …).
 */
export interface GitCommitFiles {
  isRepo: boolean;
  hash: string;
  files: GitFileStatus[];
}

/**
 * What the `gitSync` host command answers: how far HEAD is from its upstream,
 * for the panel's pull/push controls. `behind` is commits to pull, `ahead` is
 * commits to push.
 */
export interface GitSync {
  isRepo: boolean;
  /** Current branch (`HEAD` short name), when `isRepo`. */
  branch?: string;
  /** The tracked remote branch (`origin/main`), when one is configured. */
  upstream?: string;
  ahead: number;
  behind: number;
}

/** What the `gitBranches` host command answers: what the panel can switch to. */
export interface GitBranches {
  isRepo: boolean;
  /** The checked-out branch (`HEAD` short name), when known. */
  current?: string;
  /** Local branch short names. */
  local: string[];
  /** Remote-tracking branches (`origin/main`), without `origin/HEAD`. */
  remote: string[];
  /** Tag names (checking one out detaches HEAD, the way git does). */
  tags: string[];
}

/** How an MCP server's tools reach the model (pi's `McpExposure`). */
export type McpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden';

/** pi's connection lifecycle, plus the entry that is configured but turned off. */
export type McpServerState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'needs-auth'
  | 'failed'
  | 'closed'
  | 'disabled';

export type McpServerScope = 'global' | 'project' | 'extension';

/** Where an MCP edit lands: the user file (every project) or this project's `.pi/mcp.json`. */
export type McpConfigScope = 'global' | 'project';

/** One MCP server, as the host's `mcpStatus` command reports it. */
export interface McpServerStatus {
  name: string;
  scope: McpServerScope;
  /** The `mcp.json` that defines it (or the extension path). */
  source: string;
  /**
   * The project `.pi/mcp.json` that overrides this user-level server's
   * `enabled`/`exposure` for the viewing directory. Present only when there is one.
   */
  override?: string;
  enabled: boolean;
  exposure: McpExposure;
  /** A one-line summary of how it connects: `stdio: command args` or `http: url`. */
  transport: string;
  state: McpServerState;
  /** The tool names the server offers once connected. */
  tools: string[];
  /** Per-tool exposure overrides, when they differ from the server's. */
  toolExposure?: Record<string, McpExposure>;
  resources?: number;
  resourceTemplates?: number;
  /** Why it is not connected: the connection error, or the config-file complaint. */
  error?: string;
}

/** What the `mcpStatus` host command answers. */
export interface McpStatus {
  servers: McpServerStatus[];
  /** Config-file problems pi could not attach to a server. */
  errors: string[];
  note?: string;
  /**
   * Whether pi would load this project's `.pi` resources. False means project
   * files (including `.pi/mcp.json`) are ignored until the project is trusted,
   * which the panel offers to change (`trustProject`).
   */
  trusted?: boolean;
}

/** What the `mcpAdd` host command takes. */
export interface McpServerInput {
  name: string;
  /** `project` writes `<cwd>/.pi/mcp.json`; default `global` (`~/.pi/agent/mcp.json`). */
  scope?: 'global' | 'project';
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  exposure?: McpExposure;
  description?: string;
}

/** What an MCP mutation answers. `message` carries the reason when it refused. */
export interface McpMutation {
  ok: boolean;
  message?: string;
  /** The `mcp.json` that was written, for the panel to name. */
  path?: string;
  /** Which file the change landed in. */
  scope?: McpConfigScope;
  /** True when a user-level server got a project override instead of a rewrite. */
  override?: boolean;
}

/** What the `trustProject` host command answers. */
export interface ProjectTrustResult {
  ok: boolean;
  message?: string;
  /** The `trust.json` that was written, for the panel to name. */
  path?: string;
}

/** One tool a probed server offers. */
export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  /** The tool's JSON Schema, for the inspector's detail view. */
  inputSchema?: unknown;
}

/** One resource a probed server offers. */
export interface McpResourceInfo {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** One resource template a probed server offers. */
export interface McpResourceTemplateInfo {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** One argument of a probed server's prompt. */
export interface McpPromptArgumentInfo {
  name: string;
  description?: string;
  required?: boolean;
}

/** One prompt a probed server offers. */
export interface McpPromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgumentInfo[];
}

/** The capabilities a probe reports; only the ones worth a card. */
export interface McpServerCapabilitiesInfo {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  logging?: boolean;
  completions?: boolean;
}

/** Why a probe failed, as a class the inspector branches on. */
export type McpInspectionErrorKind =
  | 'auth'
  | 'unreachable'
  | 'timeout'
  | 'protocol'
  | 'spawn'
  | 'unknown';

export interface McpInspectionErrorInfo {
  kind: McpInspectionErrorKind;
  message: string;
  status?: number;
  /** OAuth protected-resource metadata URL, when the server advertised one. */
  authUrl?: string;
}

/** What the `mcpInspect` host command answers: a server, probed before it is added. */
export interface McpInspectionResult {
  ok: boolean;
  serverInfo?: { name: string; title?: string; version?: string };
  protocolVersion?: string;
  instructions?: string;
  capabilities?: McpServerCapabilitiesInfo;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  resourceTemplates: McpResourceTemplateInfo[];
  prompts: McpPromptInfo[];
  /** A stdio server's stderr, capped. */
  logs?: string[];
  error?: McpInspectionErrorInfo;
  durationMs: number;
}

/**
 * What a git mutation answers (`gitCommit`, `gitCheckout`). `message` carries
 * git's own words when it refused, so the panel can say why nothing happened.
 */
export interface GitMutation {
  ok: boolean;
  message?: string;
}

/** What the `gitDiff` host command answers: one file's unified diff. */
export interface GitDiff {
  path: string;
  /** Unified diff text (`git diff HEAD -- <path>`); empty when there is none. */
  diff: string;
}

/**
 * Machine-readable reason the agent backend is not running. Hosts only name what
 * they can name, so a frontend must still render `agentError` itself — the code is
 * there to pick the right *help*, not to replace the message.
 */
export type AgentErrorCode =
  /** `pi` could not be resolved: not installed, or the configured path is wrong. */
  | 'agent-unavailable'
  /** `pi` answered with something the adapter could not understand. */
  | 'agent-protocol';

/** The half of an agent failure a frontend can act on (`SessionViewState.agentFailure`). */
export interface AgentFailure {
  code?: AgentErrorCode;
  /** Shell command that installs what is missing, when the adapter knows it. */
  install?: string;
  /** Host-specific next step: which setting or environment variable to look at. */
  hint?: string;
}

/**
 * A problem the agent reported loading its own configuration — a prompt
 * template pi refused, say. The panel shows one warning row and lists these
 * behind a click; they are never written into the conversation.
 */
export interface AgentDiagnosticMessage {
  level: NoticeLevel;
  text: string;
}

export interface SessionViewState {
  sessionId?: string;
  sessionTitle?: string;
  workspace: WorkspaceInfo;
  model?: ModelOption;
  thinkingLevel: ThinkingLevel;
  availableModels: ModelOption[];
  availableThinkingLevels: ThinkingLevel[];
  /** Commands pi exposes (`get_commands`): extensions, templates, skills. */
  availableCommands: CommandOption[];
  streaming: boolean;
  busy: boolean;
  /** Cumulative session tokens (input/output/cache) reported by the agent. */
  usage?: TokenUsage;
  /** Tokens of the most recent assistant message. */
  lastUsage?: TokenUsage;
  /** Cumulative session cost in USD, when the provider reports it. */
  costUsd?: number;
  contextUsage?: ContextUsage;
  counts?: SessionCounts;
  /** False when the agent backend (the `pi` binary) could not be started. */
  agentReady: boolean;
  /** True while the host is spawning/attaching the agent, so the UI does not
   * show an error during a normal (slow) start. */
  agentStarting: boolean;
  agentError?: string;
  /**
   * What `agentError` means and what to do about it. Optional: a host that could
   * not classify the failure (a process that exited, say) sends the message only,
   * and the frontend falls back to generic wording.
   */
  agentFailure?: AgentFailure;
  /** True when older transcript entries can still be loaded from the session. */
  hasOlderHistory?: boolean;
  /** True while the host is fetching the previous history page. */
  loadingOlderHistory?: boolean;
  /**
   * Configuration warnings from the agent itself, as a row above the
   * conversation rather than lines inside it. Optional and usually absent.
   */
  diagnostics?: AgentDiagnosticMessage[];
}

export interface BaseTranscriptItem {
  id: string;
  at: number;
}

/**
 * An image attached to a prompt. Base64, without a `data:` prefix — pi accepts
 * it verbatim as `{type: 'image', data, mimeType}`. Stored on the user message
 * so the data survives in the chat, exactly like it does in pi sessions.
 */
export interface PromptImage {
  data: string;
  mimeType: string;
}

/**
 * A file (or an editor selection) pinned to a message as an attachment chip.
 * The agent is meant to read it — the wire mentions `@path[:start-end]`, never
 * the inlined content, so the prompt keeps the words the user actually typed.
 */
export interface ChatPin {
  path: string;
  startLine?: number;
  endLine?: number;
}

/**
 * A prompt handed back to the composer after a fork: the message the branch
 * re-opened, plus its attachments, so the user continues the new branch from
 * where they forked instead of retyping it. Sent as `composer/seed`.
 */
export interface ComposerSeed {
  text: string;
  images?: PromptImage[];
  pins?: ChatPin[];
}

export interface UserTranscriptItem extends BaseTranscriptItem {
  kind: 'user';
  text: string;
  /** Image attachments pinned to this message, rendered as thumbnails. */
  images?: PromptImage[];
  /** File/selection pins pinned to this message, rendered as chips. */
  pins?: ChatPin[];
}

export interface AssistantTranscriptItem extends BaseTranscriptItem {
  kind: 'assistant';
  text: string;
  thinking: string;
  streaming: boolean;
  model?: string;
}

export interface ToolTranscriptItem extends BaseTranscriptItem {
  kind: 'tool';
  name: string;
  title: string;
  status: ToolStatus;
  input?: string;
  output?: string;
  durationMs?: number;
}

export interface NoticeTranscriptItem extends BaseTranscriptItem {
  kind: 'notice';
  level: NoticeLevel;
  text: string;
}

/**
 * A compaction boundary. Everything before it was summarized into `summary`
 * (what the agent now carries as context); the transcript keeps the full
 * conversation and marks the point instead — like pi's own TUI — so a resumed
 * session does not silently shrink to the post-compaction tail.
 */
export interface CompactionTranscriptItem extends BaseTranscriptItem {
  kind: 'compaction';
  summary?: string;
  /** Approximate tokens that the summary folded away, when the agent reports it. */
  tokensBefore?: number;
}

export type TranscriptItem =
  | UserTranscriptItem
  | AssistantTranscriptItem
  | ToolTranscriptItem
  | NoticeTranscriptItem
  | CompactionTranscriptItem;

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * Mirrors the agent's interaction requests (pi `extension_ui_request`). Hosts with
 * native dialogs answer them without involving the frontend; hosts without (the
 * browser server host) forward them and the frontend renders a form.
 */
export type InteractionRequest =
  | { requestId: string; kind: 'select'; title: string; message?: string; options: SelectOption[] }
  | { requestId: string; kind: 'confirm'; title: string; message: string; danger?: boolean }
  | { requestId: string; kind: 'input'; title: string; placeholder?: string; value?: string }
  | { requestId: string; kind: 'editor'; title: string; value?: string; language?: string };

export interface InteractionResponse {
  requestId: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface FrontendIdentity {
  name: string;
  version: string;
}
