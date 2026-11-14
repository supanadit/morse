/**
 * The engine-generic config foundation: shared vocabulary, file and section
 * layers, resource stores and engine instances. Engine integrations subclass
 * it; it never learns an engine's own file layout.
 */
export * from './core/config-file.js';
export * from './core/config-store.js';
export * from './core/json-format.js';
export * from './core/scope.js';
export * from './core/section.js';
export * from './core/types.js';
export * from './core/write.js';
export * from './engine/context.js';
export * from './engine/definition.js';
export * from './engine/instance.js';
export * from './engine/locator.js';
export * from './mcp/mcp-section.js';
export * from './mcp/mcp-store.js';
export * from './mcp/names.js';
export * from './prompt/prompt-store.js';
export * from './resource/composite-store.js';
export * from './resource/file-store.js';
export * from './resource/resource-store.js';
