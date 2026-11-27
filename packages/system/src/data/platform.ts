import { homedir } from 'node:os';

/** `PATHEXT` is a shell variable and is often absent from GUI processes. */
export function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? env.Pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

 /**
  * Expands a user-configured executable path: a leading `~` and `$VAR`/`${VAR}`
 * references. Settings and env vars are typed with these literally (a mac user
 * writes `~/.local/bin/pi`), but `spawn`/`existsSync` never expand them, so an
 * unexpanded value silently resolves to "not installed".
 */
export function expandConfiguredPath(raw: string): string {
  const home = homedir();
  const withHome =
    raw === '~' ? home : raw.startsWith('~/') || raw.startsWith('~\\') ? home + raw.slice(1) : raw;
  return withHome.replace(
    /(?<!\$)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (whole, braced: string | undefined, bare: string | undefined) =>
      process.env[braced ?? bare ?? ''] ?? whole,
  );
}
