import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_TOKENS, morseHighlightStyle } from './editor-theme';

const here = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(join(here, '../../../styles.css'), 'utf8');

describe('morseHighlightStyle', () => {
  it('reads only tokens the stylesheet defines', () => {
    for (const token of THEME_TOKENS) {
      expect(styles).toContain(`${token}:`);
    }
  });
  it('is a highlight style', () => {
    expect(morseHighlightStyle).toBeDefined();
  });
});
