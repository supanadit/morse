// Keeps `media/webview` in sync with the Angular build output while developing,
// so the Extension Development Host (F5) picks up UI changes on save.
import { cp, mkdir, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = join(here, '..');
const repoRoot = join(extensionRoot, '..', '..');

const source = join(repoRoot, 'packages', 'ui-angular', 'dist');
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
    console.log(`[morse] synced ui-angular -> media/webview (${new Date().toLocaleTimeString()})`);
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