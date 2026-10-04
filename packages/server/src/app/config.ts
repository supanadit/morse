import { basename, dirname, isAbsolute, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WorkspaceRef } from '@morse/core';
import { FRONTEND_MANIFEST_FILE, frontendIdentity, parseFrontendManifest } from '@morse/protocol';
import type { FrontendIdentity } from '@morse/protocol';
import { DEFAULT_UPLOAD_DIR } from '../internal/uploads/upload-store.js';

export interface MorseServerConfig {
  host: string;
  port: number;
  /** Directory holding the built frontend (index.html + webview.manifest.json). */
  uiDir: string;
  workspace: WorkspaceRef;
  piPath?: string;
  nodeEntryPath?: string;
  sessionDir?: string;
  noSession: boolean;
  requestTimeoutMs: number;
  /** How many `pi` processes stay alive at once (least recently used first). */
  hotSessions: number;
  /** Roots the agent may work in; empty means "any absolute path". */
  projects: string[];
  /** Where browser uploads land: relative to a session cwd, or absolute. */
  uploadDir: string;
  /**
   * Whether the frontend may ask the registry for the latest release. On unless
   * `MORSE_UPDATE_CHECK=0`; an air-gapped host turns it off rather than letting
   * the panel try and fail.
   */
  updateCheck: boolean;
  /**
   * Opaque token the `morse` CLI mints for each daemon it spawns. Relayed by
   * `/api/health`, it lets the CLI prove which process is answering instead of
   * trusting a pid that the OS may have recycled to an unrelated process.
   * Undefined when the server is started without the CLI.
   */
  instance?: string;
  /**
   * The bundle this host serves, as its own manifest declares it. Relayed to
   * clients in `host/ready`, so a frontend can name itself (the About dialog) and
   * the host log says which build is talking. Undefined when the directory has no
   * usable manifest — a bare dev directory, say.
   */
  frontend?: FrontendIdentity;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MorseServerConfig {
  const workspacePath = resolveWorkspacePath(env);
  const configuredUiDir = env.MORSE_UI_DIR;
  // ESM has no __dirname. In the monorepo this file lives in
  // <repo>/packages/server/dist/app, so the Angular build sits three levels up;
  // in the published bundle the frontend is copied next to the bundled server
  // (<pkg>/dist/ui). Pick whichever actually holds an index.html.
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const bundledUiDir = join(moduleDir, 'ui');
  const monorepoUiDir = join(moduleDir, '..', '..', '..', 'ui-angular', 'dist');
  const defaultUiDir = existsSync(join(bundledUiDir, 'index.html'))
    ? bundledUiDir
    : monorepoUiDir;
  const defaultHost = '127.0.0.1';
  const uiDir = configuredUiDir
    ? isAbsolute(configuredUiDir)
      ? configuredUiDir
      : join(process.cwd(), configuredUiDir)
    : defaultUiDir;

  return {
    host: env.MORSE_HOST ?? defaultHost,
    port: parsePositiveInt(env.MORSE_PORT, 4399),
    uiDir,
    frontend: readFrontendIdentity(uiDir),
    workspace: { cwd: workspacePath, name: basename(workspacePath) || workspacePath },
    piPath: env.MORSE_PI_PATH,
    nodeEntryPath: env.MORSE_PI_ENTRY,
    sessionDir: env.MORSE_SESSION_DIR,
    noSession: env.MORSE_NO_SESSION === '1',
    requestTimeoutMs: parsePositiveInt(env.MORSE_REQUEST_TIMEOUT_MS, 30_000),
    hotSessions: parsePositiveInt(env.MORSE_HOT_SESSIONS, 4),
    projects: parseList(env.MORSE_PROJECTS),
    uploadDir: env.MORSE_UPLOAD_DIR?.trim() || DEFAULT_UPLOAD_DIR,
    updateCheck: !isOff(env.MORSE_UPDATE_CHECK),
    instance: env.MORSE_INSTANCE?.trim() || undefined,
  };
}

/**
 * Which frontend this host is serving, read from the directory it will serve. The
 * manifest is the frontend's own statement about itself; the host only relays it,
 * exactly like the VS Code host relays the same file.
 */
function readFrontendIdentity(uiDir: string): FrontendIdentity | undefined {
  try {
    return frontendIdentity(
      parseFrontendManifest(readFileSync(join(uiDir, FRONTEND_MANIFEST_FILE), 'utf8')),
    );
  } catch {
    return undefined;
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** `MORSE_UPDATE_CHECK=0` (or `false`/`off`) turns the release check off. */
function isOff(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '0' || normalized === 'false' || normalized === 'off';
}

/** `MORSE_PROJECTS=/a:/b` or `MORSE_PROJECTS=/a,/b` -> ['/a', '/b']. */
function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[:,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Where the agent runs. `MORSE_WORKSPACE` wins; otherwise use the current
 * directory, except when that is a package inside a workspace monorepo —
 * `npm run -w @morse/server` sets the cwd to `packages/server`, which is
 * almost never the project the user wants the agent to work on.
 */
function resolveWorkspacePath(env: NodeJS.ProcessEnv): string {
  const explicit = env.MORSE_WORKSPACE;
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }

  const start = process.cwd();
  let directory = start;
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest) && declaresWorkspaces(manifest)) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return start;
    }
    directory = parent;
  }
}

function declaresWorkspaces(manifestPath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { workspaces?: unknown };
    return manifest.workspaces !== undefined;
  } catch {
    return false;
  }
}
