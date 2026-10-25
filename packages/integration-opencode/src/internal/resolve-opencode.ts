import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Finds the OpenCode binary without spawning it.
 *
 * Auto-detection is why a host that has OpenCode installed can offer it with no
 * configuration, while a pi-only machine pays nothing: no binary and no
 * configured URL means the engine is never constructed, so no server is started.
 *
 * The check is a PATH walk (plus the Windows shim extensions), mirroring how the
 * pi adapter resolves its binary; an explicit path is validated the same way so a
 * typo fails at registration with the path the user wrote, not later at spawn.
 */
export function findOpenCodeBinary(
  binary = 'opencode',
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // An explicit path may itself contain a separator; treat it as the answer.
  if (binary.includes('/') || binary.includes('\\')) {
    return isExecutable(binary) ? binary : undefined;
  }
  const pathValue = env.PATH ?? env.Path ?? '';
  if (pathValue.length === 0) {
    return undefined;
  }
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    for (const candidate of candidatesIn(directory, binary)) {
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function candidatesIn(directory: string, binary: string): string[] {
  if (process.platform !== 'win32') {
    return [join(directory, binary)];
  }
  return ['.exe', '.cmd', '.bat', ''].map((extension) => join(directory, `${binary}${extension}`));
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    // Windows has no executable bit; existence is the whole answer there.
    return process.platform === 'win32';
  }
}
