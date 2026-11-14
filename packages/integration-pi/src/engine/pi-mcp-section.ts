/**
 * pi's `mcpServers` block. The engine half of the shared MCP store: it reads and
 * writes pi's own spelling (`type` optional and inferred, `env`, `args`,
 * `headers`), keeps the fields Morse does not edit (`oauth`, `toolExposure`,
 * `timeout`) and recognizes a project *override* — an entry with no transport,
 * which only pins `enabled`/`exposure` for a server defined in a lower file.
 */
import {
  McpSection,
  isPlainObject,
  type ConfigIssue,
  type McpExposure,
  type McpServer,
  type SectionContext,
} from '@morse/engine-config';

/**
 * The keys this codec owns; any other key of an entry is preserved verbatim.
 *
 * `description` is deliberately absent: no Morse form carried one through the
 * wizard at the time this was written, so treating "not supplied" as "delete"
 * erased a hand-written description on any save. It is written when the caller
 * does send one, and otherwise left exactly as the reader wrote it.
 */
const MANAGED_KEYS = [
  'type',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'enabled',
  'exposure',
] as const;

export class PiMcpSection extends McpSection {
  readonly key = 'mcpServers';

  /**
   * An entry without `command`, `url` or `type` does not define a server: pi
   * merges it onto the user-level one, changing only `enabled`/`exposure`. The
   * base decodes the block before it asks this, so an override decodes to a
   * placeholder the merge can apply.
   */
  override isOverride(raw: unknown): boolean {
    return (
      isPlainObject(raw) &&
      raw.command === undefined &&
      raw.url === undefined &&
      raw.type === undefined
    );
  }

  /** An override is not managed by the wizard, so it survives a managed replacement. */
  override keepsOnReplace(raw: unknown): boolean {
    return this.isOverride(raw);
  }

  override decodeEntry(name: string, raw: unknown, context: SectionContext): McpServer | undefined {
    if (!isPlainObject(raw)) {
      return undefined;
    }
    if (this.isOverride(raw)) {
      const server: McpServer = { name, type: 'stdio' };
      if (typeof raw.enabled === 'boolean') {
        server.enabled = raw.enabled;
      }
      if (typeof raw.exposure === 'string') {
        server.exposure = raw.exposure as McpExposure;
      }
      return server;
    }

    if (inferType(raw) === 'stdio') {
      const command = nonEmptyString(raw.command);
      if (command === undefined) {
        context.issues.push(this.missingField(context, name, 'command', 'stdio'));
        return undefined;
      }
      const server: McpServer = {
        name,
        type: 'stdio',
        command,
        enabled: raw.enabled !== false,
      };
      if (raw.args !== undefined && !isStringArrayValue(raw.args)) {
        context.issues.push(this.fieldIssue(context, name, 'args', 'an array of strings'));
      }
      const args = stringArray(raw.args);
      if (args !== undefined && args.length > 0) {
        server.args = args;
      }
      if (raw.env !== undefined && !isStringRecordValue(raw.env)) {
        context.issues.push(this.fieldIssue(context, name, 'env', 'an object of strings'));
      }
      const env = stringRecord(raw.env);
      if (env !== undefined) {
        server.env = env;
      }
      const cwd = nonEmptyString(raw.cwd);
      if (cwd !== undefined) {
        server.cwd = cwd;
      }
      applyCommon(server, raw);
      return server;
    }

    const url = nonEmptyString(raw.url);
    if (url === undefined) {
      context.issues.push(this.missingField(context, name, 'url', 'http'));
      return undefined;
    }
    const server: McpServer = { name, type: 'http', url, enabled: raw.enabled !== false };
    if (raw.headers !== undefined && !isStringRecordValue(raw.headers)) {
      context.issues.push(this.fieldIssue(context, name, 'headers', 'an object of strings'));
    }
    const headers = stringRecord(raw.headers);
    if (headers !== undefined) {
      server.headers = headers;
    }
    applyCommon(server, raw);
    return server;
  }

