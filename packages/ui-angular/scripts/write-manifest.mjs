// Writes the frontend manifest next to the built index.html.
//
// It is what makes the frontend swappable: any host reads
// `webview.manifest.json`, checks `protocolVersion`, and serves whatever
// directory it points at. Build a different frontend package and the hosts do
// not change.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const repoPackages = join(packageRoot, '..');

const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));

// The protocol version lives in one place: packages/protocol/src/version.ts.
const versionSource = await readFile(join(repoPackages, 'protocol', 'src', 'version.ts'), 'utf8');
const match = /PROTOCOL_VERSION\s*=\s*(\d+)/.exec(versionSource);
const protocolVersion = match ? Number(match[1]) : 1;

const manifest = {
  name: pkg.name,
  version: pkg.version,
  protocolVersion,
  entry: 'index.html',
  generatedAt: new Date().toISOString(),
};

const targetDirectory = join(packageRoot, 'dist');
await mkdir(targetDirectory, { recursive: true });
const target = join(targetDirectory, 'webview.manifest.json');
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(
  `[morse] frontend manifest: ${manifest.name}@${manifest.version} (protocol ${protocolVersion}) -> ${target}`,
);
