/**
 * The engine-generic vocabulary a config file, a section and an engine instance
 * share. Later layers (JSON files, sections, stores, engines) implement against
 * these shapes; nothing here knows an engine's own file layout.
 */
import type { ConfigIssue, ConfigMutation, ConfigScope } from '@morse/protocol';

export type { ConfigIssue, ConfigMutation, ConfigScope };

/** One config document as it was read: the parsed value plus what the read found. */
export interface ConfigDocument {
  path: string;
  fileId: string;
  scope: ConfigScope;
  value: unknown;
  /** The file exactly as it is on disk; empty when it does not exist. */
  text: string;
  exists: boolean;
  /** False when the text was JSONC: a user write must normalize first. */
  strict: boolean;
  issues: ConfigIssue[];
}

/** Where a file id is written, and the files read for it in precedence order (highest first). */
export interface ConfigPaths {
  write: string;
  read: string[];
}

/** How a file is owned: the reader's own file, or one Morse generated in an isolated tree. */
export interface WritePolicy {
  ownership: 'user' | 'isolated';
  fileMode?: number;
  dirMode?: number;
}

/** What a section decoder knows about the file entry it is decoding. */
export interface SectionContext {
  file: string;
  fileId: string;
  scope: ConfigScope;
  issues: ConfigIssue[];
  pointer(...segments: string[]): string;
}

/** The roots and ownership one engine instance resolves its paths from. */
export interface EngineContext {
  ownership: 'user' | 'isolated';
  home: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
  xdgConfigHome: string;
  xdgDataHome: string;
  /** An isolated instance's bot root; absent for a user instance. */
  root?: string;
}
