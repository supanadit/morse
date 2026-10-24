/** The MCP panel and editor: server status, what a server offers, and mutations. */

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

/** The half of an agent failure a frontend can act on (`SessionViewState.agentFailure`). */