  override encodeEntry(item: McpServer, kept: unknown): unknown {
    const keptEntry = isPlainObject(kept) ? kept : {};
    const encoded: Record<string, unknown> = { ...keptEntry };
    for (const key of MANAGED_KEYS) {
      delete encoded[key];
    }
    encoded.type = item.type;
    if (item.type === 'stdio') {
      if (item.command === undefined || item.command.length === 0) {
        throw new Error(`"${item.name}" is a stdio server and needs a non-empty "command".`);
      }
      encoded.command = item.command;
      if (item.args !== undefined && item.args.length > 0) {
        encoded.args = [...item.args];
      } else if (Array.isArray(keptEntry.args) && !isStringArrayValue(keptEntry.args)) {
        // A partially malformed list is the reader's data; keep it rather than
        // deleting it because the neutral shape cannot represent it.
        encoded.args = keptEntry.args;
      }
      if (item.env !== undefined && Object.keys(item.env).length > 0) {
        encoded.env = { ...item.env };
      } else if (isPlainObject(keptEntry.env) && !isStringRecordValue(keptEntry.env)) {
        encoded.env = { ...keptEntry.env };
      }
      if (item.cwd !== undefined && item.cwd.length > 0) {
        encoded.cwd = item.cwd;
      }
    } else {
      if (item.url === undefined || item.url.length === 0) {
        throw new Error(`"${item.name}" is an http server and needs a non-empty "url".`);
      }
      encoded.url = item.url;
      if (item.headers !== undefined && Object.keys(item.headers).length > 0) {
        encoded.headers = { ...item.headers };
      } else if (isPlainObject(keptEntry.headers) && !isStringRecordValue(keptEntry.headers)) {
        encoded.headers = { ...keptEntry.headers };
      }
    }
    // `enabled: true` is pi's default, so only a pin is ever stored.
    if (item.enabled === false) {
      encoded.enabled = false;
    }
    if (item.exposure !== undefined) {
      encoded.exposure = item.exposure;
    }
    if (item.description !== undefined) {
      encoded.description = item.description;
    }
    // No `else`: when the caller supplies no description the entry's own text is
    // already in `encoded` and must stay there. Clearing one is not an edit any
    // Morse form can express.
    return encoded;
  }

  /** The issue an unusable entry leaves behind: the server, then the field it lacks. */
  private missingField(
    context: SectionContext,
    name: string,
    field: 'command' | 'url',
    type: 'stdio' | 'http',
  ): ConfigIssue {
    return {
      file: context.file,
      fileId: context.fileId,
      scope: context.scope,
      pointer: context.pointer(this.key, name),
      code: 'shape',
      message: `${context.file}: "${this.key}.${name}" is a ${type} server and needs a non-empty "${field}".`,
      fixable: false,
    };
  }

  /** A field the neutral shape cannot represent; it is reported, then kept on write. */
  private fieldIssue(
    context: SectionContext,
    name: string,
    field: 'args' | 'env' | 'headers',
    expected: string,
  ): ConfigIssue {
    return {
      file: context.file,
      fileId: context.fileId,
      scope: context.scope,
      pointer: context.pointer(this.key, name, field),
      code: 'shape',
      message: `${context.file}: "${this.key}.${name}.${field}" must be ${expected}.`,
      fixable: false,
    };
  }
}

/**
 * pi infers the transport: `http` when the entry names a URL and no command.
 * An explicit `type` always wins — including `type: 'stdio'` over a bare `url`,
 * which the bot layout used to read as http. That is deliberate parity with pi:
 * the written type is the reader's statement, and an entry with both transports
 * cannot be guessed.
 */
function inferType(raw: Record<string, unknown>): 'stdio' | 'http' {
  if (raw.type === 'http' || raw.type === 'stdio') {
    return raw.type;
  }
  return typeof raw.url === 'string' && raw.command === undefined ? 'http' : 'stdio';
}

/** The fields both transports share: exposure and the neutral description. */
function applyCommon(server: McpServer, raw: Record<string, unknown>): void {
  if (typeof raw.exposure === 'string') {
    server.exposure = raw.exposure as McpExposure;
  }
  if (typeof raw.description === 'string') {
    server.description = raw.description;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isStringArrayValue(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringRecordValue(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((item) => typeof item === 'string');
}

function stringArray(value: unknown): string[] | undefined {
  return isStringArrayValue(value) ? [...value] : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isStringRecordValue(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value)) as Record<string, string>;
}
