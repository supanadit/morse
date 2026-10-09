import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The rules in `packages/ui-angular/AGENTS.md` § *Layers*, as a test.
 *
 * They were written for review, which meant a broken arrow stayed broken until
 * someone happened to look. These are the same rules a reviewer would apply,
 * applied to every file on every run: a violation fails here with the file and
 * the specifier that caused it.
 *
 * Scope: the production sources. A `*.spec.ts` is scaffolding — it wires the
 * implementation it tests and may host a throwaway template — so it is not
 * judged by the layer rules.
 */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The layer order, inner→outer. An import points at the same layer or to the right. */
const LAYERS = ['routing', 'shell', 'features', 'ui', 'services', 'state', 'host'] as const;

interface File {
  /** Path relative to `src/app`, with `/` separators. */
  readonly path: string;
  readonly layer: (typeof LAYERS)[number];
  /** The feature folder, for a file under `features/`. */
  readonly feature?: string;
  readonly source: string;
}

/** Every production file under `src/app`, in a stable order. */
function sources(dir = APP, out: File[] = []): File[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sources(full, out);
      continue;
    }
    if (!full.endsWith('.ts') || full.endsWith('.spec.ts') || full.endsWith('.d.ts')) {
      continue;
    }
    const path = relative(APP, full).split(sep).join('/');
    const segments = path.split('/');
    const layer = segments[0] as (typeof LAYERS)[number];
    if (!(LAYERS as readonly string[]).includes(layer)) {
      throw new Error(`${path}: is not under a layer (${LAYERS.join(', ')})`);
    }
    out.push({
      path,
      layer,
      feature: layer === 'features' ? segments[1] : undefined,
      source: readFileSync(full, 'utf8'),
    });
  }
  return out;
}

/** The specifiers of every `from '…'` and `import('…')` in a source. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|import\s*\(\s*)(['"])([^'"]+)\1/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    found.push(match[2]);
  }
  return found;
}

/** Where a relative specifier points, as a `src/app`-relative path. `undefined` for a package. */
function target(file: File, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  return relative(APP, resolve(APP, dirname(file.path), specifier)).split(sep).join('/');
}

const FILES = sources();
const PACKAGES = new Set(['@morse/protocol', '@morse/ui-runtime']);

/** A layer's position in the order; `routing` is 0 and `host` is outermost. */
function rank(layer: string): number {
  return (LAYERS as readonly string[]).indexOf(layer);
}

describe('frontend conventions', () => {
  it('keeps styles and templates out of the components', () => {
    // A `styles: [...]` block buries the stylesheet inside the class that happens
    // to use it: `git-panel.ts` was 1570 lines, 879 of them CSS. A sibling `.css`
    // (and `.html`) keeps the class about its behaviour and the stylesheet about
    // the look, and matches `shell/app.ts`.
    const inline = FILES.filter(
      (file) => /\bstyles\s*:\s*\[/.test(file.source) || /\btemplate\s*:\s*[`'"]/.test(file.source),
    ).map((file) => file.path);

    expect(inline).toEqual([]);
  });

  it('R-U1: an import points only to its own layer or to the right of it', () => {
    const broken: string[] = [];
    for (const file of FILES) {
      for (const specifier of specifiers(file.source)) {
        const destination = target(file, specifier);
        if (destination === undefined) continue;
        const layer = destination.split('/')[0];
        if (!(LAYERS as readonly string[]).includes(layer)) continue;
        // Rightwards in `routing → shell → features → ui → services → state → host`.
        if (rank(layer) < rank(file.layer)) {
          broken.push(`${file.path} → ${specifier} (${file.layer} → ${layer})`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  it('R-U2: no panel depends on itself, directly or through another', () => {
    // A flat `features/` means a panel may compose the panels it is made of: the composer
    // owns its pickers, the transcript its tool group, the git panel the branch picker.
    // What it may not do is close a loop — two panels that need each other cannot be
    // reasoned about, tested or moved apart, and no amount of review catches it.
    const edges = new Map<string, Set<string>>();
    for (const file of FILES) {
      if (file.layer !== 'features' || file.feature === undefined) continue;
      for (const specifier of specifiers(file.source)) {
        const destination = target(file, specifier);
        if (destination === undefined || !destination.startsWith('features/')) continue;
        const reached = destination.split('/')[1];
        if (reached === file.feature) continue;
        const out = edges.get(file.feature) ?? new Set<string>();
        out.add(reached);
        edges.set(file.feature, out);
      }
    }

    const loops: string[] = [];
    for (const panel of edges.keys()) {
      const reached = new Set<string>();
      const queue = [...(edges.get(panel) ?? [])];
      while (queue.length > 0) {
        const next = queue.pop() as string;
        if (next === panel) {
          loops.push(panel);
          break;
        }
        if (reached.has(next)) {
          continue;
        }
        reached.add(next);
        queue.push(...(edges.get(next) ?? []));
      }
    }

    expect([...new Set(loops)].sort()).toEqual([]);
  });

  it('R-U6: the host seam depends on no other layer, and on no other Morse package', () => {
    // The seam exists so that everything above reaches a host through one port —
    // `MorseService` — and never past it. A framework package is not a Morse
    // package and is not what this rule is about: every service injects
    // `@angular/core`, `host/` included.
    const broken: string[] = [];
    for (const file of FILES) {
      if (file.layer !== 'host') continue;
      for (const specifier of specifiers(file.source)) {
        if (specifier.startsWith('@morse/')) {
          if (!PACKAGES.has(specifier)) broken.push(`${file.path} → ${specifier}`);
          continue;
        }
        const destination = target(file, specifier);
        if (destination !== undefined && !destination.startsWith('host/')) {
          broken.push(`${file.path} → ${specifier}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  it('R-U7: only shell and routing reach into more than one feature', () => {
    const broken: string[] = [];
    for (const file of FILES) {
      if (file.layer === 'shell' || file.layer === 'routing' || file.layer === 'features') continue;
      const reached = new Set<string>();
      for (const specifier of specifiers(file.source)) {
        const destination = target(file, specifier);
        if (destination?.startsWith('features/')) reached.add(destination.split('/')[1]);
      }
      if (reached.size > 1) broken.push(`${file.path} → ${[...reached].sort().join(', ')}`);
    }

    expect(broken).toEqual([]);
  });
});
