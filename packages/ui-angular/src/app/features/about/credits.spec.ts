import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CREDITS, type Credit } from './credits';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..');

/** Morse's own packages are not third-party credit; the dialog is about them already. */
function isOwn(name: string): boolean {
  return name.startsWith('@morse/');
}

/** Every workspace manifest, so a new package cannot slip in uncredited. */
function manifests(): string[] {
  const packages = readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(repoRoot, 'packages', entry.name, 'package.json'))
    .filter((path) => existsSync(path));
  return [join(repoRoot, 'package.json'), ...packages];
}

function declaredDependencies(): Set<string> {
  const names = new Set<string>();
  for (const path of manifests()) {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        names.add(name);
      }
    }
  }
  return names;
}

/** The licence the installed package actually declares — the source of truth. */
function installedLicence(name: string): string | undefined {
  const path = join(repoRoot, 'node_modules', name, 'package.json');
  if (!existsSync(path)) {
    return undefined;
  }
  return (JSON.parse(readFileSync(path, 'utf8')) as { license?: string }).license;
}

const declared = declaredDependencies();
const rows = CREDITS.flatMap((group) => group.entries);
const credited = new Map<string, Credit>(
  rows.flatMap((entry) => (entry.packages ?? []).map((name) => [name, entry] as const)),
);

describe('credits', () => {
  it('credits every dependency the workspace declares', () => {
    const missing = [...declared].filter((name) => !isOwn(name) && !credited.has(name)).sort();
    // Add the row to `credits.ts`; the About dialog is the only place it shows up.
    expect(missing).toEqual([]);
  });

  it('drops rows whose package is no longer used', () => {
    const stale = [...credited.keys()].filter((name) => !declared.has(name)).sort();
    expect(stale).toEqual([]);
  });

  it('keeps every licence id in step with the installed package', () => {
    const wrong = [...credited]
      .map(([name, entry]) => ({ name, credited: entry.license, installed: installedLicence(name) }))
      .filter((row) => row.installed !== undefined && row.installed !== row.credited)
      .map((row) => `${row.name}: credited ${row.credited}, installed ${row.installed}`);
    expect(wrong).toEqual([]);
  });

  it('gives every row a link, a licence and a reason to be there', () => {
    const thin = rows
      .filter((entry) => !entry.url.startsWith('https://') || entry.license.length === 0)
      .map((entry) => entry.name);
    const unexplained = rows.filter((entry) => entry.role.trim().length < 15).map((entry) => entry.name);
    expect({ thin, unexplained }).toEqual({ thin: [], unexplained: [] });
  });
});
