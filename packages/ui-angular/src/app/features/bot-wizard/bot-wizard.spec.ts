import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { BotCreateInput, HostToClientMessage, ModelOption } from '@morse/protocol';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { BotWizard } from './bot-wizard';

const claude: ModelOption = {
  provider: 'anthropic',
  id: 'claude-sonnet-4',
  name: 'Claude Sonnet 4',
};

/** The mock host, able to push a message (a notice) by hand. */
class ScriptedHost extends MemoryHostTransport {
  toClient(message: HostToClientMessage): void {
    this.emitMessage(message);
  }
}

async function render(): Promise<{
  fixture: ComponentFixture<BotWizard>;
  host: HTMLElement;
  morse: MorseService;
  transport: ScriptedHost;
}> {
  TestBed.resetTestingModule();
  const transport = new ScriptedHost();
  await TestBed.configureTestingModule({
    imports: [BotWizard],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(BotWizard);
  fixture.detectChanges();
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    morse: TestBed.inject(MorseService),
    transport,
  };
}

function button(host: HTMLElement, selector: string): HTMLButtonElement {
  const found = host.querySelector(selector) as HTMLButtonElement | null;
  if (found === null) {
    throw new Error(`no button matches ${selector}`);
  }
  return found;
}

function buttonOrNull(host: HTMLElement, selector: string): HTMLButtonElement | null {
  return host.querySelector(selector) as HTMLButtonElement | null;
}

/** The wizard's active step, per the rail's aria-current marker. */
function currentStep(host: HTMLElement): string | null | undefined {
  return host.querySelector('.wizard-step[aria-current="step"]')?.textContent?.trim();
}

function fill(host: HTMLElement, selector: string, value: string): void {
  const field = host.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  field.value = value;
  field.dispatchEvent(new Event('input'));
}

function choose(host: HTMLElement, selector: string, value: string): void {
  const field = host.querySelector(selector) as HTMLSelectElement;
  field.value = value;
  field.dispatchEvent(new Event('change'));
}

function tick(fixture: ComponentFixture<BotWizard>): void {
  fixture.detectChanges();
}

/** Identity → engine → connect, stopping on Connect. */
function walkToConnect(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  kind: string,
): void {
  fill(host, 'input[placeholder="Forge"]', 'Forge');
  fill(host, 'input[placeholder="Builds things"]', 'Keeps the forge hot');
  tick(fixture);
  button(host, '.wizard-foot .primary').click();
  tick(fixture);
  expect(currentStep(host)).toBe('Engine');
  const engineButtons = [...host.querySelectorAll('.choice')] as HTMLButtonElement[];
  const match = engineButtons.find((one) => one.textContent?.toLowerCase().includes(kind));
  match?.click();
  tick(fixture);
  button(host, '.wizard-foot .primary').click();
  tick(fixture);
  expect(currentStep(host)).toBe('Connect');
}

/** Connect → Persona → Advanced → Review, when the test already left Connect. */
function finishFromConnect(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  options: { persona?: string; agentsMd?: string; subagent?: boolean } = {},
): void {
  button(host, '.wizard-foot .primary').click();
  tick(fixture);
  fill(host, 'textarea[placeholder^="You are Forge"]', options.persona ?? 'You are Forge.');
  tick(fixture);
  button(host, '.wizard-foot .primary').click();
  tick(fixture);
  if (options.agentsMd !== undefined) {
    fill(host, 'textarea[placeholder="# Forge workspace"]', options.agentsMd);
    tick(fixture);
  }
  if (options.subagent === true) {
    button(host, '.ghost').click();
    tick(fixture);
    fill(host, '.subagent input', 'reviewer');
    fill(host, '.subagent textarea', 'Read the diff and report risks.');
    tick(fixture);
  }
  button(host, '.wizard-foot .primary').click();
  tick(fixture);
  expect(currentStep(host)).toBe('Review');
}

/** The whole walk, from Identity. */
function walkToReview(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  kind: string,
  options: { persona?: string; agentsMd?: string; subagent?: boolean } = {},
): void {
  walkToConnect(fixture, host, kind);
  finishFromConnect(fixture, host, options);
}

describe('BotWizard', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('walks identity → engine → connect and probes only on leaving Connect', async () => {
    const { fixture, host, morse } = await render();

    expect(currentStep(host)).toBe('Identity');
    expect(button(host, '.wizard-foot .primary').disabled).toBe(true);

    fill(host, 'input[placeholder="Forge"]', 'Forge');
    tick(fixture);
    expect(button(host, '.wizard-foot .primary').disabled).toBe(false);

    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    expect(currentStep(host)).toBe('Engine');
    const names = [...host.querySelectorAll('.choice .choice-name')].map((one) =>
      one.textContent?.trim(),
    );
    expect(names.map((name) => name?.toLowerCase())).toEqual(['pi', 'opencode']);

    const probe = vi.spyOn(morse, 'probeModels');
    const engineButtons = [...host.querySelectorAll('.choice')] as HTMLButtonElement[];
    engineButtons.find((one) => one.textContent?.toLowerCase().includes('pi'))?.click();
    tick(fixture);
    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    expect(currentStep(host)).toBe('Connect');
    expect(probe).not.toHaveBeenCalled();

    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    // No keys collected, so nothing was probed — the engine default applies.
    expect(probe).not.toHaveBeenCalled();
  });

  it('probes the catalog with the pasted key and lists the models inline', async () => {
    const { fixture, host, morse } = await render();
    walkToConnect(fixture, host, 'opencode');

    // Pick the OpenCode preset chip and paste a key; leaving Connect probes.
    const chips = [...host.querySelectorAll('.preset-chip')] as HTMLButtonElement[];
    chips.find((one) => one.textContent?.includes('OpenCode'))?.click();
    tick(fixture);
    fill(host, '.preset-key', 'oc_sk_test');
    tick(fixture);

    const probe = vi.spyOn(morse, 'probeModels');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0]).toBe('opencode');
    expect(probe.mock.calls[0]?.[2]).toEqual([{ provider: 'opencode', apiKey: 'oc_sk_test' }]);

    // The host answers under this wizard's request id.
    const requestId = probe.mock.calls[0]?.[3] ?? '';
    expect(host.querySelector('.model-list')).toBeNull();
    morse.bot.onModels({ requestId, kind: 'opencode', models: [claude] });
    // Back to Connect to see the answer (the wizard advanced past it).
    button(host, '.wizard-foot .secondary').click();
    tick(fixture);
    expect(currentStep(host)).toBe('Connect');
    const options = [...host.querySelectorAll('.model-option')];
    expect(options.map((one) => one.textContent?.trim())).toContain('Claude Sonnet 4anthropic');

    // A foreign answer does not unlock anything: it is not this wizard's list.
    morse.bot.onModels({
      requestId: 'somebody-else',
      kind: 'opencode',
      models: [{ provider: 'other', id: 'x', name: 'Other X' }],
    });
    tick(fixture);
    expect(host.textContent).not.toContain('Other X');
  });

  it('adds a custom provider, discovers its models over HTTP, and saves it', async () => {
    const { fixture, host, morse } = await render();
    walkToConnect(fixture, host, 'pi');

    button(host, '.ghost').click();
    tick(fixture);
    fill(host, 'input[placeholder="acme"]', 'acme');
    fill(host, 'input[placeholder="Acme AI"]', 'Acme AI');
    fill(host, 'input[placeholder="https://api.example.com/v1"]', 'https://llm.acme.example/v1');
    choose(host, 'select', 'openai-completions');
    fill(host, '.draft .field input[type="password"]', 'sk-acme');
    tick(fixture);

    const discover = vi.spyOn(morse, 'discoverModels');
    button(host, '.draft-discover .ghost').click();
    tick(fixture);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0]?.[0]).toBe('https://llm.acme.example/v1');
    const requestId = discover.mock.calls[0]?.[2] ?? '';

    morse.bot.onModels({
      requestId,
      kind: 'discover',
      models: [
        { provider: 'discover', id: 'qwen3-coder', name: 'Qwen 3 Coder' },
        { provider: 'discover', id: 'qwen3-32b', name: 'Qwen 3 32B' },
      ],
    });
    tick(fixture);
    expect(host.querySelector('.ok')?.textContent).toContain('2 models discovered');

    // A hand-added row is always possible too.
    fill(host, 'input[placeholder="model-id"]', 'acme-chat');
    button(host, '.model-add .ghost').click();
    tick(fixture);
    expect(host.textContent).toContain('acme-chat');

    button(host, '.draft-actions .primary').click();
    tick(fixture);
    expect(host.querySelector('.provider-card')?.textContent).toContain('Acme AI');

    // The saved provider is part of the create payload.
    finishFromConnect(fixture, host);
    const create = vi.spyOn(morse, 'createBot');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    const submitted = create.mock.calls[0]?.[0] as BotCreateInput & { requestId: string };
    expect(submitted.providers).toEqual([
      {
        id: 'acme',
        label: 'Acme AI',
        api: 'openai-completions',
        baseUrl: 'https://llm.acme.example/v1',
        credential: { kind: 'stored', apiKey: 'sk-acme' },
        models: [
          { id: 'qwen3-coder', name: 'Qwen 3 Coder' },
          { id: 'qwen3-32b', name: 'Qwen 3 32B' },
          { id: 'acme-chat' },
        ],
      },
    ]);
  });

  it('shows the subagent editor for opencode only', async () => {
    const pi = await render();
    walkToReview(pi.fixture, pi.host, 'pi');
    expect(pi.host.textContent).not.toContain('Subagents');

    const opencode = await render();
    walkToReview(opencode.fixture, opencode.host, 'opencode');
    const back = button(opencode.host, '.wizard-foot .secondary');
    back.click();
    tick(opencode.fixture);
    expect(currentStep(opencode.host)).toBe('Advanced');
    expect(opencode.host.textContent).toContain('Subagents');
    button(opencode.host, '.ghost').click();
    tick(opencode.fixture);
    const nameInput = opencode.host.querySelector('.subagent input') as HTMLInputElement;
    expect(nameInput.pattern).toBe('[\\p{L}\\p{N}_][\\p{L}\\p{N}_\\-]*');
  });

  it('assembles the exact BotCreateInput on submit, then waits for the roster', async () => {
    const { fixture, host, morse } = await render();
    walkToConnect(fixture, host, 'opencode');

    const chips = [...host.querySelectorAll('.preset-chip')] as HTMLButtonElement[];
    chips.find((one) => one.textContent?.includes('Anthropic'))?.click();
    tick(fixture);
    fill(host, '.preset-key', 'sk-ant-123');
    tick(fixture);
    const probe = vi.spyOn(morse, 'probeModels');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    const requestId = probe.mock.calls[0]?.[3] ?? '';
    morse.bot.onModels({ requestId, kind: 'opencode', models: [claude] });
    tick(fixture);
    button(host, '.wizard-foot .secondary').click();
    tick(fixture);
    expect(currentStep(host)).toBe('Connect');
    button(host, '.model-option').click();
    tick(fixture);
    choose(host, '.wizard-content select', 'high');
    tick(fixture);

    finishFromConnect(fixture, host, {
      persona: 'You are Forge, the builder.',
      agentsMd: '# Forge workspace\n',
      subagent: true,
    });
    expect(host.querySelector('.review')?.textContent).toContain('reviewer');

    const create = vi.spyOn(morse, 'createBot');
    const list = vi.spyOn(morse, 'listBots');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);

    const expected: BotCreateInput & { requestId: string } = {
      name: 'Forge',
      description: 'Keeps the forge hot',
      engineKind: 'opencode',
      credentials: [{ provider: 'anthropic', apiKey: 'sk-ant-123' }],
      envVars: [],
      persona: 'You are Forge, the builder.',
      model: claude,
      thinkingLevel: 'high',
      agentsMd: '# Forge workspace',
      subagents: [{ name: 'reviewer', prompt: 'Read the diff and report risks.' }],
      requestId,
    };
    expect(create).toHaveBeenCalledWith(expected);
    expect(list).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.note')?.textContent).toContain('Creating Forge');
    expect(host.textContent).not.toContain('## Subagents');
  });

  it('closes once the roster names the bot it created', async () => {
    const { fixture, host, morse } = await render();
    morse.ui.wizardOpen.set(true);
    walkToReview(fixture, host, 'pi');
    const create = vi.spyOn(morse, 'createBot');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    const submitted = create.mock.calls[0]?.[0] as BotCreateInput;
    expect(submitted).not.toHaveProperty('thinkingLevel');

    morse.bot.onRoster({
      bots: [{ name: 'Sable', description: 'Elsewhere', engineKind: 'pi', warm: false }],
      conversations: [],
    });
    tick(fixture);
    expect(morse.ui.wizardOpen()).toBe(true);

    morse.bot.onRoster({
      bots: [
        { name: 'Sable', description: 'Elsewhere', engineKind: 'pi', warm: false },
        { name: 'Forge', description: 'Keeps the forge hot', engineKind: 'pi', warm: false },
      ],
      conversations: [],
    });
    tick(fixture);
    expect(morse.ui.wizardOpen()).toBe(false);
  });

  it('clears the pending create and shows the notice when the host refuses it', async () => {
    const { fixture, host, morse, transport } = await render();
    morse.ui.wizardOpen.set(true);
    walkToReview(fixture, host, 'pi');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    expect(host.textContent).toContain('Creating Forge');

    transport.toClient({
      type: 'notice',
      payload: { level: 'error', text: 'The host has no bot engine "nope".', at: Date.now() },
    });
    tick(fixture);

    expect(host.textContent).not.toContain('Creating Forge');
    expect(host.querySelector('.error')?.textContent).toContain('no bot engine');
    expect(morse.ui.wizardOpen()).toBe(true);
    expect(button(host, '.wizard-foot .primary').disabled).toBe(false);
  });

  it('closes without creating anything when cancelled', async () => {
    const { fixture, host, morse } = await render();
    morse.ui.wizardOpen.set(true);
    const create = vi.spyOn(morse, 'createBot');

    buttonOrNull(host, '.wizard-close')?.click();
    tick(fixture);

    expect(create).not.toHaveBeenCalled();
    expect(morse.ui.wizardOpen()).toBe(false);
  });
});
