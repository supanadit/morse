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

let lastProbe: ProbeSpy | undefined;

async function render(): Promise<{
  fixture: ComponentFixture<BotWizard>;
  host: HTMLElement;
  morse: MorseService;
  transport: ScriptedHost;
  probe: ProbeSpy;
}> {
  TestBed.resetTestingModule();
  const transport = new ScriptedHost();
  await TestBed.configureTestingModule({
    imports: [BotWizard],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();
  const morse = TestBed.inject(MorseService);
  // Before the first render: a page with an engine answers its catalog at once.
  const probe = vi.spyOn(morse, 'probeModels');
  const fixture = TestBed.createComponent(BotWizard);
  fixture.detectChanges();
  lastProbe = probe;
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    morse,
    transport,
    probe,
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

/**
 * A new bot with its name, the line it helps with, and an engine: one page means
 * one fill, and the probe fires the moment the engine is picked.
 */
function walkToConnect(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  _morse: MorseService,
  kind: string,
): { probe: ProbeSpy } {
  fill(host, 'input[placeholder="News Finder"]', 'Forge');
  fill(host, 'textarea[placeholder^="Compare options"]', 'Keeps the forge hot');
  // Written by the test, not seeded: the assertions below compare the payload.
  fill(host, 'textarea[placeholder^="You are Forge"]', 'You are Forge.');
  tick(fixture);
  const engines = [...host.querySelectorAll('.brain-rail .brain-pick')] as HTMLButtonElement[];
  const match = engines.find((one) => one.textContent?.toLowerCase().includes(kind));
  match?.click();
  tick(fixture);
  return { probe: lastProbe as ProbeSpy };
}

/** Answers the last catalog probe with a list of models. */
function answerModels(
  fixture: ComponentFixture<BotWizard>,
  morse: MorseService,
  probe: ProbeSpy,
  models: ModelOption[],
): void {
  const call = probe.mock.calls.at(-1);
  morse.bot.onModels({ requestId: call?.[3] ?? '', kind: call?.[0] ?? 'pi', models });
  tick(fixture);
}

/** Answers the catalog probe the wizard already sent, then picks the first model. */
function pickCatalogModel(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  morse: MorseService,
  probe: ProbeSpy,
  model: ModelOption = claude,
): void {
  const call = probe.mock.calls.at(-1);
  morse.bot.onModels({
    requestId: call?.[3] ?? '',
    // The answer belongs to the engine that was asked for it.
    kind: call?.[0] ?? 'pi',
    models: [model],
  });
  tick(fixture);
  button(host, '.model-option').click();
  tick(fixture);
}

/** The expert rows a test may want filled — on the page, opened or not. */
function fillAdvanced(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  options: { mcp?: boolean; agentsMd?: string; subagent?: boolean } = {},
): void {
  if (options.mcp === true) {
    fill(host, 'input[placeholder="filesystem"]', 'filesystem');
    fill(host, 'input[placeholder="npx"]', 'npx');
    fill(host, 'input[placeholder="-y @modelcontextprotocol/server-filesystem ."]', '-y server .');
    button(host, '.mcp-add').click();
    tick(fixture);
  }
  if (options.agentsMd !== undefined) {
    fill(host, 'textarea[placeholder="# Forge workspace"]', options.agentsMd);
    tick(fixture);
  }
  if (options.subagent === true) {
    button(host, '.add-subagent').click();
    tick(fixture);
    fill(host, '.subagent input', 'reviewer');
    fill(host, '.subagent textarea', 'Read the diff and report risks.');
    tick(fixture);
  }
}

/** The same, under the name the older tests call it by. */
function finishFromConnect(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  options: { mcp?: boolean; agentsMd?: string; subagent?: boolean } = {},
): void {
  fillAdvanced(fixture, host, options);
}

/** Fill a field the way a browser does on blur: input, then change. */
function fillAndCommit(host: HTMLElement, selector: string, value: string): void {
  const field = host.querySelector(selector) as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new Event('input'));
  field.dispatchEvent(new Event('change'));
}

/** A filled page, ready to submit: the name, the engine, a model and its rows. */
function walkToReview(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  morse: MorseService,
  kind: string,
  options: { mcp?: boolean; agentsMd?: string; subagent?: boolean } = {},
): void {
  const { probe } = walkToConnect(fixture, host, morse, kind);
  pickCatalogModel(fixture, host, morse, probe);
  fillAdvanced(fixture, host, options);
}

describe('BotWizard', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('writes the instructions from the name and the line above', async () => {
    const { fixture, host } = await render();
    const persona = (): string =>
      (host.querySelector('textarea[placeholder^="You are Forge"]') as HTMLTextAreaElement).value;

    fill(host, 'input[placeholder="News Finder"]', 'Forge');
    fill(host, 'textarea[placeholder^="Compare options"]', 'Keeps the forge hot');
    tick(fixture);

    // A required textarea that opens blank is where a beginner stops.
    expect(persona()).toContain('You are Forge.');
    expect(persona()).toContain('Keeps the forge hot.');

    // Written over by the reader, then seeded again on request.
    fill(host, 'textarea[placeholder^="You are Forge"]', 'You are Forge, and you are terse.');
    tick(fixture);
    fill(host, 'input[placeholder="News Finder"]', 'Sigil');
    tick(fixture);
    expect(persona()).toBe('You are Forge, and you are terse.');

    button(host, '.starter-persona').click();
    tick(fixture);
    expect(persona()).toContain('You are Sigil.');
  });

  it('holds Create until the bot has a name, a handle, instructions and a model', async () => {
    const { fixture, host, morse } = await render();
    const create = (): HTMLButtonElement => button(host, '.board-foot .primary');

    expect(create().disabled).toBe(true);

    fill(host, 'input[placeholder="News Finder"]', 'Forge');
    fill(host, 'textarea[placeholder^="Compare options"]', 'Keeps the forge hot');
    tick(fixture);
    // Name, handle and instructions are there — the model is not.
    expect(create().disabled).toBe(true);

    const probe = lastProbe as ProbeSpy;
    const requestId = probe.mock.calls.at(-1)?.[3] ?? '';
    morse.bot.onModels({ requestId, kind: 'pi', models: [claude] });
    tick(fixture);
    expect(create().disabled).toBe(true);

    button(host, '.model-option').click();
    tick(fixture);
    expect(create().disabled).toBe(false);

    // A handle the host would refuse closes the button again.
    const handle = host.querySelector('input[placeholder="news-finder"]') as HTMLInputElement;
    handle.value = 'News Finder';
    handle.dispatchEvent(new Event('input'));
    tick(fixture);
    expect(create().disabled).toBe(true);
  });

  it('saves an edit from the footer, with no rail and no review to walk to', async () => {
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
    });
    fixture.detectChanges();

    // One page: every section is a row on it, and nothing is behind a step.
    expect(host.querySelector('.rows')).not.toBeNull();
    expect(host.querySelectorAll('.row').length).toBeGreaterThanOrEqual(6);
    expect(button(host, '.board-foot .primary').textContent?.trim()).toBe('Save bot');

    // Change one field in the middle section and save straight away.
    const description = host.querySelector(
      'textarea[placeholder^="Compare options"]',
    ) as HTMLInputElement;
    description.value = 'Keeps the forge warm';
    description.dispatchEvent(new Event('input'));
    tick(fixture);

    const update = vi.spyOn(morse, 'updateBot');
    button(host, '.board-foot .primary').click();
    tick(fixture);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]?.description).toBe('Keeps the forge warm');
  });

  it('tells the reader who reads the description', async () => {
    const { host } = await render();

    // The description is no longer a note for the reader alone: it is the roster
    // label another bot matches work against.
    expect(host.textContent).toContain('What other bots read when they look for help');
  });

  it('asks the catalog on open, and holds Create until a model is picked', async () => {
    const { fixture, host, morse, probe } = await render();

    // An engine is chosen for the reader, so the question the model row asks is
    // already answered with a list.
    const firstCall = probe.mock.calls[0];
    expect(firstCall?.[0]).toBe('pi');
    expect(firstCall?.[2]).toEqual([]);
    expect(host.querySelector('.board-body')?.textContent).toContain('Loading');

    const requestId = firstCall?.[3] ?? '';
    morse.bot.onModels({ requestId, kind: 'pi', models: [claude] });
    tick(fixture);
    expect(host.querySelector('.model-list')).not.toBeNull();
    expect(host.querySelector('.board-body')?.textContent).toContain('Pick a model');
    expect(button(host, '.board-foot .primary').disabled).toBe(true);

    fill(host, 'input[placeholder="News Finder"]', 'Forge');
    fill(host, 'textarea[placeholder^="Compare options"]', 'Keeps the forge hot');
    tick(fixture);
    expect(button(host, '.board-foot .primary').disabled).toBe(true);

    button(host, '.model-option').click();
    tick(fixture);
    expect(button(host, '.board-foot .primary').disabled).toBe(false);
  });

  it('shows engines, providers with their keys, and models in three columns', async () => {
    const { fixture, host, morse, probe } = await render();

    answerModels(fixture, morse, probe, [
      { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
      { provider: 'opencode-go', id: 'glm-5.2', name: 'GLM-5.2' },
    ]);

    // Column one: the engines.
    expect(
      [...host.querySelectorAll('.brain-rail .brain-pick-name')].map((one) =>
        one.textContent?.trim(),
      ),
    ).toEqual(['pi', 'OpenCode']);

    // Column two: nothing but key fields — one per provider the engine's own
    // catalog names, its environment name as the placeholder, no label or button.
    const keys = [...host.querySelectorAll('.brain-key')] as HTMLInputElement[];
    const placeholders = keys.map((one) => one.getAttribute('placeholder'));
    expect(placeholders).toContain('ANTHROPIC_API_KEY');
    expect(placeholders).toContain('OPENCODE_GO_API_KEY');
    // The engine's whole catalog is there, not just what one probe answered.
    expect(placeholders.length).toBeGreaterThan(20);
    // The providers the catalog answered for are the live rows, and lead.
    expect(keys[0]?.getAttribute('placeholder')).toBe('ANTHROPIC_API_KEY');

    // Column three: the models of the provider in front, and only those.
    expect(
      [...host.querySelectorAll('.brain-models .model-name')].map((one) =>
        one.textContent?.trim(),
      ),
    ).toEqual(['Claude Sonnet 4']);

    // Clicking another provider's key row swaps the third column at once.
    const opencodeGo = host.querySelector(
      'input[placeholder="OPENCODE_GO_API_KEY"]',
    ) as HTMLInputElement;
    opencodeGo.dispatchEvent(new Event('focus'));
    tick(fixture);
    expect(host.querySelector('.brain-key.on')?.getAttribute('placeholder')).toBe(
      'OPENCODE_GO_API_KEY',
    );
    expect(
      [...host.querySelectorAll('.brain-models .model-name')].map((one) =>
        one.textContent?.trim(),
      ),
    ).toEqual(['GLM-5.2']);
  });

  it('commits a key from the provider row and asks the catalog again', async () => {
    const { fixture, host, morse, probe } = await render();

    answerModels(fixture, morse, probe, [
      { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
      { provider: 'opencode-go', id: 'glm-5.2', name: 'GLM-5.2' },
    ]);

    const anthropicKey = host.querySelector(
      'input[placeholder="ANTHROPIC_API_KEY"]',
    ) as HTMLInputElement;
    anthropicKey.value = 'sk-ant-123';
    anthropicKey.dispatchEvent(new Event('change'));
    tick(fixture);

    expect(probe.mock.calls.at(-1)?.[2]).toEqual([{ provider: 'anthropic', apiKey: 'sk-ant-123' }]);

    // The answer lands, and the key it holds is still in its row.
    answerModels(fixture, morse, probe, [
      { provider: 'anthropic', id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
      { provider: 'opencode-go', id: 'glm-5.2', name: 'GLM-5.2' },
    ]);
    expect(
      (host.querySelector('input[placeholder="ANTHROPIC_API_KEY"]') as HTMLInputElement).value,
    ).toBe('sk-ant-123');
  });

  it('adds a custom provider, discovers its models over HTTP, and saves it', async () => {
    const { fixture, host, morse } = await render();
    walkToConnect(fixture, host, morse, 'pi');

    button(host, '.add-provider').click();
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
    button(host, '.board-foot .primary').click();
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

    button(host, '.add-provider').click();
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
    button(host, '.board-foot .primary').click();
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

    button(host, '.add-provider').click();
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
    button(host, '.board-foot .primary').click();
    tick(fixture);

    const submitted = create.mock.calls[0]?.[0] as BotCreateInput;
    expect(submitted.providers?.[0]?.models).toEqual([
      { id: 'acme-chat', name: 'Acme Chat', maxTokens: 4096 },
    ]);
  });

  it('shows the subagent editor for opencode only', async () => {
    const pi = await render();
    walkToReview(pi.fixture, pi.host, pi.morse, 'pi');
    expect(pi.host.textContent).not.toContain('Subagents');

    const opencode = await render();
    walkToReview(opencode.fixture, opencode.host, opencode.morse, 'opencode');
    // The subagent row is on the page for an engine that has them.
    expect(opencode.host.textContent).toContain('Subagents');
    button(opencode.host, '.add-subagent').click();
    tick(opencode.fixture);
    const nameInput = opencode.host.querySelector('.subagent input') as HTMLInputElement;
    expect(nameInput.pattern).toBe('[\\p{L}\\p{N}_][\\p{L}\\p{N}_\\-]*');
  });

  it('assembles the exact BotCreateInput on submit, then waits for the roster', async () => {
    const { fixture, host, morse } = await render();
    const { probe } = walkToConnect(fixture, host, morse, 'opencode');

    // The catalog answers first, so the provider's column — and its key field —
    // is on the page to type into.
    answerModels(fixture, morse, probe, [claude]);

    // A key typed into its provider's column is committed on blur, and the
    // catalog is asked again for what it now unlocks.
    const key = host.querySelector('.brain-key') as HTMLInputElement;
    key.value = 'sk-ant-123';
    key.dispatchEvent(new Event('change'));
    tick(fixture);
    answerModels(fixture, morse, probe, [claude]);
    button(host, '.model-option').click();
    tick(fixture);
    choose(host, '.brain select', 'high');
    tick(fixture);

    finishFromConnect(fixture, host, {
      agentsMd: '# Forge workspace\n',
      subagent: true,
    });

    const create = vi.spyOn(morse, 'createBot');
    const list = vi.spyOn(morse, 'listBots');
    button(host, '.board-foot .primary').click();
    tick(fixture);

    const requestId = probe.mock.calls.at(-1)?.[3] ?? '';
    const expected: BotCreateInput & { requestId: string } = {
      username: 'forge',
      name: 'Forge',
      description: 'Keeps the forge hot',
      engineKind: 'opencode',
      credentials: [{ provider: 'anthropic', apiKey: 'sk-ant-123' }],
      envVars: [],
      persona: 'You are Forge.',
      model: claude,
      thinkingLevel: 'high',
      // The checklist was never touched, but OpenCode needs an explicit
      // ruleset: its default set is what the permissions allow.
      tools: ['read', 'edit', 'glob', 'grep', 'shell'],
      agentsMd: '# Forge workspace',
      subagents: [{ name: 'reviewer', prompt: 'Read the diff and report risks.' }],
      requestId,
    };
    expect(create).toHaveBeenCalledWith(expected);
    expect(list).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.note')?.textContent).toContain('Forge — waiting for the roster');
    expect(host.querySelector('.row-label')?.textContent).toBeTruthy();
  });

  it('adds an MCP server and sends it on create', async () => {
    const { fixture, host, morse } = await render();
    const { probe } = walkToConnect(fixture, host, morse, 'pi');
    pickCatalogModel(fixture, host, morse, probe);

    // Optional from the first moment: an empty list never holds Next back.
    expect(host.querySelector('.mcp-empty')?.textContent).toContain('No servers yet');
    expect(button(host, '.board-foot .primary').disabled).toBe(false);

    fill(host, 'input[placeholder="filesystem"]', 'filesystem');
    fill(host, 'input[placeholder="npx"]', 'npx');
    fill(host, 'input[placeholder="-y @modelcontextprotocol/server-filesystem ."]', '-y server .');
    tick(fixture);
    button(host, '.mcp-add').click();
    tick(fixture);
    expect(host.querySelector('.mcp-server')?.textContent).toContain('filesystem');

    const create = vi.spyOn(morse, 'createBot');
    button(host, '.board-foot .primary').click();
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
    button(host, '.board-foot .primary').click();
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
    button(host, '.board-foot .primary').click();
    tick(fixture);
    expect(host.textContent).toContain('Forge — waiting for the roster to name it');

    transport.toClient({
      type: 'notice',
      payload: { level: 'error', text: 'The host has no bot engine "nope".', at: Date.now() },
    });
    tick(fixture);

    expect(host.textContent).not.toContain('Creating Forge');
    expect(host.querySelector('.error')?.textContent).toContain('no bot engine');
    expect(morse.ui.wizardOpen()).toBe(true);
    expect(button(host, '.board-foot .primary').disabled).toBe(false);
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
    // Before the record lands the bot has no name to show.
    expect(host.querySelector('.board-head h2')?.textContent?.trim()).toBe('Bot settings');

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
    // No rail and no Review: an edit is one form, saved from the footer.
    expect(host.querySelector('.wizard-rail')).toBeNull();
    expect(host.querySelectorAll('.row').length).toBeGreaterThanOrEqual(6);
    expect(host.querySelector('.model-option.on')?.textContent).toContain('Claude Sonnet 4');

    const update = vi.spyOn(morse, 'updateBot');
    button(host, '.board-foot .primary').click();
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

    // The servers are in the Advanced card, on the page already.
    expect(host.querySelector('.mcp-server')?.textContent).toContain('filesystem');

    const update = vi.spyOn(morse, 'updateBot');
    button(host, '.board-foot .primary').click();
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

    expect(host.querySelectorAll('.mcp-server').length).toBe(1);

    button(host, '.mcp-remove').click();
    tick(fixture);
    expect(host.querySelectorAll('.mcp-server').length).toBe(0);

    const update = vi.spyOn(morse, 'updateBot');
    button(host, '.board-foot .primary').click();
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

    // The bot's own providers are on the page with their limits — the fields
    // discovery could not know for this endpoint.
    const card = [...host.querySelectorAll('.provider-card')].at(-1) as HTMLElement;
    expect(card.textContent).toContain('llm-eigen');
    expect(card.querySelector('.model-id')?.textContent?.trim()).toBe('deepseek-v4-flash');

    const [context, maxOut] = [...card.querySelectorAll('input')] as HTMLInputElement[];
    type(context as HTMLInputElement, '65536');
    type(maxOut as HTMLInputElement, '8192');
    (card.querySelector('.cap-toggle') as HTMLButtonElement).click();
    tick(fixture);

    const update = vi.spyOn(morse, 'updateBot');
    button(host, '.board-foot .primary').click();
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

    // The edit probes with no keys (Morse cannot read them back), and the catalog
    // comes back empty.
    morse.bot.onModels({ requestId: probe.mock.calls.at(-1)?.[3] ?? '', kind: 'pi', models: [] });
    tick(fixture);

    // Nothing listed, yet the bot's own model stays chosen and the step passes.
    expect(host.querySelector('.model-option.on')?.textContent).toContain('Claude Sonnet 4');
    expect(button(host, '.board-foot .primary').disabled).toBe(false);
  });

  it('derives the username from the name and validates it live', async () => {
    const { fixture, host } = await render();
    const next = (): HTMLButtonElement => button(host, '.board-foot .primary');

    // Typing a free-text name fills the handle too: 'News Finder' → 'news-finder'.
    fill(host, 'input[placeholder="News Finder"]', 'News Finder');
    fill(host, 'textarea[placeholder^="You are Forge"]', 'You are Forge.');
    tick(fixture);
    const handle = host.querySelector('input[placeholder="news-finder"]') as HTMLInputElement;
    expect(handle.value).toBe('news-finder');
    // The handle is fine; the model is the only thing still missing.
    expect(host.querySelector('.error-note')).toBeNull();

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

    handle.value = 'news-finder';
    handle.dispatchEvent(new Event('input'));
    tick(fixture);
    expect(host.querySelector('.error-note')).toBeNull();
    // Nothing about the handle holds the button back any more.
    expect(next().disabled).toBe(true);
  });

  it('refuses a username the roster already holds', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [] });
    fixture.detectChanges();

    fill(host, 'input[placeholder="News Finder"]', 'Forge');
    tick(fixture);
    // The handle follows the label, and the label matches an existing bot's.
    expect(host.querySelector('.error-note')?.textContent).toContain('taken');
    expect(button(host, '.board-foot .primary').disabled).toBe(true);
  });

  it('offers the engine built-in tools, and sends the chosen ones', async () => {
    const { fixture, host, morse } = await render();
    const { probe } = walkToConnect(fixture, host, morse, 'pi');
    pickCatalogModel(fixture, host, morse, probe);
    finishFromConnect(fixture, host);

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

    const create = vi.spyOn(morse, 'createBot');
    button(host, '.board-foot .primary').click();
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
    button(host, '.board-foot .primary').click();
    tick(fixture);

    // A bot created without touching the checklist has the same *shape* as
    // `~/.pi/agent/settings.json`: no `defaultTools`, so pi resolves its own
    // default (read, bash, edit, write) exactly as it does from the CLI.
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('tools');
  });

  it('sends OpenCode’s default tools without the checklist being edited', async () => {
    const { fixture, host, morse } = await render();
    walkToReview(fixture, host, morse, 'opencode');
    const create = vi.spyOn(morse, 'createBot');
    button(host, '.board-foot .primary').click();
    tick(fixture);

    // OpenCode expresses tool access as a generated `permissions` ruleset, so
    // even an untouched checklist has to carry the default set: an absent one
    // would leave the bot with nothing but the blanket deny.
    expect(create.mock.calls[0]?.[0]?.tools).toEqual(['read', 'edit', 'glob', 'grep', 'shell']);
  });

  it('offers OpenCode 2 tool names, with shell on by default', async () => {
    const { fixture, host, morse } = await render();
    walkToReview(fixture, host, morse, 'opencode');

    const boxes = [...host.querySelectorAll('.tool input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.map((box) => box.getAttribute('data-tool'))).toEqual([
      'read',
      'edit',
      'glob',
      'grep',
      'shell',
      'subagent',
      'webfetch',
      'websearch',
      'todowrite',
    ]);
    expect(boxes.filter((box) => box.checked).map((box) => box.getAttribute('data-tool'))).toEqual([
      'read',
      'edit',
      'glob',
      'grep',
      'shell',
    ]);
  });

  it('sends shell, not bash or list, when the OpenCode checklist changes', async () => {
    const { fixture, host, morse } = await render();
    walkToReview(fixture, host, morse, 'opencode');

    const websearch = [...host.querySelectorAll('.tool input[type="checkbox"]')].find(
      (box) => box.getAttribute('data-tool') === 'websearch',
    ) as HTMLInputElement;
    websearch.checked = true;
    websearch.dispatchEvent(new Event('change'));
    tick(fixture);

    const create = vi.spyOn(morse, 'createBot');
    button(host, '.board-foot .primary').click();
    tick(fixture);

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      tools: ['read', 'edit', 'glob', 'grep', 'shell', 'websearch'],
    });
  });

  it('closes without creating anything when cancelled', async () => {
    const { fixture, host, morse } = await render();
    morse.ui.wizardOpen.set(true);
    const create = vi.spyOn(morse, 'createBot');

    buttonOrNull(host, '.board-close')?.click();
    tick(fixture);

    expect(create).not.toHaveBeenCalled();
    expect(morse.ui.wizardOpen()).toBe(false);
  });
});
