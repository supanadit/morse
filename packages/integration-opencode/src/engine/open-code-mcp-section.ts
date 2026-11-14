/**
 * OpenCode's `mcp` block. The engine half of the shared MCP store: it reads and
 * writes OpenCode's own spelling — `type` of `local`/`remote`, argv in
 * `command`, `environment` for a local server's env, `headers` for a remote
 * one — keeps the fields Morse does not edit (`oauth`, `timeout`, ...) and
 * recognizes no override: an entry *is* the server.
 */
import {
  McpSection,
  isPlainObject,
  type ConfigIssue,
  type McpServer,
  type SectionContext,
} from '@morse/engine-config';

/** The keys this codec owns; any other key of an entry is preserved verbatim. */
const MANAGED_KEYS = [
  'type',
  'command',
  'environment',
  'cwd',
  'url',
  'headers',
  'enabled',
] as const;

export class OpenCodeMcpSection extends McpSection {
  readonly key = 'mcp';

  /**
   * One entry, decoded into the neutral server. OpenCode always writes a
   * `type`; an entry without a usable transport is skipped with a pointer
   * issue so its siblings still list.
   */
  override decodeEntry(name: string, raw: unknown, context: SectionContext): McpServer | undefined {
    if (!isPlainObject(raw)) {
      return undefined;
    }
    // The neutral convention: only an explicit `false` disables a server.
    const enabled = raw.enabled !== false;

    if (raw.type === 'local') {
      const parts = stringArray(raw.command);
      if (parts === undefined || parts.length === 0 || parts.some((part) => part.length === 0)) {
        context.issues.push(
          this.entryIssue(
            context,
            name,
            `local MCP server "${name}" needs a non-empty "command" array.`,
          ),
        );
        return undefined;
      }
      const [command, ...args] = parts;
      const server: McpServer = { name, type: 'stdio', command: command!, enabled };
      if (args.length > 0) {
        server.args = args;
      }
      const environment = this.record(context, name, raw.environment, 'environment');
      if (environment !== undefined) {
        server.env = environment;
      }
      const cwd = nonEmptyString(raw.cwd);
      if (cwd !== undefined) {
        server.cwd = cwd;
      }
      return server;
    }

    if (raw.type === 'remote') {
      const url = nonEmptyString(raw.url);
      if (url === undefined) {
        context.issues.push(
          this.entryIssue(context, name, `remote MCP server "${name}" needs a "url".`),
        );
        return undefined;
      }
      const server: McpServer = { name, type: 'http', url, enabled };
      const headers = this.record(context, name, raw.headers, 'headers');
      if (headers !== undefined) {
        server.headers = headers;
      }
      return server;
    }

    context.issues.push(
      this.entryIssue(context, name, `MCP server "${name}" needs "type" of "local" or "remote".`),
    );
    return undefined;
  }

  /**
   * One entry, in OpenCode's spelling. The kept entry supplies every unknown
   * field; the managed keys are rewritten from the neutral server, so
   * `enabled: true` (OpenCode's default) is dropped rather than stored.
   */
  override encodeEntry(item: McpServer, kept: unknown): unknown {
    const keptEntry = isPlainObject(kept) ? kept : {};
    const encoded: Record<string, unknown> = { ...keptEntry };
    for (const key of MANAGED_KEYS) {
      delete encoded[key];
    }

    if (item.type === 'stdio') {
      if (item.command === undefined || item.command.length === 0) {
        throw new Error(`"${item.name}" is a stdio server and needs a non-empty "command".`);
      }
      encoded.type = 'local';
      // OpenCode stores argv, not a command string.
      encoded.command = [item.command, ...(item.args ?? [])];
      if (item.env !== undefined && Object.keys(item.env).length > 0) {
        encoded.environment = { ...item.env };
      } else if (isMalformedRecord(keptEntry.environment)) {
        // A partially malformed record is the reader's data; the neutral shape
        // cannot represent it, so it is kept rather than deleted.
        encoded.environment = { ...(keptEntry.environment as Record<string, unknown>) };
      }
      if (item.cwd !== undefined && item.cwd.length > 0) {
        encoded.cwd = item.cwd;
      }
    } else {
      if (item.url === undefined || item.url.length === 0) {
        throw new Error(`"${item.name}" is an http server and needs a non-empty "url".`);
      }
      encoded.type = 'remote';
      encoded.url = item.url;
      if (item.headers !== undefined && Object.keys(item.headers).length > 0) {
        encoded.headers = { ...item.headers };
      } else if (isMalformedRecord(keptEntry.headers)) {
        encoded.headers = { ...(keptEntry.headers as Record<string, unknown>) };
      }
    }

    // `enabled: true` is OpenCode's default, so only a pin is ever stored.
    if (item.enabled === false) {
      encoded.enabled = false;
    }
    return encoded;
  }

  /** A string record field, or an issue naming the field the neutral shape cannot hold. */
  private record(
    context: SectionContext,
    name: string,
    value: unknown,
    field: 'environment' | 'headers',
  ): Record<string, string> | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (isStringRecord(value)) {
      return { ...value };
    }
    context.issues.push({
      file: context.file,
      fileId: context.fileId,
      scope: context.scope,
      pointer: context.pointer(this.key, name, field),
      code: 'shape',
      message: `${context.file}: "${this.key}.${name}.${field}" must be an object of strings.`,
      fixable: false,
    });
    return undefined;
  }

  private entryIssue(context: SectionContext, name: string, message: string): ConfigIssue {
    return {
      file: context.file,
      fileId: context.fileId,
      scope: context.scope,
      pointer: context.pointer(this.key, name),
      code: 'shape',
      message: `${context.file}: ${message}`,
      fixable: false,
    };
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? [...value]
    : undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((item) => typeof item === 'string');
}

/** A record the neutral shape cannot hold: an object, but not of strings. */
function isMalformedRecord(value: unknown): boolean {
  return isPlainObject(value) && !isStringRecord(value);
}
