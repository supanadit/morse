/**
 * Host glue: the application service that owns the wire conversation for one
 * client, and the projection from agent events onto it.
 *
 * Technology-agnostic — no `vscode`, no NestJS, no `child_process`. Both hosts
 * (VS Code and the NestJS server) mount the same controller; only the transport
 * differs.
 */
export * from './native-dialogs.js';
export * from './terminal.js';
export * from './terminal-buffer.js';
export * from './transcript-projector.js';
export * from './transcript-store.js';
export * from './view-state.js';
export * from './session-controller.js';
export * from './workbench-store.js';
