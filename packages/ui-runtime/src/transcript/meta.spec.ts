import { describe, expect, it } from 'vitest';
import type { ModelOption } from '@morse/protocol';
import { clockTime, fullTime, modelMeta } from './meta.js';

const AT = Date.UTC(2026, 10, 15, 7, 42, 4);
const catalog: ModelOption[] = [
  { provider: 'zai', id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
  { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
];

describe('clockTime / fullTime', () => {
  it('renders nothing for a missing timestamp', () => {
    expect(clockTime(0)).toBe('');
    expect(fullTime(-1)).toBe('');
  });

  it('renders the locale clock and the full stamp for a real timestamp', () => {
    expect(clockTime(AT)).toBe(
      new Date(AT).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
    expect(fullTime(AT)).toBe(new Date(AT).toLocaleString());
  });
});

describe('modelMeta', () => {
  it('resolves a bare id from pi history to the catalog name', () => {
    expect(modelMeta('glm-5.3-flash', catalog)).toEqual({
      label: 'GLM-5.3-Flash',
      title: 'zai/glm-5.3-flash',
    });
  });

  it('resolves a provider/id stamp from OpenCode history', () => {
    expect(modelMeta('anthropic/claude-sonnet-4', catalog)).toEqual({
      label: 'Claude Sonnet 4',
      title: 'anthropic/claude-sonnet-4',
    });
  });

  it('keeps an unknown id visible instead of blanking it', () => {
    expect(modelMeta('retired-model', catalog)).toEqual({
      label: 'retired-model',
      title: 'retired-model',
    });
  });

  it('reports nothing when the engine named no model', () => {
    expect(modelMeta(undefined, catalog)).toBeUndefined();
    expect(modelMeta('', catalog)).toBeUndefined();
  });
});
