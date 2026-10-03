import { describe, expect, it } from 'vitest';
import type { ModelOption } from '@morse/protocol';
import { groupModels } from './model-picker';

const MODELS: ModelOption[] = [
  { provider: 'llm-eigen', id: 'deepseek-v4', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000 },
  { provider: 'llm-eigen', id: 'kimi-k2.7', name: 'Kimi K2.7 Code', contextWindow: 262_144 },
  { provider: 'ollama', id: 'deepseek-v4', name: 'DeepSeek V4 Flash', contextWindow: 128_000 },
  { provider: 'ollama', id: 'gemma-3', name: 'Gemma 3 31B', contextWindow: 32_768 },
];

/** Provider grouping is what tells two same-named models apart. */
describe('groupModels', () => {
  it('groups by provider in first-seen order', () => {
    expect(groupModels(MODELS, '').map((group) => group.provider)).toEqual(['llm-eigen', 'ollama']);
  });

  it('keeps two same-named models under their own providers', () => {
    const groups = groupModels(MODELS, 'v4 flash');
    expect(groups.map((group) => group.provider)).toEqual(['llm-eigen', 'ollama']);
    expect(groups[0].models).toHaveLength(1);
    expect(groups[1].models).toHaveLength(1);
  });

  it('matches the provider name too, so a provider lists all its models', () => {
    const groups = groupModels(MODELS, 'ollama');
    expect(groups).toEqual([{ provider: 'ollama', models: [MODELS[2], MODELS[3]] }]);
  });

  it('matches a fragment of the model id', () => {
    expect(groupModels(MODELS, 'kimi').flatMap((group) => group.models.map((model) => model.id))).toEqual([
      'kimi-k2.7',
    ]);
  });

  it('is empty when nothing matches', () => {
    expect(groupModels(MODELS, 'zzz')).toEqual([]);
  });
});
