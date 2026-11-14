/**
 * A config file as one object: where it is, which file id and scope it serves,
 * how it may be written, and the format that turns bytes into a value. Reading
 * never throws on bad text; a write is refused rather than silently mangling a
 * file the reader cannot represent (comments, or a real syntax error).
 */
import { existsSync, readFileSync } from 'node:fs';

import type { ConfigIssue, ConfigIssueCode, ConfigMutation, ConfigScope } from '@morse/protocol';

import { JsonFormat, type ConfigFormat } from './json-format.js';
import type { ConfigDocument, WritePolicy } from './types.js';
import { fileSignature, writeAtomic } from './write.js';

const JSON_FORMAT = new JsonFormat();

export abstract class ConfigFile {
  readonly path: string;
  readonly fileId: string;
  readonly scope: ConfigScope;
  protected readonly policy: WritePolicy;

  protected constructor(path: string, fileId: string, scope: ConfigScope, policy: WritePolicy) {
    this.path = path;
    this.fileId = fileId;
    this.scope = scope;
    this.policy = policy;
  }

  abstract format(): ConfigFormat;

  read(): ConfigDocument {
    if (!existsSync(this.path)) {
      return {
        path: this.path,
        fileId: this.fileId,
        scope: this.scope,
        value: undefined,
        text: '',
        exists: false,
        strict: true,
        issues: [],
      };
    }
    const text = readFileSync(this.path, 'utf8');
    const parsed = this.format().parse(text, this.path, this.fileId, this.scope);
    return {
      path: this.path,
      fileId: this.fileId,
      scope: this.scope,
      text,
      exists: true,
      ...parsed,
    };
  }

  /**
   * Write `value` strictly. A user file that is JSONC is refused until
   * `normalize()` drops the comments; an isolated file is Morse's own and is
   * normalized on write. A file that cannot be parsed at all is never
   * overwritten on the user's side: the write would destroy their content.
   */
  write(value: unknown, options?: { normalize?: boolean }): ConfigMutation {
    const document = this.read();
    if (
      document.issues.some((issue) => issue.code === 'parse') &&
      this.policy.ownership === 'user'
    ) {
      return this.refuse(document.issues);
    }
    if (
      document.exists &&
      !document.strict &&
      this.policy.ownership === 'user' &&
      options?.normalize !== true
    ) {
      return this.refuse([
        this.issue(
          'normalize',
          `${this.path}: rewrite this file without comments or trailing commas before changing it.`,
          true,
        ),
      ]);
    }
    return this.store(value);
  }

  /** Rewrite the file as strict JSON, keeping the parsed value. A syntax error cannot be fixed. */
  normalize(): ConfigMutation {
    const document = this.read();
    if (!document.exists) {
      return { ok: true, path: this.path, scope: this.scope, issues: [] };
    }
    const parseIssues = document.issues.filter((issue) => issue.code === 'parse');
    if (parseIssues.length > 0) {
      return this.refuse(parseIssues);
    }
    return this.store(document.value);
  }

  signature(): string {
    return fileSignature(this.path);
  }

  protected issue(code: ConfigIssueCode, message: string, fixable: boolean): ConfigIssue {
    return { file: this.path, fileId: this.fileId, scope: this.scope, code, message, fixable };
  }

  private store(value: unknown): ConfigMutation {
    try {
      writeAtomic(this.path, this.format().serialize(value), this.policy);
    } catch (error) {
      return this.refuse([this.issue('write', `${this.path}: ${messageOf(error)}`, false)]);
    }
    return { ok: true, path: this.path, scope: this.scope, issues: [] };
  }

  private refuse(issues: ConfigIssue[]): ConfigMutation {
    return { ok: false, path: this.path, scope: this.scope, issues };
  }
}

/** A JSON file on disk: strict on write, lenient (JSONC) on read. */
export class JsonConfigFile extends ConfigFile {
  constructor(
    path: string,
    fileId: string,
    scope: ConfigScope,
    policy: WritePolicy = { ownership: 'user' },
  ) {
    super(path, fileId, scope, policy);
  }

  format(): ConfigFormat {
    return JSON_FORMAT;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
