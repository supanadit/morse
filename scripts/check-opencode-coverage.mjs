#!/usr/bin/env node
/**
 * Asserts that Morse can drive an OpenCode install the way Morse actually does.
 *
 * `npm test` covers each install layout with fixtures, but fixtures are only as
 * faithful as the person who wrote them: an installer that moves its binary,
 * changes its shim format, or a release that renames `auth login` would keep
 * the unit suite green and break real users. This script runs the *real*
 * install (whatever the CI matrix installed), through the *built* adapter, and
 * fails loudly when any of the reads Morse depends on comes back empty.
 *
 * Besides file reads it also spawns `opencode --version` (read-only, with a
 * timeout): a shim that resolves but cannot start is exactly the failure this
 * script exists to catch.
 *
 * Usage: node scripts/check-opencode-coverage.mjs [--opencode <path>] [--dump]
 */

import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptDir);
const adapterDist = join(packageRoot, 'packages', 'integration-opencode', 'dist');

/** The explicit `--opencode <path>`, if the caller has already resolved one. */
function explicitBinaryPath(argv) {
  const index = argv.indexOf('--opencode');
  return index >= 0 ? argv[index + 1] : undefined;
}

/** The install as it looks on disk: what a failure report needs to explain a new layout. */
function dump(entry) {
  console.log('\n--- opencode install on disk ---');
  try {
    const real = realpathSync(entry);
    console.log(`entry     : ${entry}`);
    console.log(`realpath  : ${real}${real === entry ? ' (not a symlink)' : ''}`);
    const directory = statSync(real).isDirectory() ? real : dirname(real);
    console.log(`directory : ${directory}`);
    console.log(`listing   : ${readdirSync(directory).slice(0, 40).join(', ')}`);
    const text = readFileSync(real, 'utf8').slice(0, 2000);
    console.log('--- entry contents (first 2000 bytes) ---');
    console.log(text);
    console.log('--- end ---');
  } catch (error) {
    console.log(`could not inspect ${entry}: ${String(error)}`);
  }
}

/** A named check that prints on pass and throws on failure. */
function check(name, value, detail) {
  const empty = value === undefined || value === null || (Array.isArray(value) && value.length === 0);
  const ok = !empty && Boolean(value);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail(value)}`}`);
  if (!ok) {
    failures.push(name);
  }
  return ok;
}

const failures = [];

async function main() {
  // The adapter's `exports` map blocks deep imports of built files, so the dist
  // files are reached by path: the resolution logic and the provider sign-in
  // the settings page wires together.
  const resolveUrl = pathToFileURL(join(adapterDist, 'internal', 'resolve-opencode.js')).href;
  const providersUrl = pathToFileURL(join(adapterDist, 'providers', 'open-code-providers.js')).href;
  for (const url of [resolveUrl, providersUrl]) {
    if (!existsSync(fileURLToPath(url))) {
      console.error(`The adapter is not built: ${fileURLToPath(url)} is missing. Run \`npm run build\` first.`);
      process.exit(2);
    }
  }
  const { resolveOpenCodeSpawn } = await import(resolveUrl);
  const { OpenCodeProviders } = await import(providersUrl);

  const configured = explicitBinaryPath(process.argv.slice(2));
  const spawn = resolveOpenCodeSpawn(configured ?? 'opencode', process.env);
  console.log(`opencode spawn: ${spawn === undefined ? '(not found)' : `${spawn.command} ${spawn.prefix.join(' ')}`}`);

  check('resolveOpenCodeSpawn finds opencode on PATH', spawn?.command, (v) => v);
  check(
    'binary entry exists on disk and is executable',
    (() => {
      try {
        return spawn !== undefined && existsSync(spawn.command) && (accessSync(spawn.command, constants.X_OK), true);
      } catch {
        return false;
      }
    })(),
    () => String(spawn?.command),
  );

  if (spawn !== undefined) {
    const version = spawnSync(spawn.command, [...spawn.prefix, '--version'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    check(
      'opencode --version runs and reports a version',
      version.status === 0 && (version.stdout ?? '').trim().length > 0,
      () => (version.stdout ?? version.stderr ?? '').trim().split('\n')[0] ?? '(no output)',
    );
  }

  // The exact object the settings page hands to the host terminal runner,
  // built by the real provider code against the real install. An isolated
  // config home keeps the check from touching the runner's own files.
  const sandbox = mkdtempSync(join(tmpdir(), 'morse-oc-coverage-'));
  const providers = new OpenCodeProviders({
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(sandbox, 'config'),
      XDG_DATA_HOME: join(sandbox, 'data'),
    },
  });
  const login = await providers.loginCommand({ providerId: 'opencode-go' });
  check(
    'loginCommand hands a safe id to `auth login`',
    login !== undefined
      && Array.isArray(login.args)
      && login.args.slice(-3).join(' ') === 'auth login opencode-go',
    () => (login === undefined ? '(undefined)' : `${login.file} ${login.args.join(' ')}`),
  );
  check(
    'loginCommand refuses an unsafe id',
    (await providers.loginCommand({ providerId: 'opencode-go; rm -rf /' })) === undefined,
    () => 'rejected',
  );

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    if (spawn !== undefined) {
      dump(spawn.command);
    }
    process.exit(1);
  }
  console.log('\nAll OpenCode install reads succeeded.');
  if (process.argv.includes('--dump') && spawn !== undefined) {
    dump(spawn.command);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
