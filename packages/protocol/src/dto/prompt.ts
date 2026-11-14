/** The prompt-template editor: one template, and the result of listing or saving them. */
import type { ConfigIssue } from './config.js';

export type PromptScope = 'global' | 'project';

/**
 * One prompt template, in Morse's engine-neutral vocabulary. pi keeps templates
 * as files, so `raw` is the whole file; OpenCode also defines commands in
 * `opencode.json`'s `command` key, so its rows carry `source: 'config'` and a
 * structured `entry` instead. `argumentHint` is pi-only (OpenCode has no such field).
 */
export interface PromptTemplate {
  /** Command name without the leading slash (the file name without `.md`). */
  name: string;
  scope: PromptScope;
  /** Where the command lives: a markdown file or the config's `command` key. */
  source?: 'file' | 'config';
  /** Absolute path of the `.md` file (pi; OpenCode file commands too). */
  path?: string;
  description?: string;
  /** The `argument-hint` frontmatter, untouched. pi only. */
  argumentHint?: string;
  /** Body with the frontmatter stripped, for the editor's body field. */
  body?: string;
  /** The file exactly as it is on disk. pi only. */
  raw?: string;
  /** The structured entry. OpenCode `config` commands only. */
  entry?: {
    template: string;
    description?: string;
    agent?: string;
    model?: string;
    subtask?: boolean;
    [key: string]: unknown;
  };
  /** Set when the engine would not load the command; it is still listed so it can be fixed. */
  error?: string;
}

/** The editor's historical name for `PromptTemplate`; new code says `PromptTemplate`. */
export type PromptTemplateInfo = PromptTemplate;

/** What `promptTemplates` answers: every template, plus where a new one would go. */
export interface PromptTemplatesResult {
  templates: PromptTemplate[];
  /** The engine's global template directory. */
  globalDir: string;
  /** This project's template directory, when the workspace has one. */
  projectDir?: string;
  /** Whether the engine would load the project templates (pi's `.pi` trust gate). */
  trusted: boolean;
  /** Config-file complaints collected while listing. */
  issues?: ConfigIssue[];
}

/**
 * What `promptTemplateSave` takes. The frontend composes `raw` (frontmatter and
 * body) so the editor and the preview share one renderer; the host validates it
 * with the same YAML parser pi uses before writing anything.
 */
export interface PromptTemplateInput {
  /** The file name (without `.md`) when editing; absent when creating. */
  originalName?: string;
  /** The scope it was read from, so a move can delete the old file. */
  originalScope?: PromptScope;
  /** The source it was read from, so an edit writes the same surface back. */
  originalSource?: 'file' | 'config';
  /** Which surface a new command lands on; default `file` (pi only has files). */
  source?: 'file' | 'config';
  name: string;
  scope: PromptScope;
  /** The whole markdown file. `file` commands (pi, OpenCode). */
  raw?: string;
  /** The structured entry. OpenCode `config` commands; `raw` is ignored. */
  entry?: {
    template: string;
    description?: string;
    agent?: string;
    model?: string;
    subtask?: boolean;
    [key: string]: unknown;
  };
}

/** What a prompt-template mutation answers. `message` carries the reason when it refused. */
export interface PromptTemplateMutation {
  ok: boolean;
  message?: string;
  path?: string;
  scope?: PromptScope;
  source?: 'file' | 'config';
  /** Config-file complaints the mutation collected while reading or writing. */
  issues?: ConfigIssue[];
}
