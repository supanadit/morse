import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { BotCreateInput, ModelOption } from '@morse/protocol';
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

async function render(): Promise<{
  fixture: ComponentFixture<BotWizard>;
  host: HTMLElement;
  morse: MorseService;
}> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [BotWizard],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
  }).compileComponents();
  const fixture = TestBed.createComponent(BotWizard);
  fixture.detectChanges();
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    morse: TestBed.inject(MorseService),
  };
}

function button(host: HTMLElement, selector: string): HTMLButtonElement {
  return host.querySelector(selector) as HTMLButtonElement;
}

function currentStep(host: HTMLElement): string | null | undefined {
  return host.querySelector('.step.current')?.getAttribute('data-step');
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

/**
 * Walks the wizard up to the model step, answering the probe the way the host
 * does. Returns the request id the wizard probed under.
 */
function walkToModelStep(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  morse: MorseService,
  kind: string,
): string {
  fill(host, 'input[name="name"]', 'Forge');
  fill(host, 'input[name="description"]', 'Keeps the forge hot');
  tick(fixture);
  button(host, '.next').click();
  tick(fixture);
  expect(currentStep(host)).toBe('engine');
  button(host, `.engine-option[data-kind="${kind}"]`).click();
  tick(fixture);
  button(host, '.next').click();
  tick(fixture);
  expect(currentStep(host)).toBe('credentials');

  const probe = vi.spyOn(morse, 'probeModels');
  button(host, '.next').click();
  tick(fixture);
  expect(currentStep(host)).toBe('model');
  expect(probe).toHaveBeenCalledTimes(1);
  const requestId = probe.mock.calls[0]?.[2] ?? '';
  return requestId;
}

describe('BotWizard', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('walks identity → engine → credentials → model, probing only after credentials', async () => {
    const { fixture, host, morse } = await render();

    expect(currentStep(host)).toBe('identity');
    expect(button(host, '.next').disabled).toBe(true);

    fill(host, 'input[name="name"]', 'Forge');
    tick(fixture);
    expect(button(host, '.next').disabled).toBe(false);

    // Engines come from the host, with its own labels.
    button(host, '.next').click();
    tick(fixture);
    expect(currentStep(host)).toBe('engine');
    const kinds = [...host.querySelectorAll('.engine-option')].map((one) =>
      one.getAttribute('data-kind'),
    );
    expect(kinds).toEqual(['pi', 'opencode']);

    const probe = vi.spyOn(morse, 'probeModels');
    button(host, '.engine-option[data-kind="pi"]').click();
    tick(fixture);
    button(host, '.next').click();
    tick(fixture);
    expect(currentStep(host)).toBe('credentials');
    // The point of the order: nothing was probed before the credentials step.
    expect(probe).not.toHaveBeenCalled();

    button(host, '.next').click();
    tick(fixture);
    expect(currentStep(host)).toBe('model');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0]).toBe('pi');
  });

  it('keeps the model list disabled until the answer for its own request arrives', async () => {
    const { fixture, host, morse } = await render();
    const requestId = walkToModelStep(fixture, host, morse, 'pi');

    const model = host.querySelector('select[name="model"]') as HTMLSelectElement;
    expect(model.disabled).toBe(true);
    expect(button(host, '.next').disabled).toBe(true);

    // Another wizard's answer must not unlock this step.
    morse.bot.onModels({ requestId: 'somebody-else', kind: 'pi', models: [claude] });
    tick(fixture);
    expect(model.disabled).toBe(true);

    morse.bot.onModels({ requestId, kind: 'pi', models: [claude] });
    tick(fixture);
    expect(model.disabled).toBe(false);
    expect(model.options.length).toBe(2);
    expect(model.textContent).toContain('Claude Sonnet 4');
  });

  it('says so when the engine returns no models, instead of an empty picker', async () => {
    const { fixture, host, morse } = await render();
    const requestId = walkToModelStep(fixture, host, morse, 'pi');
    expect(host.querySelector('.models-empty')).toBeNull();

    // A probe can answer with nothing (a key the engine accepts no model for).
    morse.bot.onModels({ requestId, kind: 'pi', models: [] });
    tick(fixture);

    const note = host.querySelector('.models-empty') as HTMLElement;
    expect(note.textContent).toContain('no models');
    // A dead end: the step stays shut rather than showing an empty list.
    expect((host.querySelector('select[name="model"]') as HTMLSelectElement).disabled).toBe(true);
    expect(button(host, '.next').disabled).toBe(true);
  });

  it('shows the subagent editor for opencode only, and skips it for pi', async () => {
    const pi = await render();
    const piRequest = walkToModelStep(pi.fixture, pi.host, pi.morse, 'pi');
    pi.morse.bot.onModels({ requestId: piRequest, kind: 'pi', models: [claude] });
    tick(pi.fixture);
    choose(pi.host, 'select[name="model"]', 'anthropic/claude-sonnet-4');
    tick(pi.fixture);
    button(pi.host, '.next').click();
    tick(pi.fixture);
    expect(currentStep(pi.host)).toBe('persona');
    button(pi.host, '.next').click();
    tick(pi.fixture);
    expect(currentStep(pi.host)).toBe('agentsMd');
    button(pi.host, '.next').click();
    tick(pi.fixture);
    // pi has no subagents: the step is not in the wizard at all.
    expect(currentStep(pi.host)).toBe('review');
    expect(pi.host.querySelector('.step[data-step="subagents"]')).toBeNull();

    const opencode = await render();
    const opencodeRequest = walkToModelStep(
      opencode.fixture,
      opencode.host,
      opencode.morse,
      'opencode',
    );
    opencode.morse.bot.onModels({ requestId: opencodeRequest, kind: 'opencode', models: [claude] });
    tick(opencode.fixture);
    choose(opencode.host, 'select[name="model"]', 'anthropic/claude-sonnet-4');
    tick(opencode.fixture);
    button(opencode.host, '.next').click();
    tick(opencode.fixture);
    button(opencode.host, '.next').click();
    tick(opencode.fixture);
    button(opencode.host, '.next').click();
    tick(opencode.fixture);
    expect(currentStep(opencode.host)).toBe('subagents');
    expect(opencode.host.querySelector('.subagent-row')).toBeNull();
    button(opencode.host, '.add-subagent').click();
    tick(opencode.fixture);
    expect(opencode.host.querySelectorAll('.subagent-row')).toHaveLength(1);
    button(opencode.host, '.remove-subagent').click();
    tick(opencode.fixture);
    expect(opencode.host.querySelector('.subagent-row')).toBeNull();
  });

  it('assembles the exact BotCreateInput on submit, then asks for the roster', async () => {
    const { fixture, host, morse } = await render();
    const requestId = walkToModelStep(fixture, host, morse, 'opencode');

    // Credentials: one stored key and one inherited env var. Going back to the
    // credentials step keeps whatever this wizard already collected.
    button(host, '.back').click();
    tick(fixture);
    button(host, '.add-credential').click();
    tick(fixture);
    fill(host, 'input[name="provider"]', 'anthropic');
    fill(host, 'input[name="apiKey"]', 'sk-ant-123');
    fill(host, 'input[name="envVars"]', 'ANTHROPIC_API_KEY, OPENAI_API_KEY');
    tick(fixture);
    button(host, '.next').click();
    tick(fixture);
    expect(currentStep(host)).toBe('model');

    // The new probe's request is the one this visit waits on.
    const secondRequest = vi.mocked(morse.probeModels).mock.calls.at(-1)?.[2] ?? '';
    morse.bot.onModels({ requestId: secondRequest, kind: 'opencode', models: [claude] });
    tick(fixture);
    choose(host, 'select[name="model"]', 'anthropic/claude-sonnet-4');
    choose(host, 'select[name="thinking"]', 'high');
    tick(fixture);
    button(host, '.next').click();
    tick(fixture);
    expect(currentStep(host)).toBe('persona');
    fill(host, 'textarea[name="persona"]', 'You are Forge, the builder.');
    tick(fixture);
    button(host, '.next').click();
    tick(fixture);
    expect(currentStep(host)).toBe('agentsMd');
    fill(host, 'textarea[name="agentsMd"]', '# Forge workspace\n');
    tick(fixture);
    button(host, '.next').click();
    tick(fixture);
    expect(currentStep(host)).toBe('subagents');
    button(host, '.add-subagent').click();
    tick(fixture);
    fill(host, 'input[name="subagentName"]', 'reviewer');
    fill(host, 'textarea[name="subagentPrompt"]', 'Read the diff and report risks.');
    tick(fixture);
    button(host, '.next').click();
    tick(fixture);
    expect(currentStep(host)).toBe('review');
    // The review step shows what the host will write: AGENTS.md untouched, and
    // the subagent names the rows will send.
    expect(host.querySelector('.agents-preview')?.textContent).toBe('# Forge workspace');
    expect(host.querySelector('.subagents-preview')?.textContent).toContain('reviewer');
    // The rows are engine config now, not prose folded into the document.
    expect(host.textContent).not.toContain('## Subagents');

    const create = vi.spyOn(morse, 'createBot');
    const list = vi.spyOn(morse, 'listBots');
    button(host, '.create').click();
    tick(fixture);

    const expected: BotCreateInput & { requestId: string } = {
      name: 'Forge',
      description: 'Keeps the forge hot',
      engineKind: 'opencode',
      credentials: [{ provider: 'anthropic', apiKey: 'sk-ant-123' }],
      envVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
      persona: 'You are Forge, the builder.',
      model: claude,
      thinkingLevel: 'high',
      agentsMd: '# Forge workspace',
      subagents: [{ name: 'reviewer', prompt: 'Read the diff and report risks.' }],
      requestId: secondRequest,
    };
    expect(create).toHaveBeenCalledWith(expected);
    expect(list).toHaveBeenCalledTimes(1);
    // No `requestId` echo exists in `bot/roster`, so the wizard waits for the
    // roster to name the bot instead of guessing it was created.
    expect(host.querySelector('.pending')?.textContent).toContain('Forge');
    expect(requestId).not.toBe(secondRequest);
  });

  it('closes once the roster names the bot it created', async () => {
    const { fixture, host, morse } = await render();
    morse.ui.wizardOpen.set(true);
    const create = vi.spyOn(morse, 'createBot');
    const requestId = walkToModelStep(fixture, host, morse, 'pi');
    morse.bot.onModels({ requestId, kind: 'pi', models: [claude] });
    tick(fixture);
    choose(host, 'select[name="model"]', 'anthropic/claude-sonnet-4');
    tick(fixture);
    button(host, '.next').click();
    tick(fixture);
    fill(host, 'textarea[name="persona"]', 'You are Forge.');
    tick(fixture);
    button(host, '.next').click();
    tick(fixture);
    button(host, '.next').click();
    tick(fixture);
    button(host, '.create').click();
    tick(fixture);
    // A pi bot carries no subagent rows and no workspace document it never
    // collected: the engine has no place for either.
    const submitted = create.mock.calls[0]?.[0];
    expect(submitted).not.toHaveProperty('subagents');
    expect(submitted).not.toHaveProperty('agentsMd');
    expect(morse.ui.wizardOpen()).toBe(true);

    // A roster that does not name it is another bot's push, not our answer.
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

  it('closes without creating anything when cancelled', async () => {
    const { fixture, host, morse } = await render();
    morse.ui.wizardOpen.set(true);
    const create = vi.spyOn(morse, 'createBot');

    button(host, '.cancel').click();
    fixture.detectChanges();

    expect(create).not.toHaveBeenCalled();
    expect(morse.ui.wizardOpen()).toBe(false);
  });
});
