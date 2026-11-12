import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ICON_KINDS } from '@morse/ui-runtime';

/**
 * The sprite is markup, not code, so nothing type-checks a row's `icon` against it.
 * A kind with no `<symbol>` renders an empty box with no error anywhere — the one
 * failure this component can have that no other test would notice.
 */
describe('the icon sprite', () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.html'), 'utf8');

  it('defines a symbol for every icon kind', () => {
    const missing = ICON_KINDS.filter((kind) => !html.includes(`id="morse-${kind}"`));
    expect(missing).toEqual([]);
  });

  it('keeps the sprite out of the layout', () => {
    // Chrome does not apply the `hidden` attribute's rule to an SVG element, which
    // left the sprite's default 300x150 box in the shell.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../styles.css'), 'utf8');
    expect(/(^|\n)\.icon-sprite\s*\{[^}]*display:\s*none/.test(css)).toBe(true);
    expect(html).not.toMatch(/<svg class="icon-sprite"[^>]*\shidden/);
  });

  it('marks the sprite as decoration, so a screen reader skips it', () => {
    expect(html).toMatch(/<svg class="icon-sprite" aria-hidden="true">/);
  });
});
