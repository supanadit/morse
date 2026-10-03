// Copies a built frontend package into `media/webview`, which is what the VS
// Code host serves to the webview and what ends up inside the .vsix.
//
// Swapping the frontend is exactly this one command with a different package:
//   node scripts/sync-webview.mjs --frontend=ui-react
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(here, '..');
const repoRoot = join(extensionRoot, '..', '..');

const frontendArg = process.argv.find((value) => value.startsWith('--frontend='));
const frontend = frontendArg ? frontendArg.split('=')[1] : process.env.MORSE_FRONTEND ?? 'ui-angular';

const source = join(repoRoot, 'packages', frontend, 'dist');
const target = join(extensionRoot, 'media', 'webview');

const frontendPackageJson = join(repoRoot, 'packages', frontend, 'package.json');
const workspaceName = await readFile(frontendPackageJson, 'utf8')
  .then((raw) => JSON.parse(raw).name)
  .catch(() => undefined);

if (!workspaceName) {
  console.error(
    `[morse] unknown frontend package "${frontend}".\n` +
      `        Expected a package at packages/${frontend} (e.g. ui-angular).\n` +
      `        Use --frontend=<folder name> or MORSE_FRONTEND=<folder name>.`,
  );
  process.exit(1);
}

const manifestPath = join(source, 'webview.manifest.json');
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch {
  console.error(
    `[morse] no frontend build found at ${source}.\n` +
      `        Build it first: npm run build -w ${workspaceName}`,
  );
  process.exit(1);
}

await stat(join(source, 'index.html')).catch(() => {
  console.error(`[morse] ${source} has a manifest but no index.html.`);
  process.exit(1);
});

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

console.log(
  `[morse] webview bundle: ${manifest.name}@${manifest.version} ` +
    `(protocol ${manifest.protocolVersion}) -> ${target}`,
);
