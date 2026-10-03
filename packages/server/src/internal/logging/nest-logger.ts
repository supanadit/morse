import { Logger } from '@nestjs/common';
import type { MorseLogger } from '@morse/core';

/** Morse's logging port implemented on top of the NestJS logger. */
export class NestMorseLogger implements MorseLogger {
  private readonly logger = new Logger('morse');

  debug(message: string, detail?: unknown): void {
    this.logger.debug(withDetail(message, detail));
  }

  info(message: string, detail?: unknown): void {
    this.logger.log(withDetail(message, detail));
  }

  warn(message: string, detail?: unknown): void {
    this.logger.warn(withDetail(message, detail));
  }

  error(message: string, detail?: unknown): void {
    this.logger.error(withDetail(message, detail));
  }
}

function withDetail(message: string, detail: unknown): string {
  if (detail === undefined) {
    return message;
  }
  if (detail instanceof Error) {
    return `${message}: ${detail.message}`;
  }
  try {
    return `${message} ${JSON.stringify(detail)}`;
  } catch {
    return `${message} ${String(detail)}`;
  }
}
