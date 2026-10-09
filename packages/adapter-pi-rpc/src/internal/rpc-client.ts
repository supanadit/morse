import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cleanSpawnEnv } from './spawn-env.js';
import { AgentProtocolError, AgentUnavailableError } from '@morse/core';
import { JsonlFramer } from './jsonl-framer.js';
import type { RpcCommand, RpcExtensionUiResponse, RpcRecord } from './rpc-types.js';

export interface PiRpcClientOptions {
  command: string;
  args: string[];
  cwd: string;
  /** True for a Windows `.cmd`/`.bat` shim that `CreateProcess` cannot start directly. */
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  onRecord: (record: RpcRecord) => void;
  onStderr?: (text: string) => void;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; stderr?: string }) => void;
}

interface PendingRequest {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * How much of pi's stderr to remember for a crash report. pi prints its
 * uncaught-exception trace there, and the last lines name the real cause; the
 * bound keeps a chatty extension from holding the whole session's output in
 * memory. Applied to newline count and characters, whichever bites first.
 */
const STDERR_TAIL_LINES = 40;
const STDERR_TAIL_CHARS = 4_000;

/**
 * Minimal JSONL RPC client for `pi --mode rpc`.
 *
 * Deliberately hand-written: it keeps the extension bundle thin and pins the
 * protocol framing rules (LF only, strip CR, honour stdin backpressure, never
 * parse stderr as protocol data).
 */
export class PiRpcClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly framer = new JsonlFramer();
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private failed: Error | undefined;
  /**
   * The tail of pi's stderr, kept so an exit can 	say *why* it crashed.
   * pi writes its uncaught-exception trace to stderr, which the JSONL stream
   * (stdout) never carries — without this the host could only report
   * "exited (code=1)" and the real error was discarded to a debug log.
   */
  private stderrTail: string[] = [];

  constructor(private readonly options: PiRpcClientOptions) {}

  get running(): boolean {
    return this.child !== undefined;
  }

  start(): void {
    if (this.child) {
      return;
    }
    this.failed = undefined;
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: cleanSpawnEnv(this.options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: this.options.shell ?? false,
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.appendStderr(text);
      this.options.onStderr?.(text);
    });
    child.on('error', (error: Error) => {
      this.failAll(
        new AgentUnavailableError(
          `Failed to start the pi agent (${this.options.command}): ${error.message}`,
          { cause: error },
        ),
      );
    });
    child.on('exit', (code, signal) => {
      this.child = undefined;
      const stderr = this.stderrText();
      this.failAll(
        new AgentUnavailableError(
          `The pi agent exited (code=${code === null ? 'null' : code}, signal=${signal ?? 'null'}).` +
            (stderr.length > 0 ? `\n${stderr}` : ''),
        ),
      );
      this.options.onExit?.({
        code,
        signal,
        ...(stderr.length > 0 ? { stderr } : {}),
      });
    });
  }

  /**
   * Appends a stderr chunk to the bounded tail. Chunks are not line-aligned, so
   * they are kept verbatim and trimmed by line count after a split — a partial
   * last line is still useful in a crash report.
   */
  private appendStderr(text: string): void {
    this.stderrTail.push(text);
    // Join and re-split only when the buffer grows past the line budget, so the
    // common small chunk does no work beyond an array push.
    if (this.stderrTail.length <= STDERR_TAIL_LINES) {
      return;
    }
    const lines = this.stderrTail.join('').split('\n');
    this.stderrTail = lines.slice(-STDERR_TAIL_LINES);
  }

  /** The remembered stderr tail, as one trimmed string (empty when pi was quiet). */
  private stderrText(): string {
    const text = this.stderrTail.join('').trim();
    return text.length > STDERR_TAIL_CHARS ? text.slice(-STDERR_TAIL_CHARS) : text;
  }

  async request<T>(
    command: RpcCommand,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.child) {
      throw this.failed ?? new AgentUnavailableError('The pi agent is not running.');
    }
    const id = `morse-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AgentProtocolError(`pi did not answer "${command.type}" within ${timeoutMs} ms.`),
        );
      }, timeoutMs);
      this.pending.set(id, {
        command: command.type,
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });
      this.write({ id, ...command }, (error) => {
        this.settle(id, error);
      });
    });
  }

  /** Answers an `extension_ui_request`; never expects a matching response. */
  respond(response: RpcExtensionUiResponse): void {
    this.write(response);
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    let exited = false;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        exited = true;
        resolve();
      };
      child.once('exit', finish);
      // Documented orderly shutdown: closing stdin lets pi dispose its runtime.
      child.stdin.end();
      setTimeout(resolve, SHUTDOWN_GRACE_MS).unref?.();
    });
    if (!exited) {
      child.kill();
    }
    this.child = undefined;
  }

  private onStdout(chunk: Buffer): void {
    for (const line of this.framer.push(chunk)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.options.onStderr?.(`[morse] unreadable pi record: ${line}\n`);
        continue;
      }
      this.handleRecord(parsed);
    }
  }

  private handleRecord(parsed: unknown): void {
    const record = parsed as RpcRecord;
    if (record !== null && typeof record === 'object' && record['type'] === 'response') {
      this.handleResponse(record);
    }
    this.options.onRecord(record);
  }

  private handleResponse(record: RpcRecord): void {
    const id = typeof record['id'] === 'string' ? record['id'] : undefined;
    if (!id) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (record['success'] === true) {
      pending.resolve(record['data']);
      return;
    }
    const error = typeof record['error'] === 'string' ? record['error'] : 'unknown error';
    pending.reject(new AgentProtocolError(`pi rejected "${pending.command}": ${error}`));
  }

  private write(payload: unknown, onError?: (error: Error) => void): void {
    const child = this.child;
    if (!child) {
      onError?.(new AgentUnavailableError('The pi agent is not running.'));
      return;
    }
    const frame = `${JSON.stringify(payload)}\n`;
    child.stdin.write(frame, 'utf8', (error) => {
      if (error) {
        onError?.(error);
      }
    });
  }

  private settle(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(error);
  }

  private failAll(error: Error): void {
    this.failed = error;
    for (const [id, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
