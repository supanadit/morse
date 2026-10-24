/** The prompt-template editor: one template, and the result of listing or saving them. */

export type PromptScope = 'global' | 'project';

/**
 * One prompt template on disk, as the editor reads it. `raw` is the whole file
 * (frontmatter and body) so the editor can show and rewrite exactly what pi will
 * load; `error` names why pi would refuse it (invalid YAML frontmatter).
 */
export interface PromptTemplateInfo {
  /** Command name without the leading slash (the file name without `.md`). */
  name: string;
  scope: PromptScope;
  /** Absolute path of the `.md` file. */
  path: string;
  description?: string;
  /** The `argument-hint` frontmatter, untouched. */
  argumentHint?: string;
  /** Body with the frontmatter stripped, for the editor's body field. */
  body: string;
  /** The file exactly as it is on disk. */
  raw: string;
  /** Set when pi would not load the file: the YAML parser's message. */
  error?: string;
}

/** What `promptTemplates` answers: every template, plus where a new one would go. */
export interface PromptTemplatesResult {
  templates: PromptTemplateInfo[];
  /** The user prompt directory (`<agentDir>/prompts`). */
  globalDir: string;
  /** This project's prompt directory (`<cwd>/.pi/prompts`). */
  projectDir: string;
  /** Whether pi would load the project templates (pi's `.pi` trust gate). */
  trusted: boolean;
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
  name: string;
  scope: PromptScope;
  raw: string;
}

/** What a prompt-template mutation answers. `message` carries the reason when it refused. */
export interface PromptTemplateMutation {
  ok: boolean;
  message?: string;
  path?: string;
  scope?: PromptScope;
}
