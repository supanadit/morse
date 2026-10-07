/**
 * One language server process, spoken to over stdio.
 *
 * Deliberately small: it owns the process, correlates requests by id, keeps the
 * documents it has opened, and remembers what the server last published as
 * diagnostics. Everything about *what* to ask and what the answer means lives
 * one layer up (`lsp.service.ts` / `lsp-mapping.ts`), and the framing is
 * `lsp-protocol.ts`, so this file has no protocol knowledge beyond the handful
 * of methods it sends.
 *
 * Failure is not an exception here: a server that dies (or never starts) marks
 * the client dead, every pending request answers `undefined`, and the caller —
 * a preview — shows nothing instead of an error banner.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { MorseLogger } from '@morse/core';
import type { LspDiagnostic } from '@morse/protocol';
import { createLspFrameReader, encodeLspMessage, type LspMessage } from './lsp-protocol.js';
import { diagnosticsFrom, toFileUri } from './lsp-mapping.js';
import { childProcessEnv } from '../child-env.js';

export interface LspClientOptions {
  command: string;
  args: readonly string[];
  /** The project root: reported to the server as `rootUri` so it finds tsconfig. */
  cwd: string;
  label: string;
  logger: MorseLogger;
  /** How long the handshake may take. Generous: `npx` may be fetching. */
  initTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** How long a server gets to exit on `shutdown` before it is killed. */
const EXIT_GRACE_MS = 2_000;

interface Pending {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export class LspClient {
  private readonly pending = new Map<number, Pending>();
  private readonly documents = new Map<string, { languageId: string; version: number }>();
  private readonly published = new Map<string, LspDiagnostic[]>();
  private readonly diagnosticsListeners = new Set<(uri: string) => void>();
  private nextId = 1;
  private dead = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: LspClientOptions,
  ) {
    this.read(child);
  }

  /**
   * Spawns a server and completes its handshake. Resolves `undefined` when the
   * process cannot start or does not answer in time — the caller decides what to
   * do about it; nothing is thrown at the preview.
   */
  static async start(options: LspClientOptions): Promise<LspClient | undefined> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        // The user's own environment, without Morse's variables or `node --watch`'s
        // IPC channel (`child-env.ts`): `npx` and the servers it runs are Node
        // programs, and one talking to the host's supervisor is a mystery bug.
        env: childProcessEnv(),
        windowsHide: true,
      });
    } catch (error) {
      options.logger.warn(`Could not start ${options.label}`, error);
      return undefined;
    }

    const client = new LspClient(child, options);
    const started = await client.initialize();
    if (!started) {
      client.dispose();
      return undefined;
    }
    return client;
  }

  get label(): string {
    return this.options.label;
  }

  /** Whether the process is still believed alive. */
  get alive(): boolean {
    return !this.dead && this.child.exitCode === null;
  }

  /**
   * A request, answered with `undefined` on timeout or on a server error. The
   * three LSP methods this host uses all answer "nothing to show" with `null`,
   * so the two cases collapse into one for the caller anyway.
   */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.dead) {
      return undefined;
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.options.logger.debug(`${this.options.label}: ${method} timed out`);
        resolve(undefined);
      }, timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, timer, method });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.dead) {
      return;
    }
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Opens (or re-opens) a document, so the server will answer about it. */
  open(path: string, languageId: string, text: string): void {
    const uri = toFileUri(path);
    const existing = this.documents.get(uri);
    if (existing === undefined) {
      this.documents.set(uri, { languageId, version: 1 });
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text },
      });
      return;
    }
    existing.version += 1;
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: existing.version },
      contentChanges: [{ text }],
    });
  }

  /** What the server last published for a document URI. */
  diagnosticsFor(uri: string): LspDiagnostic[] {
    return this.published.get(uri) ?? [];
  }

  /**
   * Called whenever the server publishes diagnostics, with the URI it named.
   * The listener reads `diagnosticsFor` — the notification is a signal, not the
   * payload, so a slow listener cannot miss an update.
   */
  onDiagnostics(listener: (uri: string) => void): () => void {
    this.diagnosticsListeners.add(listener);
    return () => this.diagnosticsListeners.delete(listener);
  }

  /** Ends the server: `shutdown`, `exit`, then force if it lingers. */
  dispose(): void {
    if (this.dead) {
      return;
    }
    this.dead = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(undefined);
      this.pending.delete(id);
    }
    this.documents.clear();
    this.published.clear();
    this.diagnosticsListeners.clear();
    try {
      this.notify('shutdown', null);
      this.write({ jsonrpc: '2.0', method: 'exit', params: null });
    } catch {
      // The pipe is already gone; the kill below is what matters.
    }
    const child = this.child;
    const kill = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, EXIT_GRACE_MS);
    kill.unref?.();
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }

  private async initialize(): Promise<boolean> {
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.options.logger.debug(`${this.options.label}: ${chunk.toString('utf8').trimEnd()}`);
    });
    this.child.on('error', (error) => {
      this.options.logger.warn(`${this.options.label} failed`, error);
      this.markDead();
    });
    this.child.on('exit', (code, signal) => {
      if (!this.dead) {
        this.options.logger.info(`${this.options.label} exited (${code ?? signal ?? 'unknown'})`);
      }
      this.markDead();
    });

    const result = await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'morse' },
        rootUri: toFileUri(this.options.cwd),
        workspaceFolders: null,
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            references: {},
            publishDiagnostics: { relatedInformation: false },
          },
          workspace: { workspaceFolders: false, configuration: false },
        },
      },
      this.options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
    );

    if (result === undefined || this.dead) {
      return false;
    }
    this.notify('initialized', {});
    this.options.logger.info(`${this.options.label} ready`);
    return true;
  }

  private read(child: ChildProcessWithoutNullStreams): void {
    const feed = createLspFrameReader(
      (message) => this.receive(message),
      (error) => this.options.logger.debug(`${this.options.label}: ${error.message}`),
    );
    child.stdout.on('data', (chunk: Buffer) => feed(chunk));
  }

  private receive(message: LspMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const id = typeof message.id === 'number' ? message.id : Number(message.id);
      const pending = this.pending.get(id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(message.error === undefined ? message.result : undefined);
      }
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      this.publish(message.params);
      return;
    }
    // A server -> client request (`workspace/configuration`, `window/workDoneProgress/create`):
    // answering "method not found" is what keeps a server that insists on one
    // from waiting forever.
    if (message.id !== undefined && message.method !== undefined) {
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Morse does not implement ${message.method}` },
      });
    }
  }

  private publish(params: unknown): void {
    const mapped = diagnosticsFrom(params, this.options.cwd);
    if (mapped === undefined) {
      return;
    }
    this.published.set(mapped.uri, mapped.diagnostics);
    for (const listener of [...this.diagnosticsListeners]) {
      listener(mapped.uri);
    }
  }

  private markDead(): void {
    if (this.dead) {
      return;
    }
    this.dead = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(undefined);
      this.pending.delete(id);
    }
  }

  private write(message: LspMessage): void {
    if (this.child.stdin.destroyed) {
      return;
    }
    try {
      this.child.stdin.write(encodeLspMessage(message));
    } catch (error) {
      this.options.logger.debug(`${this.options.label}: write failed`, error);
      this.markDead();
    }
  }
}
