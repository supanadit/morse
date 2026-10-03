import * as vscode from 'vscode';
import type { MorseLogger } from '@morse/core';

/** Morse's logging port implemented on the VS Code output channel. */
export class OutputChannelLogger implements MorseLogger, vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Morse');

  debug(message: string, detail?: unknown): void {
    this.write('debug', message, detail);
  }

  info(message: string, detail?: unknown): void {
    this.write('info', message, detail);
  }

  warn(message: string, detail?: unknown): void {
    this.write('warn', message, detail);
  }

  error(message: string, detail?: unknown): void {
    this.write('error', message, detail);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(level: string, message: string, detail: unknown): void {
    this.channel.appendLine(`[${level}] ${message}${formatDetail(detail)}`);
  }
}

function formatDetail(detail: unknown): string {
  if (detail === undefined) {
    return '';
  }
  if (detail instanceof Error) {
    return ` — ${detail.message}`;
  }
  try {
    return ` — ${JSON.stringify(detail)}`;
  } catch {
    return ` — ${String(detail)}`;
  }
}
