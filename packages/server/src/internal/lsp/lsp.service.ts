/**
 * The browser host's language servers (driven adapter).
 *
 * A singleton registry, like the terminal backend and for the same reason: a
 * language server is expensive to start (the TypeScript one indexes a project
 * before it answers), so it outlives the request that needed it. One server per
 * project + language, kept until it has been unused for `MORSE_LSP_IDLE_MS`.
 *
 * Two behaviours are deliberate and worth keeping:
 *
 * - **Hover, definition and references never wait for a cold start.** Starting a
 *   server can take seconds (`npx` fetching it, TypeScript indexing), and the UI
 *   gives a host command 5 s. A request into a server that is still starting
 *   answers `undefined` immediately and *kicks the start off in the background*,
 *   so the next hover works. Nothing in the preview ever waits on a download.
 * - **Diagnostics do wait**, because the preview asked for a problem list and
 *   "starting" is not an answer: they block up to a bounded timeout and answer
 *   `undefined` if the server never came up. `available: false` is reserved for
 *   the honest case — no server covers this file at all.
 *
 * The document text is read from disk with the same rules `readFile` uses
 * (`resolveWithin`: the project, never a path the client names), so a location
 * the server returns is one the preview could already open.
 */
import { readFile, stat } from 'node:fs/promises';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type MorseLogger } from '@morse/core';
import type {
  LspDefinition,
  LspDiagnostic,
  LspDiagnostics,
  LspHover,
  LspLocation,
  LspPosition,
  LspReferences,
} from '@morse/protocol';
import type { MorseServerConfig } from '../../app/config.js';
import { MORSE_CONFIG, MORSE_LOGGER } from '../../app/tokens.js';
import { resolveWithin } from '../workspace/file-store.js';
import { languageIdForPath, resolveServerCommand, serverForLanguage } from './language-servers.js';
import { hoverFrom, locationsFrom, relativeWithin, toFileUri } from './lsp-mapping.js';
import { LspClient } from './lsp-client.js';

/** How long diagnostics wait for a server's first report about a document. */
const DIAGNOSTICS_TIMEOUT_MS = 10_000;
/** A file bigger than this is not sent to a language server at all. */
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** One running (or starting) server, and the documents it has been told about. */
interface LspEntry {
  key: string;
  cwd: string;
  languageId: string;
  label: string;
  client?: LspClient;
  /** The start in flight, shared by every request that arrives while it runs. */
  starting?: Promise<LspClient | undefined>;
  /** Languages a document was opened with, so a re-open does not repeat the read. */
  opened: Map<string, string>;
  /** URIs the server has published diagnostics for at least once. */
  published: Set<string>;
  /** One resolve per URI whose diagnostics are still being waited for. */
  waiting: Map<string, Set<() => void>>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

@Injectable()
export class ServerLanguageServers implements OnModuleDestroy {
  private readonly entries = new Map<string, LspEntry>();

  constructor(
    @Inject(MORSE_LOGGER) private readonly logger: MorseLogger,
    @Inject(MORSE_CONFIG) private readonly config: MorseServerConfig,
  ) {}

  /** The hover under a position, or `undefined` when there is nothing to say. */
  async hover(
    cwd: string,
    path: string,
    position: LspPosition,
  ): Promise<LspHover | undefined> {
    const resolved = await this.document(cwd, path);
    if (resolved === undefined) {
      return undefined;
    }
    const client = this.warm(resolved.entry);
    if (client === undefined) {
      return undefined;
    }
    const result = await client.request('textDocument/hover', {
      textDocument: { uri: toFileUri(resolved.absolute) },
      position,
    });
    return hoverFrom(result);
  }

  /** Where the symbol under a position is defined, when the server knows. */
  async definition(
    cwd: string,
    path: string,
    position: LspPosition,
  ): Promise<LspDefinition | undefined> {
    const resolved = await this.document(cwd, path);
    if (resolved === undefined) {
      return undefined;
    }
    const client = this.warm(resolved.entry);
    if (client === undefined) {
      return undefined;
    }
    const result = await client.request('textDocument/definition', {
      textDocument: { uri: toFileUri(resolved.absolute) },
      position,
    });
    const [first] = locationsFrom(result, cwd);
    return first;
  }

  /** Every place the symbol under a position is used. */
  async references(
    cwd: string,
    path: string,
    position: LspPosition,
  ): Promise<LspReferences | undefined> {
    const resolved = await this.document(cwd, path);
    if (resolved === undefined) {
      return undefined;
    }
    const client = this.warm(resolved.entry);
    if (client === undefined) {
      return undefined;
    }
    const result = await client.request('textDocument/references', {
      textDocument: { uri: toFileUri(resolved.absolute) },
      position,
      context: { includeDeclaration: true },
    });
    return { path: relativePath(cwd, resolved.absolute), locations: locationsFrom(result, cwd) };
  }

  /**
   * The problems a server reports for one file. Awaits a cold start: the preview
   * shows a spinner meanwhile, because "no answer yet" and "no problems" are
   * different things and must not look alike.
   */
  async diagnostics(cwd: string, path: string): Promise<LspDiagnostics> {
    const relative = relativePath(cwd, path);
    const resolved = await this.document(cwd, path);
    if (resolved === undefined) {
      // A language Morse has no server for (or a file too big to send): say so
      // rather than implying the file is clean.
      return { path: relative, available: false, diagnostics: [] };
    }
    const client = await this.ensure(resolved.entry);
    if (client === undefined) {
      return { path: relative, available: false, diagnostics: [] };
    }
    const uri = toFileUri(resolved.absolute);
    await this.awaitFirstPublish(resolved.entry, client, uri);
    return { path: relative, available: true, diagnostics: client.diagnosticsFor(uri) };
  }

