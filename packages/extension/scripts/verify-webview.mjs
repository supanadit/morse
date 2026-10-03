// Guards the VSIX against shipping the wrong webview bundle.
//
// A development build (`ng build --configuration development`, which is what the
// F5 watcher uses) has no `webview.manifest.json`, unhashed asset names and no
// minification. It is easy to package that by accident right after pressing F5,
// so `npm run vsix` refuses to build a VSIX from it.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(here, '..');
const repoRoot = join(extensionRoot, '..', '..');
const webviewRoot = join(extensionRoot, 'media', 'webview');

const problems = [];

const indexHtml = await readFile(join(webviewRoot, 'index.html'), 'utf8').catch(() => undefined);
if (indexHtml === undefined) {
  problems.push(
    `no webview bundle at ${webviewRoot}\n  fix: npm run build:ui && npm run sync-webview`,
  );
}

const rawManifest = await readFile(join(webviewRoot, 'webview.manifest.json'), 'utf8').catch(
  () => undefined,
);
let manifest;
if (rawManifest === undefined) {
  problems.push(
    'media/webview/webview.manifest.json is missing (development builds do not write it)\n' +
      '  fix: npm run build:ui && npm run sync-webview',
  );
} else {
  try {
    manifest = JSON.parse(rawManifest);
  } catch {
    problems.push('media/webview/webview.manifest.json is not valid JSON');
  }
}

if (indexHtml !== undefined && !/main-[A-Z0-9]{6,}\.js/.test(indexHtml)) {
  problems.push(
    'the webview bundle looks like a development build (no hashed main script)\n' +
      '  fix: npm run build:ui && npm run sync-webview',
  );
}

if (manifest) {
  const versionSource = await readFile(
    join(repoRoot, 'packages', 'protocol', 'src', 'version.ts'),
    'utf8',
  ).catch(() => undefined);
  const expected = versionSource
    ? /PROTOCOL_VERSION\s*=\s*(\d+)/.exec(versionSource)?.[1]
    : undefined;
  if (expected && String(manifest.protocolVersion) !== expected) {
    problems.push(
      `webview speaks protocol ${manifest.protocolVersion} but the host expects ${expected}\n` +
        '  fix: rebuild the frontend and rebuild the extension',
    );
  }
}

if (problems.length > 0) {
  console.error(`[morse] refusing to package:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

console.log(
  `[morse] webview bundle verified: ${manifest.name}@${manifest.version} (protocol ${manifest.protocolVersion})`,
);
