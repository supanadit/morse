#!/usr/bin/env node
/**
 * Asserts that Morse can read a pi install the way Morse actually does.
 *
 * `npm test` covers each install layout with fixtures, but fixtures are only as
 * faithful as the person who wrote them: an installer that moves its launcher,
 * changes its shim format, or switches package manager layout would keep the
 * unit suite green and break real users. This script runs the *real* install
 * (whatever the CI matrix installed), through the *built* adapter, and fails
 * loudly when any of the four reads Morse depends on comes back empty.
 *
 * It deliberately does not spawn pi: every check is a file read, so it also runs
 * against the fixtures on a machine where pi cannot start.
 *
 * Usage: node scripts/check-pi-coverage.mjs [--pi <path>] [--dump]
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptDir);
const adapterDist = join(packageRoot, 'packages', 'integration-pi', 'dist');

/** The explicit `--pi <path>`, if the caller has already resolved one. */
function explicitPiPath(argv) {
  const index = argv.indexOf('--pi');
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * The install as it looks on disk: what a failure report needs to explain a new
 * layout without guessing. Printed when the checks fail, or always with --dump.
 */
function dump(entry) {
  console.log('\n--- pi install on disk ---');
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
  // files are reached by path: the resolution logic and the palette builder the
  // extension wires together.
  const resolvePiUrl = pathToFileURL(join(adapterDist, 'internal', 'resolve-pi.js')).href;
  const installUrl = pathToFileURL(join(adapterDist, 'internal', 'pi-install.js')).href;
  const agentUrl = pathToFileURL(join(adapterDist, 'pi-rpc-agent.js')).href;
  for (const url of [resolvePiUrl, installUrl, agentUrl]) {
    if (!existsSync(fileURLToPath(url))) {
      console.error(`The adapter is not built: ${fileURLToPath(url)} is missing. Run \`npm run build\` first.`);
      process.exit(2);
    }
  }
  const { resolvePi, readPiVersion } = await import(resolvePiUrl);
  const { piPackageRoot, piEntry } = await import(installUrl);
  const { buildCommandList } = await import(agentUrl);

  const configured = explicitPiPath(process.argv.slice(2));
  const spawn = resolvePi(configured === undefined ? {} : { piPath: configured });
  console.log(`pi spawn   : ${spawn.command} ${spawn.args.slice(0, 2).join(' ')} (${spawn.source})`);

  check('resolvePi finds pi on PATH', spawn.command, (v) => v);
  // The same rule the adapter reads use — a Windows npm shim bypassed to
  // `node.exe <script.js>` must yield the script, not the node binary (whose
  // directory holds no pi package and whose bytes are not shim text).
  const entry = piEntry(spawn);
  check('pi entry exists on disk', entry !== undefined && existsSync(entry), (v) => `${String(entry)} (${String(v)})`);

  const root = piPackageRoot(entry ?? '');
  check('piPackageRoot resolves the package root', root, (v) => v);

  const version = readPiVersion(spawn);
  check('readPiVersion reads a version', version, (v) => v);

  if (root !== undefined) {
    check(
      'package.json at that root is pi’s',
      (() => {
        try {
          return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === '@earendil-works/pi-coding-agent';
        } catch {
          return false;
        }
      })(),
      () => 'verified',
    );
  }

  const { commands, diagnostics } = await buildCommandList(undefined, { cwd: packageRoot, env: process.env, spawn });
  const builtins = commands.filter((command) => command.source === 'builtin');
  check('getBuiltinSlashCommands yields builtins', builtins.length > 0, () => {
    return `${builtins.length} builtins (e.g. ${builtins.slice(0, 3).map((command) => command.name).join(', ')})`;
  });
  const unreadable = diagnostics.filter((diagnostic) => diagnostic.key === 'pi-builtins:unreadable');
  check('buildCommandList reports no unreadable-pi diagnostic', unreadable.length === 0, () => {
    return `${unreadable.length} unreadable diagnostics`;
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    dump(entry);
    process.exit(1);
  }
  console.log('\nAll pi install reads succeeded.');
  if (process.argv.includes('--dump')) {
    dump(entry);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
