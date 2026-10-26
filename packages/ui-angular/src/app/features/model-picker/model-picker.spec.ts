import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ModelOption } from '@morse/protocol';
import { ModelPicker, groupModels } from './model-picker';

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

  it('matches a modality, so “vision” finds the image models', () => {
    const withInput: ModelOption[] = [
      { provider: 'ollama', id: 'text-only', name: 'Text Only', input: ['text'] },
      {
        provider: 'ollama',
        id: 'sees-images',
        name: 'Sees Images',
        input: ['text', 'image'],
      },
    ];
    const groups = groupModels(withInput, 'vision');
    expect(groups.flatMap((group) => group.models.map((model) => model.id))).toEqual(['sees-images']);
  });

  it('is empty when nothing matches', () => {
    expect(groupModels(MODELS, 'zzz')).toEqual([]);
  });
});

describe('ModelPicker', () => {
  const CATALOG: ModelOption[] = [
    { provider: 'ollama', id: 'text-only', name: 'Text Only', contextWindow: 32_768, input: ['text'] },
    {
      provider: 'ollama',
      id: 'sees-images',
      name: 'Sees Images',
      contextWindow: 128_000,
      input: ['text', 'image'],
    },
  ];

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ModelPicker] });
  });

  function create(current = ''): HTMLElement {
    const fixture = TestBed.createComponent(ModelPicker);
    fixture.componentRef.setInput('models', CATALOG);
    fixture.componentRef.setInput('current', current);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  /** Words beat glyphs in a listing: TEXT and IMAGE read at 9.5px, an icon did not. */
  it('tags each row with the modalities pi reported', () => {
    const host = create();
    const rows = host.querySelectorAll('.row');

    const tagsOf = (row: Element | undefined): (string | null | undefined)[] =>
      [...(row?.querySelectorAll('.tag') ?? [])].map((tag) => tag.textContent?.trim());

    expect(tagsOf(rows[0])).toEqual(['text']);
    expect(tagsOf(rows[1])).toEqual(['text', 'image']);
  });

  /** One line per model: name, tags, the context size and — when picked — the check. */
  it('keeps the name, tags, context and selected check on one line', () => {
    const host = create('ollama/sees-images');
    const rows = host.querySelectorAll('.row');

    expect(rows[0]?.querySelector('.name')?.textContent?.trim()).toBe('Text Only');
    expect(rows[0]?.querySelector('.meta')?.textContent?.trim()).toBe('33k');
    expect(rows[0]?.querySelector('.check')).toBeNull();

    const selected = rows[1] as HTMLElement;
    expect(selected.querySelector('.name')?.textContent?.trim()).toBe('Sees Images');
    expect(selected.querySelector('.meta')?.textContent?.trim()).toBe('128k');
    expect(selected.querySelector('.check')).not.toBeNull();
  });
});
