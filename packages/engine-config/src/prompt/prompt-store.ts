/**
 * The prompt-template contract every engine answers: the editor only ever sees
 * a prompt store, whether the templates are markdown files, a config block or a
 * composite of both.
 */
import type { PromptTemplate, PromptTemplateInput } from '@morse/protocol';

import { ResourceStore, type ResourceList } from '../resource/resource-store.js';

/**
 * The neutral prompt vocabulary is part of the foundation's public surface, the
 * same way the MCP section re-exports its server types: an engine integration
 * depends on `@morse/engine-config`, never on `@morse/protocol` directly.
 */
export type { PromptScope, PromptTemplate, PromptTemplateInput } from '@morse/protocol';

/** What listing prompts answered: the rows plus where a new one would be written. */
export interface PromptList extends ResourceList<PromptTemplate> {
  /** The engine's global template directory. */
  globalDir: string;
  /** This project's template directory, when the workspace has one. */
  projectDir?: string;
  /** Whether the engine would load the project templates (pi's `.pi` trust gate). */
  trusted: boolean;
  /** The config file config-sourced rows live in (OpenCode's `opencode.json`). */
  configPath?: string;
}

/**
 * The engine-generic prompt store. Its items are `PromptTemplate` rows and its
 * save takes the editor's `PromptTemplateInput`, which also names the row a
 * rename or scope move came from.
 */
export abstract class PromptStore extends ResourceStore<PromptTemplate, PromptTemplateInput> {
  /** The same list, plus where a new template would land and whether the project one loads. */
  abstract override list(cwd?: string): PromptList;
}
