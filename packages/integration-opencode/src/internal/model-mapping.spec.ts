import { describe, expect, it } from 'vitest';
import {
  levelOfVariant,
  thinkingLevelOf,
  thinkingLevelsOf,
  toModelRef,
  toModelRefs,
  variantForLevel,
  type ApiModel,
} from './model-mapping.js';

/**
 * Recorded `GET /api/model` entries. OpenCode calls a reasoning effort a variant;
 * Morse calls it a thinking level, and the mapping is the whole contract between
 * them — including the `"default"` sentinel a fresh session reports.
 */

const WITH_VARIANTS: ApiModel = {
  id: 'flint-40b-free',
  modelID: 'flint-40b-free',
  providerID: 'opencode',
  name: 'Flint 40B Free',
  variants: [
    { id: 'low', settings: { reasoningEffort: 'low' } },
    { id: 'medium', settings: { reasoningEffort: 'medium' } },
    { id: 'high', settings: { reasoningEffort: 'high' } },
    { id: 'xhigh', settings: { reasoningEffort: 'xhigh' } },
    { id: 'max', settings: { reasoningEffort: 'max' } },
  ],
  limit: { context: 262_144, output: 65_536 },
  capabilities: { input: ['text'] },
  enabled: true,
  status: 'active',
};

const WITH_MINIMAL: ApiModel = {
  id: 'reasoning-model',
  providerID: 'opencode',
  name: 'Reasoning Model',
  variants: [{ id: 'none' }, { id: 'minimal' }, { id: 'medium' }],
};

const WITHOUT_VARIANTS: ApiModel = {
  id: 'plain-model',
  providerID: 'opencode',
  name: 'Plain Model',
};

const DISABLED: ApiModel = {
  id: 'disabled-model',
  providerID: 'opencode',
  name: 'Disabled',
  enabled: false,
};

describe('model mapping', () => {
  it('maps a catalog entry to a model reference with its limits and modalities', () => {
    expect(toModelRef(WITH_VARIANTS)).toEqual({
      provider: 'opencode',
      id: 'flint-40b-free',
      name: 'Flint 40B Free',
      contextWindow: 262_144,
      maxTokens: 65_536,
      input: ['text'],
    });
  });

  it('leaves disabled models out of the picker', () => {
    expect(toModelRefs([WITH_VARIANTS, WITHOUT_VARIANTS, DISABLED]).map((model) => model.id)).toEqual([
      'flint-40b-free',
      'plain-model',
    ]);
  });

  it('offers exactly the levels the model declares, in Morse order', () => {
    expect(thinkingLevelsOf(WITH_VARIANTS)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // `none` means off; the unknown ids are not offered.
    expect(thinkingLevelsOf(WITH_MINIMAL)).toEqual(['off', 'minimal', 'medium']);
    expect(thinkingLevelsOf(WITHOUT_VARIANTS)).toEqual([]);
    expect(thinkingLevelsOf(undefined)).toEqual([]);
  });

  it('maps a level back to the variant the model declared', () => {
    expect(variantForLevel(WITH_VARIANTS, 'high')).toBe('high');
    expect(variantForLevel(WITH_MINIMAL, 'off')).toBe('none');
    // A level carried over from another model does not pretend to apply.
    expect(variantForLevel(WITHOUT_VARIANTS, 'high')).toBeUndefined();
    expect(variantForLevel(WITH_VARIANTS, 'minimal')).toBeUndefined();
  });

  it('recognizes the level names and the `none` alias', () => {
    expect(levelOfVariant('medium')).toBe('medium');
    expect(levelOfVariant('none')).toBe('off');
    expect(levelOfVariant('default')).toBeUndefined();
    expect(levelOfVariant(undefined)).toBeUndefined();
  });

  it('keeps a `default`-variant session renderable by falling back to a real level', () => {
    // A fresh session reports variant "default": the picker still gets a level.
    expect(thinkingLevelOf(WITH_VARIANTS, 'default')).toBe('medium');
    expect(thinkingLevelOf(WITH_MINIMAL, 'default')).toBe('medium');
    expect(thinkingLevelOf(WITH_MINIMAL, undefined)).toBe('medium');
    // No variants at all: the only honest answer.
    expect(thinkingLevelOf(WITHOUT_VARIANTS, 'default')).toBe('off');
  });
});
