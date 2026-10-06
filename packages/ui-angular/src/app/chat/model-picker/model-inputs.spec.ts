import { describe, expect, it } from 'vitest';
import type { ModelInput } from '@morse/protocol';
import { MODEL_INPUT_LABELS, modelInputBadges, modelInputKeywords } from './model-inputs';

describe('modelInputBadges', () => {
  it('gives every modality a label and an icon', () => {
    const badges = modelInputBadges(['text', 'image']);
    expect(badges.map((badge) => badge.modality)).toEqual(['text', 'image']);
    expect(badges.map((badge) => badge.label)).toEqual([
      MODEL_INPUT_LABELS.text,
      MODEL_INPUT_LABELS.image,
    ]);
    for (const badge of badges) {
      expect(badge.paths.length).toBeGreaterThan(0);
    }
  });

  it('preserves the order pi reported', () => {
    expect(modelInputBadges(['image', 'text']).map((badge) => badge.modality)).toEqual([
      'image',
      'text',
    ]);
  });

  it('renders nothing when pi did not report input', () => {
    expect(modelInputBadges(undefined)).toEqual([]);
    expect(modelInputBadges([])).toEqual([]);
  });

  it('falls back to a text glyph for a modality with no icon yet', () => {
    const badges = modelInputBadges(['weird' as ModelInput]);
    expect(badges[0].label).toBe('weird');
    expect(badges[0].paths.length).toBeGreaterThan(0);
  });
});

describe('modelInputKeywords', () => {
  it('lets "vision" find an image-capable model', () => {
    expect(modelInputKeywords(['text', 'image'])).toContain('vision');
  });

  it('is empty when there is nothing to say', () => {
    expect(modelInputKeywords(undefined)).toBe('');
  });
});
