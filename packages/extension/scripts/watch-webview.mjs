// Keeps `media/webview` in sync with a frontend's build output while developing,
// so the Extension Development Host (F5) picks up UI changes on save.
//
//   node scripts/watch-webview.mjs [--frontend=ui-angular]
import { cp, mkdir, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(here, '..');
const repoRoot = join(extensionRoot, '..', '..');

const frontendArg = process.argv.find((value) => value.startsWith('--frontend='));
const frontend = frontendArg ? frontendArg.split('=')[1] : process.env.MORSE_FRONTEND ?? 'ui-angular';
const source = join(repoRoot, 'packages', frontend, 'dist');
const target = join(extensionRoot, 'media', 'webview');

let timer;
let syncing = false;
let pending = false;

async function sync() {
  if (syncing) {
    pending = true;
    return;
  }
  syncing = true;
  try {
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true });
    console.log(`[morse] synced ${frontend} -> media/webview (${new Date().toLocaleTimeString()})`);
  } catch (error) {
    console.warn(`[morse] sync skipped: ${error instanceof Error ? error.message : error}`);
  } finally {
    syncing = false;
    if (pending) {
      pending = false;
      void sync();
    }
  }
}

await sync();
console.log(`[morse] watching ${source} (Ctrl+C to stop)`);

watch(source, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void sync(), 150);
});