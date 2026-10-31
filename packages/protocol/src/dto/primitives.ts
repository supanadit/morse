/**
 * The wire's shared vocabulary: the literal unions and JSON shapes every other
 * file in `./dto/` builds on.
 */

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type NoticeLevel = 'info' | 'success' | 'warn' | 'error';

export type HostKind = 'vscode' | 'server';

export type ToolStatus = 'running' | 'ok' | 'error';

/** A JSON value as it crosses the wire — what structured data can actually be. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The structured result a tool returned (pi `AgentToolResult.details`),
 * carried verbatim across the wire so a frontend can probe its shape.
 *
 * A JSON object with no fixed keys: Morse renders structured tool output by
 * *shape*, not by tool name, so an unrecognized key is carried rather than
 * dropped.
 */
export type ToolResultDetails = { [key: string]: JsonValue };

/**
 * What a model accepts as input — pi's `input` array. pi itself ships `text`
 * and `image` today; the wider union covers the modalities the picker has an
 * icon for.
 */
export type ModelInput = 'text' | 'image' | 'audio' | 'video' | 'pdf';

export type HostScope = 'global' | 'workspace';
