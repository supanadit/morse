import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { BotConversationSummary, BotSummary, ClientToHostMessage } from '@morse/protocol';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { ModePrefs } from '../../state/mode-prefs';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { BotNav } from './bot-nav';

const forge: BotSummary = {
  username: 'forge',
  name: 'Forge',
  description: 'Keeps the forge hot',
  engineKind: 'pi',
  warm: true,
};
const sable: BotSummary = {
  username: 'sable',
  name: 'Sable',
  description: 'Reads the fine print',
  engineKind: 'opencode',
  warm: false,
};
const workshop: BotConversationSummary = {
  id: 'group-workshop',
  kind: 'group',
  title: 'The workshop',
  members: ['forge', 'sable'],
  chainCap: 8,
  updatedAt: 1,
};
const research: BotConversationSummary = {
  id: 'group-research',
  kind: 'group',
  title: 'Research desk',
  members: ['sable'],
  chainCap: 8,
  updatedAt: 2,
};

/** The mock host, plus everything the frontend asked it to do. */
class RecordingHost extends MemoryHostTransport {
  readonly sent: ClientToHostMessage[] = [];

  override send(message: ClientToHostMessage): void {
    this.sent.push(message);
    super.send(message);
  }
}

async function render(options: RenderOptions = {}): Promise<{
  fixture: ComponentFixture<BotNav>;
  host: HTMLElement;
  morse: MorseService;
  prefs: ModePrefs;
  sent: ClientToHostMessage[];
}> {
  TestBed.resetTestingModule();
  const transport = new RecordingHost();
  await TestBed.configureTestingModule({
    imports: [BotNav],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();
  // A remembered conversation is what a reload starts with: the last visit wrote it
  // down before this window existed, so it is on record before the view mounts.
  if (options.rememberedConversation !== undefined) {
    TestBed.inject(ModePrefs).rememberBotConversation(options.rememberedConversation);
  }
  const fixture = TestBed.createComponent(BotNav);
  fixture.detectChanges();
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    morse: TestBed.inject(MorseService),
    prefs: TestBed.inject(ModePrefs),
    sent: transport.sent,
  };
}

/** What a test needs beyond a fresh mount: the conversation the last visit left open. */
interface RenderOptions {
  rememberedConversation?: string;
}

function rows(host: HTMLElement, kind: 'bot' | 'group'): HTMLButtonElement[] {
  return [...host.querySelectorAll(`.row.${kind}`)] as HTMLButtonElement[];
}

/** The names a section is showing, in order. */
function names(host: HTMLElement, kind: 'bot' | 'group'): (string | undefined)[] {
  return [...host.querySelectorAll(`.row.${kind} .name`)].map(
    (one) => one.textContent?.trim() ?? '',
  );
}

/** Right-clicks a row, the way a reader reaches its actions. */
function rightClick(row: HTMLElement): void {
  row.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }),
  );
}

function menuItem(host: HTMLElement, selector: string): HTMLButtonElement {
  const found = host.querySelector(`.context-menu .${selector}`) as HTMLButtonElement | null;
  if (found === null) {
    throw new Error(`no menu item matches ${selector}`);
  }
  return found;
}

