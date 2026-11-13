import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type {
  BotConversationSummary,
  BotSummary,
  ClientToHostMessage,
} from '@morse/protocol';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { BotNav } from './bot-nav';

const forge: BotSummary = {
  name: 'Forge',
  description: 'Keeps the forge hot',
  engineKind: 'pi',
  warm: true,
};
const sable: BotSummary = {
  name: 'Sable',
  description: 'Reads the fine print',
  engineKind: 'opencode',
  warm: false,
};
const workshop: BotConversationSummary = {
  id: 'group-workshop',
  kind: 'group',
  title: 'The workshop',
  members: ['Forge', 'Sable'],
  chainCap: 8,
  updatedAt: 1,
};

/** The mock host, plus everything the frontend asked it to do. */
class RecordingHost extends MemoryHostTransport {
  readonly sent: ClientToHostMessage[] = [];

  override send(message: ClientToHostMessage): void {
    this.sent.push(message);
    super.send(message);
  }
}

async function render(): Promise<{
  fixture: ComponentFixture<BotNav>;
  host: HTMLElement;
  morse: MorseService;
  sent: ClientToHostMessage[];
}> {
  TestBed.resetTestingModule();
  const transport = new RecordingHost();
  await TestBed.configureTestingModule({
    imports: [BotNav],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(BotNav);
  fixture.detectChanges();
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    morse: TestBed.inject(MorseService),
    sent: transport.sent,
  };
}

function rows(host: HTMLElement, kind: 'bot' | 'group'): HTMLButtonElement[] {
  return [...host.querySelectorAll(`.row.${kind}`)] as HTMLButtonElement[];
}

describe('BotNav', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('lists every bot with its description and its presence', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop] });
    fixture.detectChanges();

    const bots = rows(host, 'bot');
    expect(bots).toHaveLength(2);
    expect(bots[0]?.textContent).toContain('Forge');
    expect(bots[0]?.textContent).toContain('Keeps the forge hot');
    // A warm bot's engine is running; a cold one starts on the first message.
    expect(bots[0]?.querySelector('.presence.warm')).not.toBeNull();
    expect(bots[1]?.querySelector('.presence.warm')).toBeNull();

    const groups = rows(host, 'group');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.textContent).toContain('The workshop');
  });

  it('opens a bot under the name the host gives its DM', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [] });
    fixture.detectChanges();
    const open = vi.spyOn(morse, 'openBotConversation');

    rows(host, 'bot')[0]?.click();

    expect(open).toHaveBeenCalledWith('dm-Forge');
  });

  it('opens a group by its own conversation id', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop] });
    fixture.detectChanges();
    const open = vi.spyOn(morse, 'openBotConversation');

    rows(host, 'group')[0]?.click();

    expect(open).toHaveBeenCalledWith('group-workshop');
  });

  it('deletes a bot after the confirm names exactly what is removed', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [] });
    fixture.detectChanges();
    const remove = vi.spyOn(morse, 'deleteBot');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    (host.querySelector('.delete-bot') as HTMLButtonElement).click();

    expect(confirm).toHaveBeenCalledWith(
      'Delete bot Forge? Its config, sessions and workspace are removed.',
    );
    expect(remove).toHaveBeenCalledWith('Forge');
  });

  it('does not delete when the confirm is declined', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [] });
    fixture.detectChanges();
    const remove = vi.spyOn(morse, 'deleteBot');
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    (host.querySelector('.delete-bot') as HTMLButtonElement).click();

    expect(remove).not.toHaveBeenCalled();
  });

  it('hides the delete affordance while that bot is answering', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [] });
    morse.bot.onRouting({ conversationId: 'dm-Forge', target: 'Forge', queued: [] });
    fixture.detectChanges();

    const buttons = [...host.querySelectorAll('.delete-bot')];
    // Forge's row is mid-round; Sable's is not.
    expect(buttons).toHaveLength(1);
    expect(host.querySelectorAll('.bot-row')[0]?.querySelector('.delete-bot')).toBeNull();
  });

  it('highlights the conversation in front', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop] });
    morse.bot.open('dm-Forge');
    fixture.detectChanges();

    const bots = rows(host, 'bot');
    expect(bots[0]?.classList.contains('active')).toBe(true);
    expect(bots[0]?.getAttribute('aria-current')).toBe('true');
    expect(bots[1]?.classList.contains('active')).toBe(false);
  });

  it('asks the host for the roster when nothing is loaded yet', async () => {
    const { sent } = await render();

    // Bot mode can be entered before any roster push has arrived (a fresh
    // window), so the sidebar is the one that asks — once.
    expect(sent.filter((message) => message.type === 'bot/list')).toHaveLength(1);
  });

  it('opens the New bot dialog from its button', async () => {
    const { host, morse } = await render();

    (host.querySelector('.new-bot') as HTMLButtonElement).click();

    expect(morse.ui.wizardOpen()).toBe(true);
    expect(morse.ui.groupOpen()).toBe(false);
  });

  it('opens the New group dialog from its button', async () => {
    const { host, morse } = await render();

    (host.querySelector('.new-group') as HTMLButtonElement).click();

    expect(morse.ui.groupOpen()).toBe(true);
    expect(morse.ui.wizardOpen()).toBe(false);
  });

  it('says so quietly while the roster is empty', async () => {
    const { fixture, host, morse } = await render();

    // Nothing has been pushed yet: the empty state names that, it does not
    // pretend the reader has no bots.
    expect(host.querySelector('.empty')?.textContent).toContain('Loading');

    morse.bot.onRoster({ bots: [], conversations: [] });
    fixture.detectChanges();
    expect(host.querySelector('.empty')?.textContent).toContain('No bots yet');
  });
});
