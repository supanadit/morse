import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type {
  BotCreateInput,
  BotMcpServerInput,
  BotSummary,
  HostToClientMessage,
  ProviderStatus,
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

/** One stdio server, as both a create sends it and an edit reads it back. */
const filesystemServer: BotMcpServerInput = {
  name: 'filesystem',
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'server', '.'],
  enabled: true,
};

const claude = {
  provider: 'anthropic',
  id: 'claude-sonnet-4',
  name: 'Claude Sonnet 4',
};

/** The engine catalog the mocked host reports for every engine. */
const catalogStatus: ProviderStatus = {
  engine: 'pi',
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      description: 'Claude models',
      kind: 'builtin',
      connected: true,
      auth: { key: true },
      models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }],
    },
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      description: 'GLM models',
      kind: 'builtin',
      connected: true,
      auth: { key: true },
      models: [{ id: 'glm-5.2', name: 'GLM-5.2' }],
    },
  ],
  issues: [],
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
  status: ReturnType<typeof vi.spyOn>;
}> {
  TestBed.resetTestingModule();
  const transport = new ScriptedHost();
  await TestBed.configureTestingModule({
    imports: [BotWizard],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();
  const morse = TestBed.inject(MorseService);
  // The wizard reads the engine's provider catalog on open, like Settings does.
  const status = vi
    .spyOn(morse, 'requestHostCommand')
    .mockImplementation(async (name) =>
      name === 'providerStatus' ? { ...catalogStatus } : { ok: true, message: 'Saved.' },
    );
  const fixture = TestBed.createComponent(BotWizard);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, morse, transport, status };
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

/**
 * A new bot with its name, the line it helps with, and an engine. The catalog
 * is read when the engine is picked, so the models are already listed after.
 */
async function walkToConnect(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  kind: string,
): Promise<void> {
  fill(host, 'input[placeholder="News Finder"]', 'Forge');
  fill(host, 'textarea[placeholder^="Compare options"]', 'Keeps the forge hot');
  // Written by the test, not seeded: the assertions below compare the payload.
  fill(host, 'textarea[placeholder^="You are Forge"]', 'You are Forge.');
  tick(fixture);
  const engines = [...host.querySelectorAll('.engine-rail .engine-pick')] as HTMLButtonElement[];
  const match = engines.find((one) => one.textContent?.toLowerCase().includes(kind));
  match?.click();
  tick(fixture);
  await fixture.whenStable();
  tick(fixture);
}

/** Picks the first model the picked provider lists. */
function pickFirstModel(host: HTMLElement, fixture: ComponentFixture<BotWizard>): void {
  button(host, '.model-pick').click();
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
async function walkToReview(
  fixture: ComponentFixture<BotWizard>,
  host: HTMLElement,
  morse: MorseService,
  kind: string,
  options: { mcp?: boolean; agentsMd?: string; subagent?: boolean } = {},
): Promise<void> {
  await walkToConnect(fixture, host, kind);
  pickFirstModel(host, fixture);
  fillAdvanced(fixture, host, options);
  void morse;
}

/** Opens the local-provider editor and fills its endpoint fields. */
function openLocalEditor(
  host: HTMLElement,
  fixture: ComponentFixture<BotWizard>,
  options: { id?: string; label?: string; baseUrl?: string } = {},
): void {
  button(host, '.card.custom').click();
  tick(fixture);
  fill(host, '.local-editor input[placeholder="acme"]', options.id ?? 'acme');
  if (options.label !== undefined) {
    fill(host, '.local-editor input[placeholder="Acme AI"]', options.label);
  }
  fill(
    host,
    '.local-editor input[placeholder="https://api.example.com/v1"]',
    options.baseUrl ?? 'https://llm.acme.example/v1',
  );
  tick(fixture);
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
    const { fixture, host } = await render();
    const create = (): HTMLButtonElement => button(host, '.board-foot .primary');

    expect(create().disabled).toBe(true);

    fill(host, 'input[placeholder="News Finder"]', 'Forge');
    fill(host, 'textarea[placeholder^="Compare options"]', 'Keeps the forge hot');
    tick(fixture);
    // Name, handle and instructions are there — the model is not.
    expect(create().disabled).toBe(true);

    button(host, '.model-pick').click();
    tick(fixture);
    expect(create().disabled).toBe(false);

    // A handle the host would refuse closes the button again.
    const handle = host.querySelector('input[placeholder="news-finder"]') as HTMLInputElement;
    handle.value = 'News Finder';
    handle.dispatchEvent(new Event('input'));
    tick(fixture);
    expect(create().disabled).toBe(true);
  });

  it('sends bot-only env values with the create', async () => {
    const { fixture, host, morse, status } = await render();
    await walkToConnect(fixture, host, 'pi');
    fill(
      host,
      'textarea[placeholder="ACME_TOKEN=only-this-bot"]',
      'ACME_TOKEN=secret\nREGION=eu',
    );
    tick(fixture);
    // Reload re-reads the engine's providers.
    button(host, '.provider-toolbar .ghost').click();
    tick(fixture);
    pickFirstModel(host, fixture);
    const create = vi.spyOn(morse, 'createBot');

    button(host, '.board-foot .primary').click();
    tick(fixture);

    expect(status).toHaveBeenCalledWith('providerStatus', { engine: 'pi' });
    expect(create.mock.calls[0]?.[0].env).toEqual({ ACME_TOKEN: 'secret', REGION: 'eu' });
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
    await fixture.whenStable();
    fixture.detectChanges();

    // One page: every section is on it, and nothing is behind a step.
    expect(host.querySelector('.rows')).not.toBeNull();
    expect(host.querySelectorAll('.row').length).toBeGreaterThanOrEqual(5);
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

  it('reads the engine catalog on open, and holds Create until a model is picked', async () => {
    const { fixture, host, status } = await render();

    // An engine is chosen for the reader, and its providers answer at once.
    expect(status).toHaveBeenCalledWith('providerStatus', { engine: 'pi' });
    expect(host.querySelector('.provider-grid')).not.toBeNull();
    expect(host.querySelector('.board-body')?.textContent).toContain('Pick a model');
    expect(button(host, '.board-foot .primary').disabled).toBe(true);

    fill(host, 'input[placeholder="News Finder"]', 'Forge');
    fill(host, 'textarea[placeholder^="Compare options"]', 'Keeps the forge hot');
    tick(fixture);
    expect(button(host, '.board-foot .primary').disabled).toBe(true);

    button(host, '.model-pick').click();
    tick(fixture);
    expect(button(host, '.board-foot .primary').disabled).toBe(false);
  });

  it('shows engines and provider cards with isolated key fields', async () => {
    const { fixture, host } = await render();

    // Column one: the engines.
    expect(
      [...host.querySelectorAll('.engine-rail .engine-pick-name')].map((one) =>
        one.textContent?.trim(),
      ),
    ).toEqual(['pi', 'OpenCode']);

    // The engine's whole catalog is there as cards, models included.
    const cards = [...host.querySelectorAll('.provider-grid .card')] as HTMLElement[];
    expect(cards.map((card) => card.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Anthropic')]),
    );
    // The host's own sign-ins never leak in: no card reads as connected here.
    expect(host.querySelector('.provider-grid')?.textContent).not.toContain('Connected');

    // Clicking another card swaps the detail at once, with its own key field.
    const opencodeGo = cards.find((card) => card.textContent?.includes('OpenCode Go')) as HTMLElement;
    (opencodeGo.querySelector('button') ?? opencodeGo).click();
    tick(fixture);
    // The detail is the picked provider's, with an isolated key field.
    expect(host.querySelector('.provider-detail .detail-head')?.textContent).toContain(
      'OpenCode Go',
    );
    const key = host.querySelector(
      '.provider-detail input[type="password"]',
    ) as HTMLInputElement;
    expect(key.getAttribute('placeholder')).toBe('OPENCODE_GO_API_KEY');
    expect(
      [...host.querySelectorAll('.model-pick .model-name')].map((one) =>
        one.textContent?.trim(),
      ),
    ).toEqual(['GLM-5.2']);
  });

  it('hides global custom endpoints until the snapshot box is checked', async () => {
    const { fixture, host, status } = await render();
    status.mockResolvedValue({
      engine: 'pi',
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          description: 'Claude models',
          kind: 'builtin',
          connected: false,
          auth: { key: true },
          models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }],
        },
        {
          id: 'llm-eigen',
          name: 'LLM Eigen',
          description: 'Custom endpoint',
          kind: 'custom',
          connected: true,
          models: [{ id: 'eigen-1', name: 'Eigen 1' }],
        },
      ],
      issues: [],
    });
    await walkToConnect(fixture, host, 'pi');
    // The catalog was read on open with the default mock; re-read with ours.
    button(host, '.provider-toolbar .ghost').click();
    tick(fixture);
    await fixture.whenStable();
    tick(fixture);

    // Unchecked: a private global endpoint does not even leak its name.
    expect(host.querySelector('.provider-grid')?.textContent).not.toContain('LLM Eigen');

    const toggle = host.querySelector<HTMLInputElement>('.global-auth input')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    tick(fixture);
    await fixture.whenStable();
    tick(fixture);

    // Checked: it appears, previewing its global connection.
    const grid = host.querySelector('.provider-grid')?.textContent ?? '';
    expect(grid).toContain('LLM Eigen');
    expect(grid).toContain('Global');
  });

  it('previews globally connected providers while the snapshot box is checked', async () => {
    const { fixture, host } = await render();
    await walkToConnect(fixture, host, 'pi');

    // Unchecked: the host's own sign-ins stay hidden — the bot reads nothing.
    expect(host.querySelector('.provider-grid')?.textContent).not.toContain('Global');

    const toggle = host.querySelector<HTMLInputElement>('.global-auth input')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    tick(fixture);

    // Checked: the catalog's connected providers preview live as Global.
    const grid = host.querySelector('.provider-grid')?.textContent ?? '';
    expect(grid).toContain('Global');
    // A pasted key still wins and reads as its own.
    fillAndCommit(host, '.provider-detail input[type="password"]', 'sk-ant-123');
    tick(fixture);
    const card = [...host.querySelectorAll('.provider-grid .card')].find((one) =>
      one.textContent?.includes('Anthropic'),
    ) as HTMLElement;
    expect(card.textContent).toContain('Key set');

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    tick(fixture);
    expect(host.querySelector('.provider-grid')?.textContent).not.toContain('Global');
  });

  it('snapshots the global configuration into the bot when checked', async () => {
    const { fixture, host, morse } = await render();
    await walkToConnect(fixture, host, 'pi');

    const toggle = host.querySelector<HTMLInputElement>('.global-auth input');
    expect(toggle).not.toBeNull();
    expect(host.textContent).toContain('Use global configuration');
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event('change'));
    tick(fixture);

    pickFirstModel(host, fixture);
    finishFromConnect(fixture, host);
    const create = vi.spyOn(morse, 'createBot');
    button(host, '.board-foot .primary').click();
    tick(fixture);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ useGlobalConfig: true });
  });

  it('commits a key for the picked provider and sends it isolated with the create', async () => {
    const { fixture, host, morse } = await render();
    await walkToConnect(fixture, host, 'pi');

    // Anthropic is picked by default; its key field is in the detail.
    const key = host.querySelector(
      '.provider-detail input[type="password"]',
    ) as HTMLInputElement;
    expect(key.getAttribute('placeholder')).toBe('ANTHROPIC_API_KEY');
    fillAndCommit(host, '.provider-detail input[type="password"]', 'sk-ant-123');
    tick(fixture);

    pickFirstModel(host, fixture);
    const create = vi.spyOn(morse, 'createBot');
    button(host, '.board-foot .primary').click();
    tick(fixture);

    // The key travels isolated with the bot — never through the host's store.
    expect(create.mock.calls[0]?.[0]?.credentials).toEqual([
      { provider: 'anthropic', apiKey: 'sk-ant-123' },
    ]);
    // …and the card now reads as keyed, from this bot's key alone.
    const card = [...host.querySelectorAll('.provider-grid .card')].find((one) =>
      one.textContent?.includes('Anthropic'),
    ) as HTMLElement;
    expect(card.textContent).toContain('Key set');
    // The key it holds is still in its field.
    expect(
      (host.querySelector('.provider-detail input[type="password"]') as HTMLInputElement).value,
    ).toBe('sk-ant-123');
  });

  it('probes a catalog provider that lists no models, with and without a key', async () => {
    const { fixture, host, morse, status } = await render();
    status.mockResolvedValue({
      engine: 'pi',
      providers: [
        {
          id: 'acme',
          name: 'Acme',
          description: 'Acme models',
          kind: 'builtin',
          connected: false,
          auth: { key: true },
          models: [],
        },
      ],
      issues: [],
    });
    const probe = vi.spyOn(morse, 'probeModels');
    await walkToConnect(fixture, host, 'pi');
    // The page auto-picked the engine before the re-mock, so reload the
    // catalog the way a reader would after the host's providers changed.
    button(host, '.provider-toolbar .ghost').click();
    tick(fixture);
    await fixture.whenStable();
    tick(fixture);

    // The catalog names no models, so the wizard asks the engine itself —
    // with no key yet, because a listing is not a sign-in.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.slice(0, 3)).toEqual(['pi', [], []]);
    const first = probe.mock.calls[0]?.[3] ?? '';
    morse.bot.onModels({
      requestId: first,
      kind: 'pi',
      models: [{ provider: 'acme', id: 'acme-chat', name: 'Acme Chat' }],
    });
    tick(fixture);
    expect(
      [...host.querySelectorAll('.provider-detail .model-pick')].map((one) => one.textContent),
    ).toEqual([expect.stringContaining('Acme Chat')]);

    // Typing the key re-probes with it: a key can unlock models the
    // anonymous listing hides.
    fillAndCommit(host, '.provider-detail input[type="password"]', 'sk-acme');
    tick(fixture);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[1]?.slice(0, 3)).toEqual([
      'pi',
      [],
      [{ provider: 'acme', apiKey: 'sk-acme' }],
    ]);
    morse.bot.onModels({
      requestId: probe.mock.calls[1]?.[3] ?? '',
      kind: 'pi',
      models: [
        { provider: 'acme', id: 'acme-chat', name: 'Acme Chat' },
        { provider: 'acme', id: 'acme-pro', name: 'Acme Pro' },
      ],
    });
    tick(fixture);
    expect(
      [...host.querySelectorAll('.provider-detail .model-pick')].map((one) => one.textContent),
    ).toEqual([expect.stringContaining('Acme Chat'), expect.stringContaining('Acme Pro')]);

    // ...and the picked model still submits with the isolated key.
    button(host, '.provider-detail .model-pick').click();
    tick(fixture);
    const create = vi.spyOn(morse, 'createBot');
    button(host, '.board-foot .primary').click();
    tick(fixture);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      credentials: [{ provider: 'acme', apiKey: 'sk-acme' }],
      model: { provider: 'acme', id: 'acme-chat' },
    });
  });

  it('adds a custom provider, discovers its models over HTTP, and saves it', async () => {
    const { fixture, host, morse } = await render();
    await walkToConnect(fixture, host, 'pi');

    openLocalEditor(host, fixture, { label: 'Acme AI' });
    fill(host, '.local-editor input[type="password"]', 'sk-acme');
    tick(fixture);

    const discover = vi.spyOn(morse, 'discoverModels');
    button(host, '.editor-discover .ghost').click();
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
    const rows = [...host.querySelectorAll('.local-editor tr.model-main')] as HTMLElement[];
    expect(rows.map((row) => (row.querySelector('input') as HTMLInputElement).value)).toEqual(
      expect.arrayContaining(['qwen3-coder', 'qwen3-32b']),
    );

    // A hand-added row is always possible too.
    button(host, '.editor-models-head .secondary').click();
    tick(fixture);
    const ids = [...host.querySelectorAll('.local-editor input[aria-label="Model ID"]')] as HTMLInputElement[];
    type(ids.at(-1) as HTMLInputElement, 'acme-chat');
    tick(fixture);

    button(host, '.editor-actions .primary').click();
    tick(fixture);
    const card = [...host.querySelectorAll('.provider-grid .card')].find((one) =>
      one.textContent?.includes('Acme AI'),
    ) as HTMLElement;
    expect(card?.textContent).toContain('This bot');

    // The saved provider is part of the create payload.
    button(host, '.provider-detail .model-pick').click();
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
    await walkToConnect(fixture, host, 'pi');

    openLocalEditor(host, fixture);
    tick(fixture);

    const discover = vi.spyOn(morse, 'discoverModels');
    button(host, '.editor-discover .ghost').click();
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

    const rows = [...host.querySelectorAll('.local-editor tr.model-main')];
    const [chatRow, visionRow] = rows as HTMLElement[];
    // Discovery's numbers arrive in the boxes, ready to be corrected.
    expect(
      (visionRow?.querySelector('input[aria-label="Context limit"]') as HTMLInputElement).value,
    ).toBe('32000');
    expect(
      (visionRow?.querySelector('input[aria-label="Max output"]') as HTMLInputElement).value,
    ).toBe('4096');

    // The reader fixes the window of the plain one.
    type(chatRow?.querySelector('input[aria-label="Context limit"]') as HTMLInputElement, '200000');
    type(chatRow?.querySelector('input[aria-label="Max output"]') as HTMLInputElement, '8192');
    // …and gives it images through the capabilities popup, like Settings.
    (chatRow?.querySelector('.col-caps .menu-trigger') as HTMLButtonElement).click();
    tick(fixture);
    const imageOption = [...host.querySelectorAll('.local-editor .menu-row')].find((row) =>
      row.textContent?.includes('Vision (images)'),
    ) as HTMLButtonElement;
    imageOption.click();
    tick(fixture);

    button(host, '.editor-actions .primary').click();
    tick(fixture);
    button(host, '.provider-detail .model-pick').click();
    tick(fixture);
    finishFromConnect(fixture, host);
    const create = vi.spyOn(morse, 'createBot');
    button(host, '.board-foot .primary').click();
    tick(fixture);

    const submitted = create.mock.calls[0]?.[0] as BotCreateInput;
    // Written into the bot's own model entries: the window, the cap and the
    // modalities — a text-only default is not assumed for a model the reader
    // said takes images.
    expect(submitted.providers?.[0]?.models).toEqual([
      {
        id: 'acme-chat',
        name: 'Acme Chat',
        contextWindow: 200_000,
        maxTokens: 8_192,
        input: ['image'],
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
    await walkToConnect(fixture, host, 'pi');

    openLocalEditor(host, fixture);
    tick(fixture);
    const discover = vi.spyOn(morse, 'discoverModels');
    button(host, '.editor-discover .ghost').click();
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

    const row = host.querySelector('.local-editor tr.model-main') as HTMLElement;
    // Empty means "nobody knows": the field is dropped, not written as 0.
    type(row.querySelector('input[aria-label="Context limit"]') as HTMLInputElement, '');

    button(host, '.editor-actions .primary').click();
    tick(fixture);
    button(host, '.provider-detail .model-pick').click();
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

  it('limits the thinking levels to the picked model’s own', async () => {
    const { fixture, host, status } = await render();
    status.mockResolvedValue({
      engine: 'pi',
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          description: 'Claude models',
          kind: 'builtin',
          connected: true,
          auth: { key: true },
          models: [
            {
              id: 'claude-sonnet-4',
              name: 'Claude Sonnet 4',
              reasoning: true,
              thinkingLevels: ['low', 'medium'],
              thinking: { low: 'low', medium: 'medium', high: null },
            },
          ],
        },
        {
          id: 'opencode-go',
          name: 'OpenCode Go',
          description: 'GLM models',
          kind: 'builtin',
          connected: true,
          auth: { key: true },
          models: [{ id: 'glm-5.2', name: 'GLM-5.2', thinking: { high: 'high', off: null } }],
        },
      ],
      issues: [],
    });
    button(host, '.provider-toolbar .ghost').click();
    tick(fixture);
    await fixture.whenStable();
    tick(fixture);

    const values = (): string[] =>
      [...host.querySelectorAll('.providers select option')].map(
        (one) => (one as HTMLOptionElement).value,
      );
    // Nothing picked yet: the full engine vocabulary.
    expect(values()).toEqual(['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

    pickFirstModel(host, fixture);
    // Claude declares its own set: only those are offered.
    expect(values()).toEqual(['', 'low', 'medium']);
    choose(host, '.providers select', 'medium');
    tick(fixture);

    // The other provider only declares `high` (via its thinking map): the
    // dropdown narrows and the stale pick falls back to the engine default.
    const go = [...host.querySelectorAll('.provider-grid .card')].find((card) =>
      card.textContent?.includes('OpenCode Go'),
    ) as HTMLButtonElement;
    go.click();
    tick(fixture);
    button(host, '.provider-detail .model-pick').click();
    tick(fixture);
    expect(values()).toEqual(['', 'high']);
    expect((host.querySelector('.providers select') as HTMLSelectElement).value).toBe('');
  });

  it('shows the subagent editor for opencode only', async () => {
    const pi = await render();
    await walkToReview(pi.fixture, pi.host, pi.morse, 'pi');
    expect(pi.host.textContent).not.toContain('Subagents');

    const opencode = await render();
    await walkToReview(opencode.fixture, opencode.host, opencode.morse, 'opencode');
    // The subagent row is on the page for an engine that has them.
    expect(opencode.host.textContent).toContain('Subagents');
    button(opencode.host, '.add-subagent').click();
    tick(opencode.fixture);
    const nameInput = opencode.host.querySelector('.subagent input') as HTMLInputElement;
    expect(nameInput.pattern).toBe('[\\p{L}\\p{N}_][\\p{L}\\p{N}_\\-]*');
  });

  it('assembles the exact BotCreateInput on submit, then waits for the roster', async () => {
    const { fixture, host, morse } = await render();
    await walkToConnect(fixture, host, 'opencode');

    // A key typed into the picked provider's field is committed on blur.
    const key = host.querySelector('.provider-detail input[type="password"]') as HTMLInputElement;
    key.value = 'sk-ant-123';
    key.dispatchEvent(new Event('change'));
    tick(fixture);
    button(host, '.model-pick').click();
    tick(fixture);
    choose(host, '.providers select', 'high');
    tick(fixture);

    finishFromConnect(fixture, host, {
      agentsMd: '# Forge workspace\n',
      subagent: true,
    });

    const create = vi.spyOn(morse, 'createBot');
    const list = vi.spyOn(morse, 'listBots');
    button(host, '.board-foot .primary').click();
    tick(fixture);

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
      requestId: expect.any(String) as unknown as string,
    };
    expect(create).toHaveBeenCalledWith(expected);
    expect(list).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.note')?.textContent).toContain('Forge — waiting for the roster');
    expect(host.querySelector('.row-label')?.textContent).toBeTruthy();
  });

  it('adds an MCP server and sends it on create', async () => {
    const { fixture, host, morse } = await render();
    await walkToConnect(fixture, host, 'pi');
    pickFirstModel(host, fixture);

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
    await walkToReview(fixture, host, morse, 'pi');
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
    await walkToReview(fixture, host, morse, 'pi');
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
    await fixture.whenStable();
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
    expect(host.querySelectorAll('.row').length).toBeGreaterThanOrEqual(5);
    expect(host.querySelector('.model-pick.on')?.textContent).toContain('Claude Sonnet 4');

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

  it('fills bot-only env values from the config, validates them and sends them back', async () => {
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
      envVars: ['ANTHROPIC_API_KEY'],
      env: { ACME_TOKEN: 'secret', REGION: 'eu' },
    });
    tick(fixture);

    const selector = 'textarea[placeholder="ACME_TOKEN=only-this-bot"]';
    expect((host.querySelector(selector) as HTMLTextAreaElement).value).toBe(
      'ACME_TOKEN=secret\nREGION=eu',
    );
    const update = vi.spyOn(morse, 'updateBot');

    fill(host, selector, 'NOT_A_PAIR');
    tick(fixture);
    button(host, '.board-foot .primary').click();
    tick(fixture);
    expect(host.textContent).toContain('Each environment variable needs a KEY=value line.');
    expect(update).not.toHaveBeenCalled();

    fill(host, selector, 'ACME_TOKEN=rotated');
    tick(fixture);
    button(host, '.board-foot .primary').click();
    tick(fixture);
    expect(update.mock.calls[0]?.[0].env).toEqual({ ACME_TOKEN: 'rotated' });
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
      // What the host read out of the bot's own config: no credential, ever.
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
    await fixture.whenStable();
    fixture.detectChanges();

    // The bot's own provider is a card of its own, with its model in the detail.
    const card = [...host.querySelectorAll('.provider-grid .card')].find((one) =>
      one.textContent?.includes('Eigen'),
    ) as HTMLElement;
    expect(card.textContent).toContain('This bot');
    card.click();
    tick(fixture);
    expect(host.querySelector('.provider-detail .model-pick')?.textContent).toContain(
      'deepseek-v4-flash',
    );

    // Correct the limits in the same editor Settings uses.
    button(host, '.detail-actions .secondary').click();
    tick(fixture);
    const row = host.querySelector('.local-editor tr.model-main') as HTMLElement;
    type(row.querySelector('input[aria-label="Context limit"]') as HTMLInputElement, '65536');
    type(row.querySelector('input[aria-label="Max output"]') as HTMLInputElement, '8192');
    (row.querySelector('.col-caps .menu-trigger') as HTMLButtonElement).click();
    tick(fixture);
    const imageOption = [...host.querySelectorAll('.local-editor .menu-row')].find((one) =>
      one.textContent?.includes('Vision (images)'),
    ) as HTMLButtonElement;
    imageOption.click();
    tick(fixture);
    button(host, '.editor-actions .primary').click();
    tick(fixture);

    const update = vi.spyOn(morse, 'updateBot');
    button(host, '.board-foot .primary').click();
    tick(fixture);

    const sent = update.mock.calls[0]?.[0] as { providers?: unknown; credentials?: unknown };
    // The correction goes into the bot's own provider entry, with no
    // credential: the key stays where the engine put it.
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
            input: ['image'],
          },
        ],
      },
    ]);
    expect(sent).not.toHaveProperty('credentials');
  });

  it('keeps the saved model selectable when the catalog lists nothing', async () => {
    const { fixture, host, morse, status } = await render();
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
    await fixture.whenStable();
    fixture.detectChanges();

    // The catalog comes back empty after the edit already chose its model.
    status.mockResolvedValue({ engine: 'pi', providers: [], issues: [] });
    button(host, '.provider-toolbar .ghost').click();
    tick(fixture);
    await fixture.whenStable();
    tick(fixture);

    // Nothing listed, yet the bot's own model stays chosen and the save passes.
    expect(host.querySelector('.model-pick.on')?.textContent).toContain('Claude Sonnet 4');
    expect(button(host, '.board-foot .primary').disabled).toBe(false);
  });

  it('derives the username from the name and validates it live', async () => {
    const { fixture, host } = await render();
    const next = (): HTMLButtonElement => button(host, '.board-foot .primary');

    // Typing a free-text name fills the handle too: 'News Finder' → 'news-finder'.
    fill(host, 'input[placeholder="News Finder"]', 'Forge');
    fill(host, 'textarea[placeholder^="You are Forge"]', 'You are Forge.');
    tick(fixture);
    const handle = host.querySelector('input[placeholder="news-finder"]') as HTMLInputElement;
    expect(handle.value).toBe('forge');
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
    await walkToConnect(fixture, host, 'pi');
    pickFirstModel(host, fixture);
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
    await walkToConnect(fixture, host, 'pi');
    pickFirstModel(host, fixture);
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
    await walkToReview(fixture, host, morse, 'opencode');
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
    await walkToReview(fixture, host, morse, 'opencode');

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
    await walkToReview(fixture, host, morse, 'opencode');

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
