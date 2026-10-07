/**
 * Which language a file is, and which server answers for it.
 *
 * The frontend has its own extension map (`core/highlight.ts`) for syntax
 * highlighting; this one is deliberately separate because it is a different
 * question: `highlight.js` wants a grammar (`xml` for `.html`), LSP wants its
 * own language id (`html`, served by a different server than `xml`). Sharing one
 * table would mean one of the two lying about the other's vocabulary.
 *
 * Resolution order for a server binary, cheapest and most local first:
 *
 * 1. `MORSE_LSP_<KEY>` — an explicit path wins, like `MORSE_PI_PATH` does for pi.
 * 2. `<project>/node_modules/.bin/<bin>` — the version the project itself pinned,
 *    which is what an editor would use.
 * 3. `PATH`.
 * 4. `npx -y <package>` — downloads on first use, so a host with nothing
 *    installed still works; a host with no network and nothing installed gets
 *    `undefined`, which is why the capability is a promise the preview checks.
 */
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** One server Morse knows how to start. */
export interface LanguageServerSpec {
  /** The LSP language ids this server answers for. */
  languages: readonly string[];
  /** The executable, as it is named on `PATH`. */
  command: string;
  args: readonly string[];
  /** The npm package `npx` can fetch when nothing is installed. */
  npxPackage: string;
  /** The `MORSE_LSP_<KEY>` override this server reads. */
  envKey: string;
}

/**
 * The servers Morse will start on its own. The list is short on purpose: each
 * entry is a promise that hovering works, so it holds only servers that speak
 * plain stdio LSP without extra ceremony.
 */
export const LANGUAGE_SERVERS: readonly LanguageServerSpec[] = [
  {
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    npxPackage: 'typescript-language-server',
    envKey: 'MORSE_LSP_TS',
  },
  {
    languages: ['json', 'jsonc'],
    command: 'vscode-json-language-server',
    args: ['--stdio'],
    npxPackage: 'vscode-langservers-extracted',
    envKey: 'MORSE_LSP_JSON',
  },
  {
    languages: ['yaml'],
    command: 'yaml-language-server',
    args: ['--stdio'],
    npxPackage: 'yaml-language-server',
    envKey: 'MORSE_LSP_YAML',
  },
  {
    languages: ['shellscript'],
    command: 'bash-language-server',
    args: ['start'],
    npxPackage: 'bash-language-server',
    envKey: 'MORSE_LSP_SH',
  },
  {
    languages: ['go'],
    command: 'gopls',
    args: ['serve'],
    npxPackage: 'gopls',
    envKey: 'MORSE_LSP_GO',
  },
  {
    languages: ['python'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    npxPackage: 'pyright',
    envKey: 'MORSE_LSP_PY',
  },
];

/** Extension (lowercase, no dot) -> LSP language id. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  json: 'json',
  jsonc: 'jsonc',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  go: 'go',
  py: 'python',
  pyi: 'python',
};

/**
 * The LSP language of a path, by extension only — the same honest rule the
 * frontend's highlighter uses. A file with no extension (or one Morse has no
 * server for) is `undefined`, and the preview says so instead of guessing.
 */
export function languageIdForPath(path: string): string | undefined {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
}

/** The server that answers for a language, if Morse knows one. */
export function serverForLanguage(languageId: string): LanguageServerSpec | undefined {
  return LANGUAGE_SERVERS.find((server) => server.languages.includes(languageId));
}

/**
 * The command line to start a server with, or `undefined` when nothing here can
 * run it. The `via` is only for the log ("resolved via PATH"), so a user can see
 * *why* Morse picked a particular binary.
 */
export async function resolveServerCommand(
  spec: LanguageServerSpec,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ command: string; args: string[]; via: string } | undefined> {
  const override = env[spec.envKey]?.trim();
  if (override !== undefined && override.length > 0) {
    return { command: override, args: [...spec.args], via: spec.envKey };
  }

  const local = join(root, 'node_modules', '.bin', spec.command);
  if (isExecutable(local)) {
    return { command: local, args: [...spec.args], via: 'the project’s node_modules' };
  }

  const found = searchPath(spec.command, env);
  if (found !== undefined) {
    return { command: found, args: [...spec.args], via: 'PATH' };
  }

  // Nothing installed: `npx` fetches it. It is deliberately the last resort — it
  // needs the network, and the first run is slow enough to look like a hang.
  return {
    command: 'npx',
    args: ['-y', spec.npxPackage, ...spec.args],
    via: `npx (${spec.npxPackage})`,
  };
}

/** A `PATH` lookup, because `spawn` failing on ENOENT tells us too late. */
export function searchPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const path = env.PATH ?? '';
  const extensions =
    process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of path.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return existsSync(path) && process.platform === 'win32';
  }
}
