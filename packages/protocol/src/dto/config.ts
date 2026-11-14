/**
 * The configuration vocabulary every engine surface shares: which file a change
 * lands in, what went wrong reading one, and what a mutation answers.
 */

/** Where a config change lands: the user's global file, or this project's file. */
export type ConfigScope = 'global' | 'project';

/** What kind of complaint an issue is, so the UI can offer the right action. */
export type ConfigIssueCode =
  | 'parse'
  | 'shape'
  | 'normalize'
  | 'name'
  | 'frontmatter'
  | 'read'
  | 'write'
  | 'unsupported';

/** One config-file complaint, attached to the surface that read or wrote it. */
export interface ConfigIssue {
  /** Absolute path of the file the issue is about. */
  file: string;
  /** Which config file it is (`'mcp'`, `'config'`, `'settings'`, …). */
  fileId: string;
  scope: ConfigScope;
  /** JSON pointer to the offending value, when one can be named. */
  pointer?: string;
  code: ConfigIssueCode;
  message: string;
  /** The bounded offending region, so the reader can see what an engine saw. */
  snippet?: string;
  /** Whether Fix can resolve this issue. */
  fixable: boolean;
}

/** What a config mutation answers. `message` carries the reason when it refused. */
export interface ConfigMutation {
  ok: boolean;
  message?: string;
  /** The file that was written, for the panel to name. */
  path?: string;
  scope?: ConfigScope;
  issues: ConfigIssue[];
}
