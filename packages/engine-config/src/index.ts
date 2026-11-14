/**
 * The engine-generic config foundation: shared vocabulary, file and section
 * layers, resource stores and engine instances. Engine integrations subclass
 * it; it never learns an engine's own file layout.
 */
export * from './core/scope.js';
export * from './core/types.js';
