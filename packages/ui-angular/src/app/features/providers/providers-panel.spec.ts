import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStatus } from '@morse/protocol';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { MorseService } from '../../host/morse.service';
import { ProvidersPanel } from './providers-panel';

const status: ProviderStatus = {
  engine: 'pi',
  providers: [
    { id: 'openai', name: 'OpenAI', description: 'GPT models', kind: 'builtin', connected: true, source: 'stored' },
    { id: 'opencode-go', name: 'OpenCode Go', description: '2 models in pi’s catalog', kind: 'builtin', connected: false, auth: { key: true, signIn: true } },
    { id: 'my-gateway', name: 'My gateway', description: 'Custom endpoint', kind: 'custom', connected: true, source: 'config', baseURL: 'https://example.com/v1', api: 'openai-completions', models: [{ id: 'gpt-5' }] },
  ],
  issues: [],
};

async function render(): Promise<{ fixture: ComponentFixture<ProvidersPanel>; host: HTMLElement; morse: MorseService }> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [ProvidersPanel],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
  }).compileComponents();
  const morse = TestBed.inject(MorseService);
  vi.spyOn(morse, 'requestHostCommand').mockImplementation(async (name) =>
    name === 'providerStatus' ? status : { ok: true, message: 'Saved.' },
  );
  const fixture = TestBed.createComponent(ProvidersPanel);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, morse };
}

async function openCard(
  fixture: ComponentFixture<ProvidersPanel>,
  host: HTMLElement,
  name: string,
): Promise<void> {
  const card = [...host.querySelectorAll('button.card')].find((one) =>
    one.textContent?.includes(name),
  ) as HTMLButtonElement;
  card.click();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('ProvidersPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists the providers the engine reported', async () => {
    const { host, morse } = await render();
    expect(morse.requestHostCommand).toHaveBeenCalledWith('providerStatus', { engine: expect.any(String) });
    expect(host.textContent).toContain('My gateway');
    expect(host.textContent).toContain('OpenAI');
    expect(host.querySelectorAll('button.card')).toHaveLength(4);
  });

  it('opens the engine sign-in TUI for a well-known provider', async () => {
    const { fixture, host, morse } = await render();
    const command = vi.mocked(morse.requestHostCommand);
    command.mockImplementation(async (name) =>
      name === 'providerStatus'
        ? status
        : name === 'providerLogin'
          ? { ok: true, terminalId: 'provider-test-1' }
          : { ok: true },
    );

    await openCard(fixture, host, 'OpenCode Go');
    const signIn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.trim() === 'Use account sign-in instead',
    ) as HTMLButtonElement;
    signIn.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(command).toHaveBeenCalledWith('providerLogin', {
      engine: expect.any(String),
      providerId: 'opencode-go',
    });
  });

  it('writes a pasted key from the provider detail', async () => {
    const { fixture, host, morse } = await render();
    await openCard(fixture, host, 'OpenCode Go');
    const form = fixture.componentInstance as unknown as {
      formKey: { set(value: string): void };
      saveKey(): Promise<void>;
    };
    form.formKey.set('sk-test');
    await form.saveKey();

    expect(morse.requestHostCommand).toHaveBeenCalledWith(
      'providerConnect',
      expect.objectContaining({ providerId: 'opencode-go', key: 'sk-test' }),
    );
  });

  it('saves a custom endpoint with full model fields', async () => {
    const { fixture, host, morse } = await render();
    (host.querySelector('button.card.custom') as HTMLButtonElement).click();
    fixture.detectChanges();

    const panel = fixture.componentInstance as unknown as {
      formId: { set(value: string): void };
      formName: { set(value: string): void };
      formBaseURL: { set(value: string): void };
      formKey: { set(value: string): void };
      models: { update(fn: (list: unknown[]) => unknown[]): void };
      save(): Promise<void>;
    };
    panel.formId.set('my-new');
    panel.formName.set('New gateway');
    panel.formBaseURL.set('https://llm.example.com/v1');
    panel.formKey.set('sk-abc');
    panel.models.update(() => [{ id: 'model-a', name: 'Model A', context: '100000', output: '8000', input: new Set(['text', 'image']), reasoning: true, min: 'low', max: 'high' }]);
    await panel.save();

    expect(morse.requestHostCommand).toHaveBeenCalledWith(
      'providerConnect',
      expect.objectContaining({
        providerId: 'my-new',
        baseURL: 'https://llm.example.com/v1',
        models: [expect.objectContaining({
          id: 'model-a',
          contextWindow: 100000,
          maxTokens: 8000,
          input: ['text', 'image'],
          reasoning: true,
        })],
        key: 'sk-abc',
      }),
    );
  });

  it('disconnects from the connected provider detail', async () => {
    const { fixture, host, morse } = await render();
    await openCard(fixture, host, 'OpenAI');
    const button = [...host.querySelectorAll('button')].find((one) =>
      one.textContent?.includes('Disconnect OpenAI'),
    ) as HTMLButtonElement;
    button.click();
    await fixture.whenStable();
    expect(morse.requestHostCommand).toHaveBeenCalledWith(
      'providerDisconnect',
      expect.objectContaining({ providerId: 'openai' }),
    );
  });
});
