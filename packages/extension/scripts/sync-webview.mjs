// Copies the built Angular bundle into `media/webview`, which is what the VS
// Code host serves to the webview and what ends up inside the .vsix.
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(here, '..');
const repoRoot = join(extensionRoot, '..', '..');

const source = join(repoRoot, 'packages', 'ui-angular', 'dist');
const target = join(extensionRoot, 'media', 'webview');
const workspaceName = '@morse/ui-angular';

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