  async onModuleDestroy(): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      this.cancelIdle(entry);
      entry.client?.dispose();
      entry.client = undefined;
    }
    this.entries.clear();
  }

  /**
   * The document a request is about, with its server entry — or `undefined` when
   * this file is not one Morse can ask about (no server, too big, unreadable).
   */
  private async document(
    cwd: string,
    path: string,
  ): Promise<{ entry: LspEntry; absolute: string } | undefined> {
    const languageId = languageIdForPath(path);
    if (languageId === undefined || serverForLanguage(languageId) === undefined) {
      return undefined;
    }
    let absolute: string;
    try {
      absolute = resolveWithin(cwd, path);
    } catch {
      return undefined;
    }
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.size > MAX_DOCUMENT_BYTES) {
      return undefined;
    }
    const entry = this.entryFor(cwd, languageId);
    const opened = entry.opened.get(absolute);
    const text = opened === undefined ? await readFile(absolute, 'utf8').catch(() => undefined) : undefined;
    if (opened === undefined && text === undefined) {
      return undefined;
    }
    const client = this.warm(entry);
    if (client !== undefined && text !== undefined) {
      entry.opened.set(absolute, languageId);
      client.open(absolute, languageId, text);
    }
    this.touch(entry);
    return { entry, absolute };
  }

  private entryFor(cwd: string, languageId: string): LspEntry {
    const key = `${languageId}\u0000${cwd}`;
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const entry: LspEntry = {
      key,
      cwd,
      languageId,
      label: `${languageId} language server for ${cwd}`,
      opened: new Map(),
      published: new Set(),
      waiting: new Map(),
    };
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * The client when it is already answering, `undefined` otherwise — in which
   * case a start is left running for the next request. This is what keeps a
   * hover from ever waiting on `npx`.
   */
  private warm(entry: LspEntry): LspClient | undefined {
    if (entry.client?.alive === true) {
      return entry.client;
    }
    if (entry.starting === undefined) {
      void this.ensure(entry);
    }
    return undefined;
  }

  /** The client, starting it if needed. Shared: one start per project+language. */
  private ensure(entry: LspEntry): Promise<LspClient | undefined> {
    if (entry.client?.alive === true) {
      return Promise.resolve(entry.client);
    }
    if (entry.starting !== undefined) {
      return entry.starting;
    }
    entry.starting = this.start(entry).finally(() => {
      entry.starting = undefined;
    });
    return entry.starting;
  }

  private async start(entry: LspEntry): Promise<LspClient | undefined> {
    const spec = serverForLanguage(entry.languageId);
    if (spec === undefined) {
      return undefined;
    }
    const command = await resolveServerCommand(spec, entry.cwd);
    if (command === undefined) {
      this.logger.info(`No ${entry.languageId} language server available for ${entry.cwd}`);
      return undefined;
    }
    const client = await LspClient.start({
      command: command.command,
      args: command.args,
      cwd: entry.cwd,
      label: entry.label,
      logger: this.logger,
    });
    if (client === undefined) {
      this.logger.warn(`Could not start ${entry.label} (via ${command.via})`);
      return undefined;
    }
    this.logger.info(`Started ${entry.label} via ${command.via}`);
    entry.client = client;
    // Every open document has to be re-sent to a new process; a restarted server
    // that was never told about a file would answer about nothing.
    entry.opened.clear();
    entry.published.clear();
    client.onDiagnostics((uri) => {
      entry.published.add(uri);
      const waits = entry.waiting.get(uri);
      if (waits === undefined) {
        return;
      }
      entry.waiting.delete(uri);
      for (const resolve of [...waits]) {
        resolve();
      }
    });
    return client;
  }

  /**
   * Diagnostics are the one thing a cold document is worth waiting for; a
   * document the server has already reported on answers immediately.
   */
  private awaitFirstPublish(entry: LspEntry, client: LspClient, uri: string): Promise<void> {
    if (entry.published.has(uri)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waits = entry.waiting.get(uri) ?? new Set<() => void>();
      waits.add(resolve);
      entry.waiting.set(uri, waits);
      const timer = setTimeout(() => {
        waits.delete(resolve);
        if (waits.size === 0) {
          entry.waiting.delete(uri);
        }
        resolve();
      }, DIAGNOSTICS_TIMEOUT_MS);
      timer.unref?.();
      // A server that died mid-wait must not leave the preview spinning.
      if (!client.alive) {
        resolve();
      }
    });
  }

  /** Reclaims a server nobody has asked about recently. */
  private touch(entry: LspEntry): void {
    if (this.config.lspIdleMs <= 0) {
      return;
    }
    this.cancelIdle(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      this.logger.info(`Stopping ${entry.label} (idle)`);
      entry.client?.dispose();
      entry.client = undefined;
      entry.opened.clear();
      entry.published.clear();
      this.entries.delete(entry.key);
    }, this.config.lspIdleMs);
    entry.idleTimer.unref?.();
  }

  private cancelIdle(entry: LspEntry): void {
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }
}

/** `path` as the project-relative form the wire uses, falling back to the input. */
function relativePath(cwd: string, absolute: string): string {
  return relativeWithin(cwd, absolute) ?? absolute;
}

export type { LspDiagnostic, LspLocation };
