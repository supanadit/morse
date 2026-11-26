import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderModel } from '@morse/protocol';
import { ModelsTable } from './models-table';

async function render(
  models: ProviderModel[],
): Promise<{ fixture: ComponentFixture<ModelsTable>; host: HTMLElement; emitted: ProviderModel[][] }> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({ imports: [ModelsTable] }).compileComponents();
  const fixture = TestBed.createComponent(ModelsTable);
  const emitted: ProviderModel[][] = [];
  fixture.componentInstance.modelsChange.subscribe((next) => emitted.push(next));
  fixture.componentRef.setInput('models', models);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, emitted };
}

describe('ModelsTable', () => {
  afterEach(() => vi.restoreAllMocks());

  it('toggles capabilities for one model without changing the others', async () => {
    const { fixture, host, emitted } = await render([
      { id: 'a', input: ['text'] },
      { id: 'b', input: ['text'] },
    ]);

    // Open the first row's capabilities popup: with nested `@for` loops the
    // template must pass the model row, not the inner option index.
    const rows = () => [...host.querySelectorAll('tr.model-main')] as HTMLElement[];
    (rows()[0]?.querySelector('.col-caps .menu-trigger') as HTMLButtonElement).click();
    fixture.detectChanges();
    const imageOption = [...host.querySelectorAll('.menu-row')].find((row) =>
      row.textContent?.includes('Vision (images)'),
    ) as HTMLButtonElement;
    imageOption.click();
    fixture.detectChanges();

    const last = emitted.at(-1) ?? [];
    expect(last[0]?.input).toEqual(expect.arrayContaining(['text', 'image']));
    expect(last[1]?.input).toEqual(['text']);
    // Multi-select: the popup stays open for the next pick.
    expect(host.querySelector('.menu')).not.toBeNull();
  });

  it('disables the thinking trigger until reasoning is on', async () => {
    const { fixture, host } = await render([{ id: 'a' }]);
    const think = host.querySelector('.col-think .menu-trigger') as HTMLButtonElement;
    expect(think.disabled).toBe(true);

    // Enabling reasoning unlocks the levels popup at the engine default.
    const caps = host.querySelector('.col-caps .menu-trigger') as HTMLButtonElement;
    caps.click();
    fixture.detectChanges();
    const reasoning = [...host.querySelectorAll('.menu-row')].find(
      (row) => row.textContent?.trim() === 'Reason',
    ) as HTMLButtonElement;
    reasoning.click();
    fixture.detectChanges();
    expect(think.disabled).toBe(false);
    expect(think.title).toContain('Default');
  });

  it('picks non-adjacent thinking levels and resets to default', async () => {
    const { fixture, host, emitted } = await render([{ id: 'a', reasoning: true }]);

    (host.querySelector('.col-think .menu-trigger') as HTMLButtonElement).click();
    fixture.detectChanges();
    const levelOption = (name: string) =>
      [...host.querySelectorAll('.menu-row')].find(
        (row) => row.textContent?.trim() === name,
      ) as HTMLButtonElement;
    levelOption('low').click();
    fixture.detectChanges();
    // Feed the emitted pick back in, as a two-way parent would.
    fixture.componentRef.setInput('models', emitted.at(-1) ?? []);
    fixture.detectChanges();
    levelOption('high').click();
    fixture.detectChanges();

    // No range to satisfy: low and high stay picked without medium.
    const picked = emitted.at(-1) ?? [];
    expect(picked[0]?.thinkingLevels).toEqual(['low', 'high']);
    fixture.componentRef.setInput('models', picked);
    fixture.detectChanges();
    const brains = host.querySelectorAll('.col-think .menu-trigger svg.brain');
    expect(brains).toHaveLength(2);

    (host.querySelector('.menu-reset') as HTMLButtonElement).click();
    fixture.detectChanges();
    const reset = emitted.at(-1) ?? [];
    expect(reset[0]?.thinkingLevels).toBeUndefined();
    expect(reset[0]?.reasoning).toBe(true);
  });
});
