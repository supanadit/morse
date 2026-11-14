import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type {
  BotCreateInput,
  BotMcpServerInput,
  BotSummary,
  HostToClientMessage,
  ModelOption,
} from '@morse/protocol';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { BotWizard } from './bot-wizard';

const forge: BotSummary = {
  username: 'forge',
  name: 'Forge',
  description: 'Keeps the forge hot',
  engineKind: 'pi',
  warm: false,
};

const claude: ModelOption = {
  provider: 'anthropic',
  id: 'claude-sonnet-4',
  name: 'Claude Sonnet 4',
};

/** One stdio server, as both a create sends it and an edit reads it back. */
const filesystemServer: BotMcpServerInput = {
  name: 'filesystem',
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'server', '.'],
  enabled: true,
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

/** The same, for a field the test already holds (a cell in a table of rows). */
function type(field: HTMLInputElement, value: string): void {
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

/** The spy shape the walk helpers pass around: the probe's own arguments. */
interface ProbeSpy {
  mock: { calls: [string, string[], { provider: string; apiKey: string }[], string][] };
}

/** Identity → engine → connect, stopping on Connect with the catalog answered. */
function walkToConnect(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  morse: MorseService,
  kind: string,
): { probe: ProbeSpy } {
  const probe = vi.spyOn(morse, 'probeModels');
  fill(host, 'input[placeholder="News Finder"]', 'Forge');
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
  return { probe };
}

/** Answers the catalog probe the wizard already sent, then picks the first model. */
function pickCatalogModel(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  morse: MorseService,
  probe: ProbeSpy,
  model: ModelOption = claude,
): void {
  morse.bot.onModels({
    requestId: probe.mock.calls.at(-1)?.[3] ?? '',
    kind: 'opencode',
    models: [model],
  });
  tick(fixture);
  button(host, '.model-option').click();
  tick(fixture);
}

/**
 * Connect → Persona → MCP → Advanced → Review, when the test already left
 * Connect. The MCP step is optional: only a walk that asks adds a server there.
 */
function finishFromConnect(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  options: { persona?: string; mcp?: boolean; agentsMd?: string; subagent?: boolean } = {},
): void {
  button(host, '.wizard-foot .primary').click();
  tick(fixture);
  fill(host, 'textarea[placeholder^="You are Forge"]', options.persona ?? 'You are Forge.');
  tick(fixture);
  button(host, '.wizard-foot .primary').click();
  tick(fixture);
  expect(currentStep(host)).toBe('MCP');
  if (options.mcp === true) {
    fill(host, 'input[placeholder="filesystem"]', 'filesystem');
    fill(host, 'input[placeholder="npx"]', 'npx');
    fill(host, 'input[placeholder="-y @modelcontextprotocol/server-filesystem ."]', '-y server .');
    button(host, '.mcp-add').click();
    tick(fixture);
  }
  button(host, '.wizard-foot .primary').click();
  tick(fixture);
  expect(currentStep(host)).toBe('Advanced');
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

/** Connect → Persona, stopping on the MCP step so a test can build its list. */
function walkToMcp(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  options: { persona?: string } = {},
): void {
  button(host, '.wizard-foot .primary').click();
  tick(fixture);
  fill(host, 'textarea[placeholder^="You are Forge"]', options.persona ?? 'You are Forge.');
  tick(fixture);
  button(host, '.wizard-foot .primary').click();
  tick(fixture);
  expect(currentStep(host)).toBe('MCP');
}

/** Fill a field the way a browser does on blur: input, then change. */
function fillAndCommit(host: HTMLElement, selector: string, value: string): void {
  const field = host.querySelector(selector) as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new Event('input'));
  field.dispatchEvent(new Event('change'));
}

/** The whole walk, from Identity. */
function walkToReview(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  morse: MorseService,
  kind: string,
  options: { persona?: string; mcp?: boolean; agentsMd?: string; subagent?: boolean } = {},
): void {
  const { probe } = walkToConnect(fixture, host, morse, kind);
  pickCatalogModel(fixture, host, morse, probe);
  finishFromConnect(fixture, host, options);
}

describe('BotWizard', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('probes the catalog on arriving at Connect and holds Next until a model is picked', async () => {
    const { fixture, host, morse } = await render();

    expect(currentStep(host)).toBe('Identity');
    expect(button(host, '.wizard-foot .primary').disabled).toBe(true);

    fill(host, 'input[placeholder="News Finder"]', 'Forge');
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

    // The step asks the catalog itself: nothing has to be walked past first.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0]).toBe('pi');
    expect(probe.mock.calls[0]?.[2]).toEqual([]);

    // No model, no next step — a bot cannot fall back to a default model.
    expect(button(host, '.wizard-foot .primary').disabled).toBe(true);
    expect(host.querySelector('.wizard-content')?.textContent).toContain('Loading');

    // The answer lands and the list is right there on the same step.
    const requestId = probe.mock.calls[0]?.[3] ?? '';
    morse.bot.onModels({ requestId, kind: 'pi', models: [claude] });
    tick(fixture);
    expect(host.querySelector('.model-list')).not.toBeNull();
    expect(host.querySelector('.wizard-content')?.textContent).toContain('Pick a model');
    expect(button(host, '.wizard-foot .primary').disabled).toBe(true);

    button(host, '.model-option').click();
    tick(fixture);
    expect(button(host, '.wizard-foot .primary').disabled).toBe(false);
  });

  it('re-probes when a key is committed and keeps Next refused while nothing is listed', async () => {
    const { fixture, host, morse } = await render();
    const { probe } = walkToConnect(fixture, host, morse, 'opencode');

    // The arrival probe ran with no keys and listed nothing.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[2]).toEqual([]);
    morse.bot.onModels({ requestId: probe.mock.calls[0]?.[3] ?? '', kind: 'opencode', models: [] });
    tick(fixture);
    expect(host.querySelector('.wizard-content')?.textContent).toContain('listed no models');
    expect(button(host, '.wizard-foot .primary').disabled).toBe(true);

    // Pick the OpenCode preset chip, paste a key and commit it (blur).
    const chips = [...host.querySelectorAll('.preset-chip')] as HTMLButtonElement[];
    chips.find((one) => one.textContent?.includes('OpenCode'))?.click();
    tick(fixture);
    fillAndCommit(host, '.preset-key', 'oc_sk_test');
    tick(fixture);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[1]?.[0]).toBe('opencode');
    expect(probe.mock.calls[1]?.[2]).toEqual([{ provider: 'opencode', apiKey: 'oc_sk_test' }]);

    // The host answers under this wizard's request id and the list appears inline.
    const requestId = probe.mock.calls[1]?.[3] ?? '';
    morse.bot.onModels({ requestId, kind: 'opencode', models: [claude] });
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
    walkToConnect(fixture, host, morse, 'pi');

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
    button(host, '.model-option').click();
    tick(fixture);
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

  it('takes a model’s limits and modalities from discovery, and lets the reader correct them', async () => {
    const { fixture, host, morse } = await render();
    walkToConnect(fixture, host, morse, 'pi');

    button(host, '.ghost').click();
    tick(fixture);
    fill(host, 'input[placeholder="acme"]', 'acme');
    fill(host, 'input[placeholder="https://api.example.com/v1"]', 'https://llm.acme.example/v1');
    tick(fixture);

    const discover = vi.spyOn(morse, 'discoverModels');
    button(host, '.draft-discover .ghost').click();
    tick(fixture);
    const requestId = discover.mock.calls[0]?.[2] ?? '';
    morse.bot.onModels({
      requestId,
      kind: 'discover',
      models: [
        // The listing knew nothing about this one: nothing is invented for it.
        { provider: 'discover', id: 'acme-chat', name: 'Acme Chat' },
        // One it did answer for, and got the window wrong for the reader's purpose.
        {
          provider: 'discover',
          id: 'acme-vision',
          name: 'Acme Vision',
          contextWindow: 32_000,
          maxTokens: 4_096,
          input: ['text', 'image'],
        },
      ],
    });
    tick(fixture);

    const rows = [...host.querySelectorAll('.model-row')];
    const [chatRow, visionRow] = rows as HTMLElement[];
    // Discovery's numbers arrive in the boxes, ready to be corrected.
    expect((visionRow?.querySelectorAll('input')[0] as HTMLInputElement).value).toBe('32000');
    expect((visionRow?.querySelectorAll('input')[1] as HTMLInputElement).value).toBe('4096');
    expect(visionRow?.querySelector('.cap-toggle')?.classList.contains('on')).toBe(true);
    // Nothing was found for the other one, so its boxes say "default", not a guess.
    expect((chatRow?.querySelectorAll('input')[0] as HTMLInputElement).value).toBe('');
    expect(chatRow?.querySelector('.cap-toggle')?.classList.contains('on')).toBe(false);

    // The reader fixes the window and gives the other model images too.
    type(chatRow?.querySelectorAll('input')[0] as HTMLInputElement, '200000');
    type(chatRow?.querySelectorAll('input')[1] as HTMLInputElement, '8192');
    (chatRow?.querySelector('.cap-toggle') as HTMLButtonElement).click();
    tick(fixture);

    button(host, '.draft-actions .primary').click();
    tick(fixture);
    button(host, '.model-option').click();
    tick(fixture);
    finishFromConnect(fixture, host);
    const create = vi.spyOn(morse, 'createBot');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);

    const submitted = create.mock.calls[0]?.[0] as BotCreateInput;
    // Written into the engine's own model entries: pi's `contextWindow`,
    // `maxTokens` and `input` — a text-only default is not assumed for a model
    // the reader said takes images.
    expect(submitted.providers?.[0]?.models).toEqual([
      {
        id: 'acme-chat',
        name: 'Acme Chat',
        contextWindow: 200_000,
        maxTokens: 8_192,
        input: ['text', 'image'],
      },
      {
        id: 'acme-vision',
        name: 'Acme Vision',
        contextWindow: 32_000,
        maxTokens: 4_096,
        input: ['text', 'image'],
      },
    ]);
  });

  it('clears a limit back to the engine default when the box is emptied', async () => {
    const { fixture, host, morse } = await render();
    walkToConnect(fixture, host, morse, 'pi');

    button(host, '.ghost').click();
    tick(fixture);
    fill(host, 'input[placeholder="acme"]', 'acme');
    fill(host, 'input[placeholder="https://api.example.com/v1"]', 'https://llm.acme.example/v1');
    tick(fixture);
    const discover = vi.spyOn(morse, 'discoverModels');
    button(host, '.draft-discover .ghost').click();
    tick(fixture);
    morse.bot.onModels({
      requestId: discover.mock.calls[0]?.[2] ?? '',
      kind: 'discover',
      models: [
        {
          provider: 'discover',
          id: 'acme-chat',
          name: 'Acme Chat',
          contextWindow: 32_000,
          maxTokens: 4096,
        },
      ],
    });
    tick(fixture);

    const row = host.querySelector('.model-row') as HTMLElement;
    // Empty means "nobody knows": the field is dropped, not written as 0.
    type(row.querySelectorAll('input')[0] as HTMLInputElement, '');

    button(host, '.draft-actions .primary').click();
    tick(fixture);
    button(host, '.model-option').click();
    tick(fixture);
    finishFromConnect(fixture, host);
    const create = vi.spyOn(morse, 'createBot');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);

    const submitted = create.mock.calls[0]?.[0] as BotCreateInput;
    expect(submitted.providers?.[0]?.models).toEqual([
      { id: 'acme-chat', name: 'Acme Chat', maxTokens: 4096 },
    ]);
  });

  it('ticks a step the moment its form is satisfied, without pressing Next', async () => {
    const { fixture, host } = await render();
    const ticked = (): boolean[] =>
      [...host.querySelectorAll('.wizard-step')].map((one) => one.classList.contains('done'));

    // Nothing filled, nothing ticked.
    expect(ticked()).toEqual([false, false, false, false, false, false, false]);

    // Typing the name ticks Identity while the cursor is still on it.
    fill(host, 'input[placeholder="News Finder"]', 'Forge');
    tick(fixture);
    expect(ticked()).toEqual([true, false, false, false, false, false, false]);

    // Choosing an engine ticks Engine straight away — no Next involved.
    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    const choices = [...host.querySelectorAll('.choice')] as HTMLButtonElement[];
    choices.find((one) => one.textContent?.toLowerCase().includes('pi'))?.click();
    tick(fixture);
    expect(currentStep(host)).toBe('Engine');
    expect(ticked()[1]).toBe(true);

    // Switching the choice keeps it satisfied — the requirement is "an engine".
    choices.find((one) => one.textContent?.toLowerCase().includes('opencode'))?.click();
    tick(fixture);
    expect(ticked()[1]).toBe(true);

    // Clearing the name drops only Identity's tick. The tick is the form state.
    const identityStep = host.querySelectorAll('.wizard-step')[0]?.querySelector('button');
    (identityStep as HTMLButtonElement).click();
    tick(fixture);
    expect(currentStep(host)).toBe('Identity');
    fill(host, 'input[placeholder="News Finder"]', '   ');
    tick(fixture);
    expect(ticked()).toEqual([false, true, false, false, false, false, false]);

    // Restoring it brings the tick back with no navigation at all.
    fill(host, 'input[placeholder="News Finder"]', 'Forge');
    tick(fixture);
    expect(ticked()).toEqual([true, true, false, false, false, false, false]);
  });

  it('keeps a satisfied step ticked and reachable as the cursor moves', async () => {
    const { fixture, host, morse } = await render();
    walkToReview(fixture, host, morse, 'pi');

    const ticked = (): boolean[] =>
      [...host.querySelectorAll('.wizard-step')].map((one) => one.classList.contains('done'));
    const stepButton = (at: number): HTMLButtonElement =>
      host.querySelectorAll('.wizard-step')[at]?.querySelector('button') as HTMLButtonElement;

    expect(ticked()).toEqual([true, true, true, true, true, true, false]);

    // Jumping back to Identity keeps every other tick: their forms still hold.
    stepButton(0).click();
    tick(fixture);
    expect(currentStep(host)).toBe('Identity');
    expect((host.querySelector('input[placeholder="News Finder"]') as HTMLInputElement).value).toBe(
      'Forge',
    );
    expect(ticked()).toEqual([true, true, true, true, true, true, false]);

    // And a satisfied step is reachable forward again, in one click.
    stepButton(2).click();
    tick(fixture);
    expect(currentStep(host)).toBe('Connect');
  });

  it('refuses to jump to a step whose form is not satisfied', async () => {
    const { fixture, host } = await render();

    const rail = [...host.querySelectorAll('.wizard-step')] as HTMLElement[];
    expect(rail.map((one) => (one.querySelector('button') as HTMLButtonElement).disabled)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    // Even MCP — satisfied on its own — is refused while earlier steps are not.
    (rail[4]?.querySelector('button') as HTMLButtonElement).click();
    tick(fixture);
    expect(currentStep(host)).toBe('Identity');
  });

  it('shows the subagent editor for opencode only', async () => {
    const pi = await render();
    walkToReview(pi.fixture, pi.host, pi.morse, 'pi');
    expect(pi.host.textContent).not.toContain('Subagents');

    const opencode = await render();
    walkToReview(opencode.fixture, opencode.host, opencode.morse, 'opencode');
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
    const { probe } = walkToConnect(fixture, host, morse, 'opencode');

    // A key committed on Connect re-probes without leaving the step.
    const chips = [...host.querySelectorAll('.preset-chip')] as HTMLButtonElement[];
    chips.find((one) => one.textContent?.includes('Anthropic'))?.click();
    tick(fixture);
    fillAndCommit(host, '.preset-key', 'sk-ant-123');
    tick(fixture);
    const requestId = probe.mock.calls.at(-1)?.[3] ?? '';
    morse.bot.onModels({ requestId, kind: 'opencode', models: [claude] });
    tick(fixture);
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
      username: 'forge',
      name: 'Forge',
      description: 'Keeps the forge hot',
      engineKind: 'opencode',
      credentials: [{ provider: 'anthropic', apiKey: 'sk-ant-123' }],
      envVars: [],
      persona: 'You are Forge, the builder.',
      model: claude,
      thinkingLevel: 'high',
      // No `tools` key: the reader never touched the checklist, so the engine's
      // own default set applies — exactly what a default pi install resolves.
      agentsMd: '# Forge workspace',
      subagents: [{ name: 'reviewer', prompt: 'Read the diff and report risks.' }],
      requestId,
    };
    expect(create).toHaveBeenCalledWith(expected);
    expect(list).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.note')?.textContent).toContain('Creating Forge');
    expect(host.textContent).not.toContain('## Subagents');
  });

  it('adds an MCP server and sends it on create', async () => {
    const { fixture, host, morse } = await render();
    const { probe } = walkToConnect(fixture, host, morse, 'pi');
    pickCatalogModel(fixture, host, morse, probe);
    walkToMcp(fixture, host);

    // Optional from the first moment: an empty list never holds Next back.
    expect(host.querySelector('.mcp-empty')?.textContent).toContain('No servers yet');
    expect(button(host, '.wizard-foot .primary').disabled).toBe(false);

    fill(host, 'input[placeholder="filesystem"]', 'filesystem');
    fill(host, 'input[placeholder="npx"]', 'npx');
    fill(host, 'input[placeholder="-y @modelcontextprotocol/server-filesystem ."]', '-y server .');
    tick(fixture);
    button(host, '.mcp-add').click();
    tick(fixture);
    expect(host.querySelector('.mcp-server')?.textContent).toContain('filesystem');

    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    expect(currentStep(host)).toBe('Advanced');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    expect(currentStep(host)).toBe('Review');
    // Review names the servers, not just their count.
    expect(host.querySelector('.review')?.textContent).toContain('filesystem');

    const create = vi.spyOn(morse, 'createBot');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    expect(create.mock.calls[0]?.[0]?.mcpServers).toEqual([
      {
        name: 'filesystem',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'server', '.'],
        enabled: true,
      },
    ]);
  });

  it('closes once the roster names the bot it created', async () => {
    const { fixture, host, morse } = await render();
    morse.ui.wizardOpen.set(true);
    walkToReview(fixture, host, morse, 'pi');
    const create = vi.spyOn(morse, 'createBot');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    const submitted = create.mock.calls[0]?.[0] as BotCreateInput;
    expect(submitted).not.toHaveProperty('thinkingLevel');

    morse.bot.onRoster({
      bots: [
        {
          username: 'sable',
          name: 'Sable',
          description: 'Elsewhere',
          engineKind: 'pi',
          warm: false,
        },
      ],
      conversations: [],
    });
    tick(fixture);
    expect(morse.ui.wizardOpen()).toBe(true);

    morse.bot.onRoster({
      bots: [
        {
          username: 'sable',
          name: 'Sable',
          description: 'Elsewhere',
          engineKind: 'pi',
          warm: false,
        },
        {
          username: 'forge',
          name: 'Forge',
          description: 'Keeps the forge hot',
          engineKind: 'pi',
          warm: false,
        },
      ],
      conversations: [],
    });
    tick(fixture);
    expect(morse.ui.wizardOpen()).toBe(false);
  });

  it('clears the pending create and shows the notice when the host refuses it', async () => {
    const { fixture, host, morse, transport } = await render();
    morse.ui.wizardOpen.set(true);
    walkToReview(fixture, host, morse, 'pi');
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

  it('fills the whole form from the bot being edited and saves an update', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [] });
    morse.ui.wizardTarget.set('forge');
    morse.ui.wizardOpen.set(true);
    const inspect = vi.spyOn(morse, 'inspectBot');
    fixture.detectChanges();

    // The wizard asks the host for the record, and fills itself when it arrives.
    expect(inspect).toHaveBeenCalledWith('forge');
    expect(host.querySelector('h2')?.textContent?.trim()).toBe('Edit bot');

    morse.bot.onConfig({
      username: 'forge',
      name: 'Forge',
      description: 'Keeps the forge hot',
      avatar: '🔧',
      engineKind: 'pi',
      model: claude,
      thinkingLevel: 'high',
      persona: 'You are Forge.',
      envVars: ['ANTHROPIC_API_KEY'],
      agentsMd: '# Forge workspace\n',
      subagents: [{ name: 'reviewer', prompt: 'Read the diff.' }],
    });
    fixture.detectChanges();

    expect((host.querySelector('input[placeholder="News Finder"]') as HTMLInputElement).value).toBe(
      'Forge',
    );
    // The label is free text, so an edit can change it — the handle cannot.
    expect(
      (host.querySelector('input[placeholder="News Finder"]') as HTMLInputElement).disabled,
    ).toBe(false);
    const handle = host.querySelector('input[placeholder="news-finder"]') as HTMLInputElement;
    expect(handle.value).toBe('forge');
    expect(handle.disabled).toBe(true);
    // Every step is already satisfied, so the rail is a checklist.
    expect(host.querySelectorAll('.wizard-step.done').length).toBe(6);

    // Jump straight to Review: nothing has to be re-answered.
    const rail = [...host.querySelectorAll('.wizard-step')] as HTMLElement[];
    (rail[6]?.querySelector('button') as HTMLButtonElement).click();
    tick(fixture);
    expect(currentStep(host)).toBe('Review');
    expect(host.querySelector('.review')?.textContent).toContain('anthropic/claude-sonnet-4');

    const update = vi.spyOn(morse, 'updateBot');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);

    // An untouched form sends no credentials: the engine keeps the stored ones.
    expect(update).toHaveBeenCalledWith({
      username: 'forge',
      name: 'Forge',
      description: 'Keeps the forge hot',
      avatar: '🔧',
      persona: 'You are Forge.',
      model: claude,
      thinkingLevel: 'high',
      envVars: ['ANTHROPIC_API_KEY'],
      agentsMd: '# Forge workspace',
      subagents: [{ name: 'reviewer', prompt: 'Read the diff.' }],
    });
    // Its config named no MCP servers, so the engine's file stays untouched.
    expect(update.mock.calls[0]?.[0]).not.toHaveProperty('mcpServers');
    expect(host.textContent).toContain('Saving…');
  });

  it('seeds MCP servers from the edited config and sends them back', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [] });
    morse.ui.wizardTarget.set('forge');
    morse.ui.wizardOpen.set(true);
    fixture.detectChanges();
    morse.bot.onConfig({
      username: 'forge',
      name: 'Forge',
      description: 'Keeps the forge hot',
      engineKind: 'pi',
      model: claude,
      persona: 'You are Forge.',
      envVars: [],
      mcpServers: [filesystemServer],
    });
    fixture.detectChanges();

    const rail = [...host.querySelectorAll('.wizard-step')] as HTMLElement[];
    (rail[4]?.querySelector('button') as HTMLButtonElement).click();
    tick(fixture);
    expect(currentStep(host)).toBe('MCP');
    expect(host.querySelector('.mcp-server')?.textContent).toContain('filesystem');

    (rail[6]?.querySelector('button') as HTMLButtonElement).click();
    tick(fixture);
    expect(currentStep(host)).toBe('Review');
    expect(host.querySelector('.review')?.textContent).toContain('filesystem');

    const update = vi.spyOn(morse, 'updateBot');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    // Read back and sent unchanged: an edit rewrites the same list.
    expect(update.mock.calls[0]?.[0]?.mcpServers).toEqual([filesystemServer]);
  });

  it('sends an empty list when the last server is removed on an edit', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [] });
    morse.ui.wizardTarget.set('forge');
    morse.ui.wizardOpen.set(true);
    fixture.detectChanges();
    morse.bot.onConfig({
      username: 'forge',
      name: 'Forge',
      description: 'Keeps the forge hot',
      engineKind: 'pi',
      model: claude,
      persona: 'You are Forge.',
      envVars: [],
      mcpServers: [filesystemServer],
    });
    fixture.detectChanges();

    const rail = [...host.querySelectorAll('.wizard-step')] as HTMLElement[];
    (rail[4]?.querySelector('button') as HTMLButtonElement).click();
    tick(fixture);
    expect(host.querySelectorAll('.mcp-server').length).toBe(1);

    button(host, '.mcp-remove').click();
    tick(fixture);
    expect(host.querySelectorAll('.mcp-server').length).toBe(0);

    (rail[6]?.querySelector('button') as HTMLButtonElement).click();
    tick(fixture);
    const update = vi.spyOn(morse, 'updateBot');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);
    // A list the reader emptied is a decision, so it goes as an empty array.
    expect(update.mock.calls[0]?.[0]?.mcpServers).toEqual([]);
  });

  it('reads a bot’s own providers back and writes a corrected limit on an edit', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [] });
    morse.ui.wizardTarget.set('forge');
    morse.ui.wizardOpen.set(true);
    fixture.detectChanges();

    morse.bot.onConfig({
      username: 'forge',
      name: 'Forge',
      description: 'Keeps the forge hot',
      engineKind: 'pi',
      model: claude,
      persona: 'You are Forge.',
      envVars: [],
      // What the host read out of pi's models.json: no credential, ever.
      providers: [
        {
          id: 'llm-eigen',
          label: 'Eigen',
          api: 'openai-completions',
          baseUrl: 'https://llm.example/v1',
          models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek flash' }],
        },
      ],
    });
    fixture.detectChanges();

    // Straight to Connect, where the bot's own providers are shown with their
    // limits — the fields discovery could not know for this endpoint.
    const rail = [...host.querySelectorAll('.wizard-step')] as HTMLElement[];
    (rail[2]?.querySelector('button') as HTMLButtonElement).click();
    tick(fixture);

    const card = [...host.querySelectorAll('.provider-card')].at(-1) as HTMLElement;
    expect(card.textContent).toContain('llm-eigen');
    expect(card.querySelector('.model-id')?.textContent?.trim()).toBe('deepseek-v4-flash');

    const [context, maxOut] = [...card.querySelectorAll('input')] as HTMLInputElement[];
    type(context as HTMLInputElement, '65536');
    type(maxOut as HTMLInputElement, '8192');
    (card.querySelector('.cap-toggle') as HTMLButtonElement).click();
    tick(fixture);

    const update = vi.spyOn(morse, 'updateBot');
    (rail[6]?.querySelector('button') as HTMLButtonElement).click();
    tick(fixture);
    button(host, '.wizard-foot .primary').click();
    tick(fixture);

    const sent = update.mock.calls[0]?.[0] as { providers?: unknown; credentials?: unknown };
    // The correction goes into the engine's own provider entry, with no
    // credential: the key stays where pi put it.
    expect(sent.providers).toEqual([
      {
        id: 'llm-eigen',
        label: 'Eigen',
        api: 'openai-completions',
        baseUrl: 'https://llm.example/v1',
        models: [
          {
            id: 'deepseek-v4-flash',
            name: 'DeepSeek flash',
            contextWindow: 65_536,
            maxTokens: 8_192,
            input: ['text', 'image'],
          },
        ],
      },
    ]);
    expect(sent).not.toHaveProperty('credentials');
  });

  it('keeps the saved model selectable when the catalog cannot list it', async () => {
    const { fixture, host, morse } = await render();
    const probe = vi.spyOn(morse, 'probeModels');
    morse.ui.wizardTarget.set('forge');
    morse.ui.wizardOpen.set(true);
    fixture.detectChanges();
    morse.bot.onConfig({
      username: 'forge',
      name: 'Forge',
      description: 'Keeps the forge hot',
      engineKind: 'pi',
      model: claude,
      persona: 'You are Forge.',
      envVars: [],
    });
    fixture.detectChanges();

    // Arriving at Connect probes with no keys (Morse cannot read them back), and
    // the catalog comes back empty.
    const rail = [...host.querySelectorAll('.wizard-step')] as HTMLElement[];
    (rail[2]?.querySelector('button') as HTMLButtonElement).click();
    tick(fixture);
    expect(currentStep(host)).toBe('Connect');
    morse.bot.onModels({ requestId: probe.mock.calls.at(-1)?.[3] ?? '', kind: 'pi', models: [] });
    tick(fixture);

    // Nothing listed, yet the bot's own model stays chosen and the step passes.
    expect(host.querySelector('.model-option.on')?.textContent).toContain('Claude Sonnet 4');
    expect(button(host, '.wizard-foot .primary').disabled).toBe(false);
  });

  it('derives the username from the name and validates it live', async () => {
    const { fixture, host } = await render();
    const next = (): HTMLButtonElement => button(host, '.wizard-foot .primary');

    // Typing a free-text name fills the handle too: 'News Finder' → 'news-finder'.
    fill(host, 'input[placeholder="News Finder"]', 'News Finder');
    tick(fixture);
    const handle = host.querySelector('input[placeholder="news-finder"]') as HTMLInputElement;
    expect(handle.value).toBe('news-finder');
    expect(next().disabled).toBe(false);

    // Free text in the label never leaks into the handle.
    fill(host, 'input[placeholder="News Finder"]', 'News Finder ✨ (v2)');
    tick(fixture);
    expect(handle.value).toBe('news-finder-v2');

    // The reader can take the handle over, and it is checked as they type.
    handle.value = 'news finder';
    handle.dispatchEvent(new Event('input'));
    tick(fixture);
    expect(host.querySelector('.error-note')?.textContent).toContain('lowercase letters');

    // A later name edit leaves a handle the reader owns alone.
    fill(host, 'input[placeholder="News Finder"]', 'Something Else');
    tick(fixture);
    expect(handle.value).toBe('news finder');
    expect(next().disabled).toBe(true);

    handle.value = 'news-finder';
    handle.dispatchEvent(new Event('input'));
    tick(fixture);
    expect(host.querySelector('.error-note')).toBeNull();
    expect(next().disabled).toBe(false);
  });

  it('refuses a username the roster already holds', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [] });
    fixture.detectChanges();

    fill(host, 'input[placeholder="News Finder"]', 'Forge');
    tick(fixture);
    // The handle follows the label, and the label matches an existing bot's.
    expect(host.querySelector('.error-note')?.textContent).toContain('taken');
    expect(button(host, '.wizard-foot .primary').disabled).toBe(true);
  });

  it('offers the engine built-in tools, and sends the chosen ones', async () => {
    const { fixture, host, morse } = await render();
    const { probe } = walkToConnect(fixture, host, morse, 'pi');
    pickCatalogModel(fixture, host, morse, probe);
    finishFromConnect(fixture, host);

    // The checklist lives on Advanced, which the walk already passed: go back.
    const rail = [...host.querySelectorAll('.wizard-step')] as HTMLElement[];
    (rail[5]?.querySelector('button') as HTMLButtonElement).click();
    tick(fixture);

    const boxes = [...host.querySelectorAll('.tool input[type="checkbox"]')] as HTMLInputElement[];
    // pi's own four, all on by default: a coding harness with no `read` is useless.
    expect(boxes.map((box) => box.getAttribute('data-tool'))).toEqual([
      'read',
      'bash',
      'edit',
      'write',
    ]);
    expect(boxes.map((box) => box.checked)).toEqual([true, true, true, true]);

    // Turning one off is a choice about that tool, not about tools in general.
    const bash = boxes[1] as HTMLInputElement;
    bash.checked = false;
    bash.dispatchEvent(new Event('change'));
    tick(fixture);

    (rail[6]?.querySelector('button') as HTMLButtonElement).click();
    tick(fixture);
    const create = vi.spyOn(morse, 'createBot');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);

    // Only a changed selection is written: pi's default stays pi's default.
    expect(create.mock.calls[0]?.[0]).toMatchObject({ tools: ['read', 'edit', 'write'] });
  });

  it('writes no tools key while the reader leaves the engine default alone', async () => {
    const { fixture, host, morse } = await render();
    const { probe } = walkToConnect(fixture, host, morse, 'pi');
    pickCatalogModel(fixture, host, morse, probe);
    finishFromConnect(fixture, host);

    const create = vi.spyOn(morse, 'createBot');
    button(host, '.wizard-foot .primary').click();
    tick(fixture);

    // A bot created without touching the checklist has the same *shape* as
    // `~/.pi/agent/settings.json`: no `defaultTools`, so pi resolves its own
    // default (read, bash, edit, write) exactly as it does from the CLI.
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('tools');
  });

  it('offers OpenCode its own wider tool set, web tools included', async () => {
    const { fixture, host, morse } = await render();
    walkToReview(fixture, host, morse, 'opencode');
    // Advanced is behind the walk: the checklist lives there.
    const rail = [...host.querySelectorAll('.wizard-step')] as HTMLElement[];
    (rail[5]?.querySelector('button') as HTMLButtonElement).click();
    tick(fixture);

    const names = [...host.querySelectorAll('.tool input[type="checkbox"]')].map((box) =>
      box.getAttribute('data-tool'),
    );
    // pi has no web tool; OpenCode does, and the form reflects the engine.
    expect(names).toContain('webfetch');
    expect(names).toContain('websearch');
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
