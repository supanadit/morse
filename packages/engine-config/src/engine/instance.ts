/**
 * One engine instance: the context it resolves paths from, the generic config
 * locator its stores read through, and the named resources the engine supplies.
 * A new engine package subclasses this and its `EngineDefinition`; nothing in
 * the foundation changes.
 */
import type { ConfigFile } from '../core/config-file.js';
import type { ConfigPaths, ConfigScope, EngineContext } from '../core/types.js';
import type { McpStore } from '../mcp/mcp-store.js';
import type { PromptStore } from '../prompt/prompt-store.js';
import type { EngineDefinition } from './definition.js';
import type { ConfigLocator } from './locator.js';

export abstract class EngineInstance implements ConfigLocator {
  abstract readonly definition: EngineDefinition;
  abstract readonly context: EngineContext;
  abstract readonly ownership: 'user' | 'isolated';

  /** A file id's read precedence (highest first) and write target for one scope. */
  abstract paths(fileId: string, scope: ConfigScope, cwd?: string): ConfigPaths;

  /** The scope's write target, opened for Fix and the editor. */
  abstract file(fileId: string, scope: ConfigScope, cwd?: string): ConfigFile;

  /** A file at a path the read chain resolved, so a fallback is never written by accident. */
  abstract fileAt(fileId: string, path: string, scope: ConfigScope): ConfigFile;

  /** Which scope a resolved path belongs to. */
  abstract scopeOf(fileId: string, path: string): ConfigScope;

  /** The engine's MCP servers, when it has any. */
  abstract readonly mcp: McpStore | undefined;

  /** The engine's prompt templates, when it has a store yet (pi's arrives later). */
  abstract readonly prompts: PromptStore | undefined;
}
