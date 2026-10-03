import type { AgentInteractionRequest } from '@morse/core';

/**
 * Driven port (R2) declared by the host-runtime glue: hosts that can render
 * dialogs natively (VS Code QuickPick/InputBox) implement it. Hosts without
 * native dialogs leave it undefined and the request is forwarded to the
 * frontend instead — the UI adapts, no branching in core.
 */
export interface NativeDialogs {
  select(request: Extract<AgentInteractionRequest, { kind: 'select' }>): Promise<string | undefined>;
  confirm(request: Extract<AgentInteractionRequest, { kind: 'confirm' }>): Promise<boolean>;
  input(request: Extract<AgentInteractionRequest, { kind: 'input' }>): Promise<string | undefined>;
  editor(request: Extract<AgentInteractionRequest, { kind: 'editor' }>): Promise<string | undefined>;
}

/** What the controller was showing when a host command ran. A command that
 * touches files needs the directory the *client* is viewing, which is not always
 * the registry's active session — a draft for a not-yet-opened project has no
 * active session at all. */
export interface HostCommandContext {
  cwd: string;
}

/** Host commands may return a value; the controller forwards it when the frontend
 * asked for one with a `requestId`. */
export type HostCommandHandler = (
  command: string,
  args?: Record<string, unknown>,
  context?: HostCommandContext,
) => Promise<unknown>;
