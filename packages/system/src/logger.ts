/**
 * Minimal logging port owned by the core. Adapters (VS Code OutputChannel,
 * NestJS Logger, console) implement it — core never imports a logging library.
 */
export interface MorseLogger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

interface ConsoleSink {
  log(...args: unknown[]): void;
}

export const silentLogger: MorseLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Portable console logger. Reads `globalThis.console` through a local shape so
 * the core stays buildable without DOM or Node type libraries.
 */
export function createConsoleLogger(prefix = '[morse]'): MorseLogger {
  const sink = (globalThis as { console?: ConsoleSink }).console;
  const write = (level: string, message: string, detail?: unknown): void => {
    if (!sink) {
      return;
    }
    const line = `${prefix} ${level} ${message}`;
    if (detail === undefined) {
      sink.log(line);
      return;
    }
    sink.log(line, detail);
  };
  return {
    debug: (message, detail) => write('debug', message, detail),
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
  };
}