function type(host: HTMLElement, value: string): void {
  const input = host.querySelector('.search-input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
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
    expect(groups[0]?.textContent).toContain('Forge, Sable');
  });

  it('opens a bot under the name the host gives its DM', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [] });
    fixture.detectChanges();
    const open = vi.spyOn(morse, 'openBotConversation');

    rows(host, 'bot')[0]?.click();

    expect(open).toHaveBeenCalledWith('dm-forge');
  });

  it('opens a group by its own conversation id', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop] });
    fixture.detectChanges();
    const open = vi.spyOn(morse, 'openBotConversation');

    rows(host, 'group')[0]?.click();

    expect(open).toHaveBeenCalledWith('group-workshop');
  });

  it('writes the open conversation down, so a reload can come back to it', async () => {
    const { fixture, host, morse, prefs } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop] });
    fixture.detectChanges();

    rows(host, 'group')[0]?.click();
    fixture.detectChanges();

    expect(prefs.botConversation()).toBe('group-workshop');
  });

  it('reopens the conversation the page came back to', async () => {
    const { fixture, host, morse } = await render({ rememberedConversation: 'group-research' });
    const open = vi.spyOn(morse, 'openBotConversation');

    // The roster is what says the conversation still exists — it is reopened once
    // it does, not on the strength of the remembered id alone.
    morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop, research] });
    fixture.detectChanges();

    expect(open).toHaveBeenCalledWith('group-research');
    // And the row reads as the open one, so the pair cannot disagree.
    expect(rows(host, 'group')[1]?.classList.contains('active')).toBe(true);
  });

  it('forgets a remembered conversation the host no longer lists', async () => {
    const { fixture, morse, prefs } = await render({ rememberedConversation: 'group-gone' });
    const open = vi.spyOn(morse, 'openBotConversation');

    morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop] });
    fixture.detectChanges();

    // A conversation deleted while the page was shut must not be reopened into an
    // empty room, and it must not be remembered for the next visit either.
    expect(open).not.toHaveBeenCalled();
    expect(prefs.botConversation()).toBeNull();
  });

  it('filters bots and groups as the reader types, and restores on clear', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop, research] });
    fixture.detectChanges();

    type(host, 'sab');
    fixture.detectChanges();
    expect(names(host, 'bot')).toEqual(['Sable']);
    // Sable is in both groups, so both stay — membership is searchable too.
    expect(names(host, 'group')).toEqual(['The workshop', 'Research desk']);

    type(host, 'workshop');
    fixture.detectChanges();
    expect(rows(host, 'bot')).toHaveLength(0);
    expect(names(host, 'group')).toEqual(['The workshop']);

    type(host, 'nothing-matches-this');
    fixture.detectChanges();
    expect(host.querySelectorAll('.empty')).toHaveLength(2);
    expect(host.querySelector('.empty')?.textContent).toContain('No bots match');

    (host.querySelector('.search-clear') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(rows(host, 'bot')).toHaveLength(2);
    expect(rows(host, 'group')).toHaveLength(2);
  });

  it('opens a row menu from a right-click and from its action button', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop] });
    fixture.detectChanges();

    rightClick(rows(host, 'bot')[0] as HTMLElement);
    fixture.detectChanges();
    expect(host.querySelector('.context-menu')).not.toBeNull();
    expect(menuItem(host, 'delete-bot')).not.toBeNull();

    // The overlay behind the menu dismisses it.
    (host.querySelector('.context-menu-layer') as HTMLElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.context-menu')).toBeNull();

    // The `⋯` opens the same menu for a group.
    (host.querySelectorAll('.row-more')[2] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.context-menu')?.textContent).toContain('New discussion');
  });

  it('starts a new discussion on the row the menu belongs to', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop] });
    fixture.detectChanges();
    const reset = vi.spyOn(morse, 'newBotDiscussion');

    rightClick(rows(host, 'group')[0] as HTMLElement);
    fixture.detectChanges();
    [...host.querySelectorAll('.context-menu-item')]
      .find((one) => one.textContent?.includes('New discussion'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    expect(reset).toHaveBeenCalledWith('group-workshop');
    expect(host.querySelector('.context-menu')).toBeNull();
  });

  it('deletes a bot through the menu, naming it in the confirmation', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [] });
    fixture.detectChanges();
    const remove = vi.spyOn(morse, 'deleteBot');

    rightClick(rows(host, 'bot')[0] as HTMLElement);
    fixture.detectChanges();
    menuItem(host, 'delete-bot').click();
    fixture.detectChanges();

    // The confirmation lives in the menu; nothing is deleted until it is taken.
    expect(host.querySelector('.context-menu-title')?.textContent).toContain('Forge');
    expect(remove).not.toHaveBeenCalled();

    [...host.querySelectorAll('.context-menu-item')]
      .find((one) => one.textContent?.trim() === 'Delete bot')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(remove).toHaveBeenCalledWith('forge');
  });

  it('cancels the delete from the confirmation', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [] });
    fixture.detectChanges();
    const remove = vi.spyOn(morse, 'deleteBot');

    rightClick(rows(host, 'bot')[0] as HTMLElement);
    fixture.detectChanges();
    menuItem(host, 'delete-bot').click();
    fixture.detectChanges();
    [...host.querySelectorAll('.context-menu-item')]
      .find((one) => one.textContent?.trim() === 'Cancel')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    expect(remove).not.toHaveBeenCalled();
    expect(host.querySelector('.context-menu')).toBeNull();
  });

  it('opens the wizard for the bot its menu asked to edit', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [] });
    fixture.detectChanges();
    const inspect = vi.spyOn(morse, 'inspectBot');

    rightClick(rows(host, 'bot')[1] as HTMLElement);
    fixture.detectChanges();
    menuItem(host, 'edit-bot').click();
    fixture.detectChanges();

    // The wizard is opened on that bot, and the host is asked for its record.
    expect(inspect).toHaveBeenCalledWith('sable');
    expect(morse.ui.wizardTarget()).toBe('sable');
    expect(morse.ui.wizardOpen()).toBe(true);
    expect(host.querySelector('.context-menu')).toBeNull();
  });

  it('refuses to edit a bot that is answering', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [] });
    morse.bot.onRouting({ conversationId: 'dm-forge', target: 'Forge', queued: [] });
    fixture.detectChanges();

    rightClick(rows(host, 'bot')[0] as HTMLElement);
    fixture.detectChanges();

    expect(menuItem(host, 'edit-bot').disabled).toBe(true);
  });

  it('opens a new bot with no edit target after editing one', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [] });
    fixture.detectChanges();

    rightClick(rows(host, 'bot')[0] as HTMLElement);
    fixture.detectChanges();
    menuItem(host, 'edit-bot').click();
    fixture.detectChanges();
    expect(morse.ui.wizardTarget()).toBe('forge');

    (host.querySelector('.create-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    menuItem(host, 'new-bot').click();

    // A new bot must not inherit the bot that was being edited.
    expect(morse.ui.wizardTarget()).toBeNull();
    expect(morse.ui.wizardOpen()).toBe(true);
  });

  it('refuses to delete a bot that is answering', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [] });
    morse.bot.onRouting({ conversationId: 'dm-forge', target: 'Forge', queued: [] });
    fixture.detectChanges();

    // Forge's row is mid-round, Sable's is not.
    rightClick(rows(host, 'bot')[0] as HTMLElement);
    fixture.detectChanges();
    expect(menuItem(host, 'delete-bot').disabled).toBe(true);

    (host.querySelector('.context-menu-layer') as HTMLElement).click();
    fixture.detectChanges();
    rightClick(rows(host, 'bot')[1] as HTMLElement);
    fixture.detectChanges();
    expect(menuItem(host, 'delete-bot').disabled).toBe(false);
  });

  it('highlights the conversation in front', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [workshop] });
    morse.bot.open('dm-forge');
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

  it('opens both creation dialogs from the + menu', async () => {
    const { fixture, host, morse } = await render();

    (host.querySelector('.create-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    menuItem(host, 'new-bot').click();
    expect(morse.ui.wizardOpen()).toBe(true);
    expect(morse.ui.groupOpen()).toBe(false);

    morse.ui.wizardOpen.set(false);
    (host.querySelector('.create-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    menuItem(host, 'new-group').click();
    fixture.detectChanges();
    expect(morse.ui.groupOpen()).toBe(true);
    expect(morse.ui.wizardOpen()).toBe(false);
    // Choosing an entry closes the menu behind it.
    expect(host.querySelector('.context-menu')).toBeNull();
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
