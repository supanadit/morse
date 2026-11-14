/**
 * The pi engine: where its files live for the user, one project and an isolated
 * bot tree, plus the stores it supplies. `PI_CODING_AGENT_DIR` is pi's own way
 * of naming the user agent dir, so a bot only has to point it at its config
 * directory to become its own root.
 */
import { join } from 'node:path';
import {
  EngineDefinition,
  EngineInstance,
  JsonConfigFile,
  UnsupportedScopeError,
  type ConfigFile,
  type ConfigPaths,
  type ConfigScope,
  type EngineContext,
} from '@morse/engine-config';

import { PiMcpStore } from './pi-mcp-store.js';
import { PiPromptStore } from './pi-prompt-store.js';

/** The config files this engine can resolve today; later files extend the map. */
const FILE_NAMES = new Map<string, string>([['mcp', 'mcp.json']]);

export class PiEngineDefinition extends EngineDefinition {
  readonly kind = 'pi';

  create(context: EngineContext): PiEngineInstance {
    return new PiEngineInstance(this, context);
  }
}

export class PiEngineInstance extends EngineInstance {
  readonly definition: PiEngineDefinition;
  readonly context: EngineContext;
  readonly ownership: 'user' | 'isolated';
  readonly mcp: PiMcpStore;
  /** pi's prompt templates, read and written as the `.md` files pi loads. */
  readonly prompts: PiPromptStore;

  readonly agentDir: string;
  /** Every project file this instance resolved, so `scopeOf` can name it. */
  private readonly projectPaths = new Set<string>();

  constructor(definition: PiEngineDefinition, context: EngineContext) {
    super();
    this.definition = definition;
    this.context = context;
    this.ownership = context.ownership;
    this.agentDir =
      context.ownership === 'isolated'
        ? isolatedRoot(context)
        : context.env.PI_CODING_AGENT_DIR || join(context.home, '.pi', 'agent');
    this.mcp = new PiMcpStore(this);
    this.prompts = new PiPromptStore(this);
    if (this.ownership === 'user' && context.cwd !== undefined) {
      this.projectPath('mcp', context.cwd);
    }
  }

  paths(fileId: string, scope: ConfigScope, cwd?: string): ConfigPaths {
    const globalPath = join(this.agentDir, fileName(fileId));
    if (scope === 'global') {
      return { read: [globalPath], write: globalPath };
    }
    const projectPath = this.projectPath(fileId, cwd);
    // The project file is read first: a definition there shadows the user's.
    return { read: [projectPath, globalPath], write: projectPath };
  }

  file(fileId: string, scope: ConfigScope, cwd?: string): ConfigFile {
    return this.fileAt(fileId, this.paths(fileId, scope, cwd).write, scope);
  }

  fileAt(fileId: string, path: string, scope: ConfigScope): ConfigFile {
    if (this.ownership === 'isolated' && scope === 'project') {
      throw new UnsupportedScopeError(fileId, scope, path);
    }
    return new JsonConfigFile(path, fileId, scope, { ownership: this.ownership });
  }

  scopeOf(_fileId: string, path: string): ConfigScope {
    return this.projectPaths.has(path) ? 'project' : 'global';
  }

  /**
   * A project file's path, remembered so the scope is known even when the
   * caller resolved the chain for a directory other than the instance's own.
   */
  private projectPath(fileId: string, cwd?: string): string {
    if (this.ownership === 'isolated') {
      throw new UnsupportedScopeError(fileId, 'project');
    }
    const dir = cwd ?? this.context.cwd;
    if (dir === undefined) {
      throw new Error(`pi needs a project directory to resolve its "${fileId}" file.`);
    }
    const path = join(dir, '.pi', fileName(fileId));
    this.projectPaths.add(path);
    return path;
  }
}

/** A bot tree's root is its agent dir; one without a root cannot be opened. */
function isolatedRoot(context: EngineContext): string {
  if (context.root === undefined) {
    throw new Error('An isolated pi instance needs a root directory.');
  }
  return context.root;
}

function fileName(fileId: string): string {
  const name = FILE_NAMES.get(fileId);
  if (name === undefined) {
    throw new Error(`pi has no config file "${fileId}".`);
  }
  return name;
}
