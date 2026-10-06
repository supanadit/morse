import { execFile } from 'node:child_process';

/**
 * The `PATH` a login shell sees.
 *
 * VS Code started from the Dock/launcher does not source the user's profile, so
 * a `pi` installed through nvm, asdf, volta or fnm — all of which append to
 * `PATH` in `.zshrc`/`.bashrc` — is invisible to the extension host even though
 * it works in the integrated terminal. VS Code's own "shell environment
 * resolution" exists for this; running the login shell once is the small,
 * dependency-free version of it.
 *
 * Best effort: no shell (Windows), a shell that hangs, or one that does not
 * print a PATH leaves the caller with the process PATH it already had.
 */
export async function loginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  if (process.platform === 'win32') {
    return undefined;
  }
  const shell = env.SHELL !== undefined && env.SHELL.trim().length > 0 ? env.SHELL.trim() : '/bin/bash';
  return new Promise((resolve) => {
    execFile(
      shell,
      // Log-in *and* interactive: nvm/asdf/volta are usually set up in `.zshrc`
      // or `.bashrc`, which a non-interactive shell never sources.
      ['-lic', 'printf "__MORSE_PATH__%s__MORSE_END__" "$PATH"'],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, env },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(extractLoginPath(stdout));
      },
    );
  });
}

/**
 * The PATH between the sentinels, so a profile that prints a banner to stdout
 * cannot be mistaken for the PATH itself. Exported for the test.
 */
export function extractLoginPath(stdout: string): string | undefined {
  const match = /__MORSE_PATH__([\s\S]*?)__MORSE_END__/.exec(stdout);
  const path = match?.[1]?.trim();
  return path !== undefined && path.length > 0 ? path : undefined;
}
