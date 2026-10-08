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

  /** One badge per modality, and each names itself in its tooltip. */
  it('badges each row with the modalities pi reported', () => {
    const host = create();
    const rows = host.querySelectorAll('.row');

    expect(rows[0]?.querySelectorAll('.details .badge')).toHaveLength(1);
    expect(rows[1]?.querySelectorAll('.details .badge')).toHaveLength(2);
    expect(rows[1]?.querySelector('.badge[data-modality="image"]')?.getAttribute('title')).toBe(
      'Vision (images)',
    );
  });

  /**
   * Two lines per model: the name (and the selected check) on top, the
   * modalities and context size below. This is what keeps a row from reading as
   * a jumble when a long name meets several badges and a token count.
   */
  it('puts the name and its check on the first line, the badges and context below', () => {
    const host = create('ollama/sees-images');
    const selected = host.querySelectorAll('.row')[1] as HTMLElement;

    const title = selected.querySelector('.title') as HTMLElement;
    expect(title.querySelector('.name')?.textContent?.trim()).toBe('Sees Images');
    expect(title.querySelector('.check')).not.toBeNull();
    expect(title.querySelector('.badge')).toBeNull();

    const details = selected.querySelector('.details') as HTMLElement;
    expect(details.querySelector('.badge[data-modality="text"]')).not.toBeNull();
    expect(details.querySelector('.badge[data-modality="image"]')).not.toBeNull();
    expect(details.querySelector('.meta')?.textContent?.trim()).toBe('128k');
  });
});
