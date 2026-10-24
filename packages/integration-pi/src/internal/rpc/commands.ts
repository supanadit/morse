/**
 * Every command pi accepts, one interface each, and the image payload they carry.
 */

export interface RpcImage {
  type: 'image';
  data: string;
  mimeType: string;
}


/** Every command pi accepts, one interface each. */
export interface RpcPromptCommand {
  type: 'prompt';
  message: string;
  images?: RpcImage[];
  streamingBehavior?: 'steer' | 'followUp';
}

export interface RpcSteerCommand {
  type: 'steer';
  message: string;
  images?: RpcImage[];
}

export interface RpcFollowUpCommand {
  type: 'follow_up';
  message: string;
  images?: RpcImage[];
}

/** A command with no arguments: pi answers from its own state. */
export interface RpcAbortCommand {
  type: 'abort';
}

export interface RpcNewSessionCommand {
  type: 'new_session';
  parentSession?: string;
}

export interface RpcSwitchSessionCommand {
  type: 'switch_session';
  sessionPath: string;
}

export interface RpcGetStateCommand {
  type: 'get_state';
}

export interface RpcGetMessagesCommand {
  type: 'get_messages';
}

export interface RpcGetEntriesCommand {
  type: 'get_entries';
  since?: string;
}

export interface RpcGetAvailableModelsCommand {
  type: 'get_available_models';
}

export interface RpcGetAvailableThinkingLevelsCommand {
  type: 'get_available_thinking_levels';
}

export interface RpcGetCommandsCommand {
  type: 'get_commands';
}

export interface RpcGetSessionStatsCommand {
  type: 'get_session_stats';
}

export interface RpcForkCommand {
  type: 'fork';
  entryId: string;
}

export interface RpcGetForkMessagesCommand {
  type: 'get_fork_messages';
}

export interface RpcSetModelCommand {
  type: 'set_model';
  provider: string;
  modelId: string;
}

export interface RpcSetThinkingLevelCommand {
  type: 'set_thinking_level';
  level: string;
}

export interface RpcCompactCommand {
  type: 'compact';
  customInstructions?: string;
}

export interface RpcSetSessionNameCommand {
  type: 'set_session_name';
  name: string;
}

export interface RpcBashCommand {
  type: 'bash';
  command: string;
}

export type RpcCommand =
  | RpcPromptCommand
  | RpcSteerCommand
  | RpcFollowUpCommand
  | RpcAbortCommand
  | RpcNewSessionCommand
  | RpcSwitchSessionCommand
  | RpcGetStateCommand
  | RpcGetMessagesCommand
  | RpcGetEntriesCommand
  | RpcGetAvailableModelsCommand
  | RpcGetAvailableThinkingLevelsCommand
  | RpcGetCommandsCommand
  | RpcGetSessionStatsCommand
  | RpcForkCommand
  | RpcGetForkMessagesCommand
  | RpcSetModelCommand
  | RpcSetThinkingLevelCommand
  | RpcCompactCommand
  | RpcSetSessionNameCommand
  | RpcBashCommand;
