/**
 * The OpenCode engine: where its config lives for the user, one project and an
 * isolated bot tree, plus the stores it supplies. OpenCode keeps every setting
 * in one `opencode.json` (or its `opencode.jsonc` spelling), so the MCP store
 * shares the file id `config` with the rest of the document.
 */
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

import {
  OPEN_CODE_CONFIG_FILE_ID,
  discoverOpenCodeConfigPaths,
  discoverOpenCodeGlobalPaths,
  globalConfigCandidates,
  openCodeConfigDir,
  projectConfigCandidates,
} from './config-discovery.js';
import { OpenCodeMcpStore } from './open-code-mcp-store.js';
import { OpenCodePromptStore } from './open-code-prompt-store.js';

/** The config files this engine can resolve today; later files extend the set. */
const FILE_IDS = new Set([OPEN_CODE_CONFIG_FILE_ID]);

export interface OpenCodeEngineOptions {
  /**
   * The app-level config directory (`<xdg config home>/opencode` by default).
   * An isolated tree always uses its own `<root>/opencode`.
   */
  configDir?: string;
}

export class OpenCodeEngineDefinition extends EngineDefinition {
  readonly kind = 'opencode';
  readonly configDir: string | undefined;

  constructor(options: OpenCodeEngineOptions = {}) {
    super();
    this.configDir = options.configDir;
  }

  create(context: EngineContext): OpenCodeEngineInstance {
    return new OpenCodeEngineInstance(this, context);
  }
}

export class OpenCodeEngineInstance extends EngineInstance {
  readonly definition: OpenCodeEngineDefinition;
  readonly context: EngineContext;
  readonly ownership: 'user' | 'isolated';
  /** Where the app-level `opencode.json` lives for this instance. */
  readonly configDir: string;
  readonly mcp: OpenCodeMcpStore;
  /** OpenCode's prompt templates: its `commands/*.md` files and the config's `command` key. */
  readonly prompts: OpenCodePromptStore;

  /** Every project config path this instance resolved, so `scopeOf` can name it. */
  private readonly projectPaths = new Set<string>();

  constructor(definition: OpenCodeEngineDefinition, context: EngineContext) {
    super();
    this.definition = definition;
    this.context = context;
    this.ownership = context.ownership;
    this.configDir = openCodeConfigDir(context, definition.configDir);
    this.mcp = new OpenCodeMcpStore(this);
    this.prompts = new OpenCodePromptStore(this, this.configDir);
  }

  paths(fileId: string, scope: ConfigScope, cwd?: string): ConfigPaths {
    this.assertFileId(fileId);
    if (scope === 'global') {
      return discoverOpenCodeGlobalPaths(this.context, this.configDir);
    }
    const dir = this.projectDirectory(fileId, cwd);
    // Remember every candidate of this directory, so `scopeOf` answers for a
    // path the chain did not need to read (a `jsonc` a later edit creates).
    for (const path of projectConfigCandidates(dir)) {
      this.projectPaths.add(path);
    }
    return discoverOpenCodeConfigPaths(this.context, this.configDir, dir);
  }

  file(fileId: string, scope: ConfigScope, cwd?: string): ConfigFile {
    return this.fileAt(fileId, this.paths(fileId, scope, cwd).write, scope);
  }

  fileAt(fileId: string, path: string, scope: ConfigScope): ConfigFile {
    this.assertFileId(fileId);
    if (this.ownership === 'isolated' && scope === 'project') {
      throw new UnsupportedScopeError(fileId, scope, path);
    }
    return new JsonConfigFile(path, fileId, scope, { ownership: this.ownership });
  }

  /**
   * Which scope a resolved path belongs to. The global file is derived from the
   * context alone; a project file is only known because `paths()` discovered it,
   * so a path this instance never resolved is refused (`UnsupportedScopeError`,
   * which a store reports as `unsupported`) instead of being called global.
   */
  scopeOf(fileId: string, path: string): ConfigScope {
    this.assertFileId(fileId);
    if (this.projectPaths.has(path)) {
      return 'project';
    }
    if (globalConfigCandidates(this.context, this.configDir).includes(path)) {
      return 'global';
    }
    throw new UnsupportedScopeError(
      fileId,
      // Global is always derivable, so an unresolved path is a project question
      // this instance cannot answer; the message carries the real information.
      'project',
      path,
      `"${path}" is not one of this OpenCode instance's config paths; resolve it through paths() first.`,
    );
  }

  /** The directory a project chain starts from, or the typed refusal. */
  private projectDirectory(fileId: string, cwd?: string): string {
    if (this.ownership === 'isolated') {
      throw new UnsupportedScopeError(fileId, 'project');
    }
    const dir = cwd ?? this.context.cwd;
    if (dir === undefined || dir.trim().length === 0) {
      throw new Error(`opencode needs a project directory to resolve its "${fileId}" file.`);
    }
    return dir;
  }

  private assertFileId(fileId: string): void {
    if (!FILE_IDS.has(fileId)) {
      throw new Error(`opencode has no config file "${fileId}".`);
    }
  }
}
