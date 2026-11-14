import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type {
  BotConversationSummary,
  BotSummary,
  BotTranscriptEntry,
  ClientToHostMessage,
} from '@morse/protocol';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { BotChat } from './bot-chat';

const forge: BotSummary = {
  username: 'forge',
  name: 'Forge',
  description: 'Keeps the forge hot',
  avatar: 'F',
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
const dm: BotConversationSummary = {
  id: 'dm-forge',
  kind: 'dm',
  title: 'Forge',
  members: ['forge'],
  chainCap: 8,
  updatedAt: 1,
};
const workshop: BotConversationSummary = {
  id: 'group-workshop',
  kind: 'group',
  title: 'The workshop',
  members: ['forge', 'sable'],
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

async function render(): Promise<{
  fixture: ComponentFixture<BotChat>;
  host: HTMLElement;
  morse: MorseService;
  sent: ClientToHostMessage[];
}> {
  TestBed.resetTestingModule();
  const transport = new RecordingHost();
  await TestBed.configureTestingModule({
    imports: [BotChat],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => transport }],
  }).compileComponents();
  const fixture = TestBed.createComponent(BotChat);
  fixture.detectChanges();
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    morse: TestBed.inject(MorseService),
    sent: transport.sent,
  };
}

function entry(id: string, author: BotTranscriptEntry['author'], text: string): BotTranscriptEntry {
  return { id, author, text, at: 1 };
}

/** A conversation in front, with the lines the test wants to read. */
function open(
  morse: MorseService,
  conversation: BotConversationSummary,
  entries: BotTranscriptEntry[],
): void {
  morse.bot.onRoster({ bots: [forge, sable], conversations: [dm, workshop] });
  morse.bot.open(conversation.id);
  morse.bot.onTranscript({ conversationId: conversation.id, entries, replace: true });
}

describe('BotChat', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('renders each author as its own row, with the bot answer as markdown', async () => {
    const { fixture, host, morse } = await render();
    open(morse, dm, [
      entry('1', { role: 'user' }, 'Hello Forge'),
      entry('2', { role: 'bot', name: 'Forge', avatar: 'F' }, 'The **forge** is hot.'),
      entry('3', { role: 'system' }, 'Round stopped.'),
    ]);
    fixture.detectChanges();

    const user = host.querySelector('.entry.user') as HTMLElement;
    expect(user.textContent).toContain('Hello Forge');

    const bot = host.querySelector('.entry.bot') as HTMLElement;
    expect(bot.querySelector('.avatar')?.textContent?.trim()).toBe('F');
    expect(bot.querySelector('.author')?.textContent?.trim()).toBe('Forge');
    // The shared markdown renderer, not a copy: the emphasis became an element.
    expect(bot.querySelector('.text strong')?.textContent).toBe('forge');

    const system = host.querySelector('.entry.system') as HTMLElement;
    expect(system.textContent).toContain('Round stopped.');
  });

  it('keeps the lines of the conversation in front, not another one', async () => {
    const { fixture, host, morse } = await render();
    open(morse, dm, [entry('1', { role: 'user' }, 'Forge, are you there?')]);
    morse.bot.onTranscript({
      conversationId: workshop.id,
      entries: [entry('9', { role: 'user' }, 'Workshop line')],
      replace: true,
    });
    fixture.detectChanges();

    expect(host.querySelector('.transcript')?.textContent).toContain('Forge, are you there?');
    expect(host.querySelector('.transcript')?.textContent).not.toContain('Workshop line');
  });

  it('shows whom the host is asking, and whom it queued behind them', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    fixture.detectChanges();
    expect(host.querySelector('.routing')).toBeNull();

    morse.bot.onRouting({ conversationId: workshop.id, target: 'Forge', queued: ['Sable'] });
    fixture.detectChanges();

    const strip = host.querySelector('.routing') as HTMLElement;
    expect(strip.querySelector('.asking')?.textContent?.trim()).toBe('Asking Forge…');
    expect(strip.querySelector('.queued')?.textContent).toContain('Sable');

    morse.bot.onRouting(null);
    fixture.detectChanges();
    expect(host.querySelector('.routing')).toBeNull();
  });

  it('does not show another conversation’s round', async () => {
    const { fixture, host, morse } = await render();
    open(morse, dm, []);

    morse.bot.onRouting({ conversationId: workshop.id, target: 'Sable', queued: [] });
    fixture.detectChanges();

    expect(host.querySelector('.routing')).toBeNull();
  });

  it('stops the round in flight, and only offers it while one is set', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    fixture.detectChanges();
    expect(host.querySelector('.stop')).toBeNull();

    morse.bot.onRouting({ conversationId: workshop.id, target: 'Forge', queued: [] });
    fixture.detectChanges();
    const stop = vi.spyOn(morse, 'stopBotRound');

    (host.querySelector('.stop') as HTMLButtonElement).click();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('asks before starting a new discussion, then resets the sessions', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, [entry('1', { role: 'user' }, 'hi')]);
    fixture.detectChanges();
    const reset = vi.spyOn(morse, 'newBotDiscussion');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    (host.querySelector('.new-discussion') as HTMLButtonElement).click();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('keeps the discussion when the confirmation is declined', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    fixture.detectChanges();
    const reset = vi.spyOn(morse, 'newBotDiscussion');
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    (host.querySelector('.new-discussion') as HTMLButtonElement).click();

    expect(reset).not.toHaveBeenCalled();
  });

  it('sends from the composer as a bot line, with the conversation named in the box', async () => {
    const { fixture, host, morse, sent } = await render();
    open(morse, workshop, []);
    fixture.detectChanges();

    const composer = host.querySelector('morse-chat-composer') as HTMLElement &
      Record<string, unknown>;
    const box = composer.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement;
    expect(box.placeholder).toBe('Message The workshop…');
    // Bot mode has no session pickers in the shared composer.
    expect(composer.querySelector('.model-button')).toBeNull();

    box.value = '@all stand-up';
    box.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(sent.filter((message) => message.type === 'bot/send')).toEqual([
      { type: 'bot/send', payload: { conversationId: workshop.id, text: '@all stand-up' } },
    ]);
  });

  it('draws a discussion boundary as a divider, so sessions stay readable', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [dm] });
    morse.bot.open(dm.id);
    morse.bot.onTranscript({
      conversationId: dm.id,
      entries: [
        entry('u1', { role: 'user' }, 'hi'),
        entry('d1', { role: 'discussion' }, 'New discussion'),
        entry('u2', { role: 'user' }, 'again'),
      ],
      replace: true,
      hasMore: false,
    });
    fixture.detectChanges();

    const divider = host.querySelector('.entry.divider');
    expect(divider).not.toBeNull();
    expect(divider?.textContent).toContain('New discussion');
    // One chat, two engine sessions: the divider sits between the lines.
    const order = [...host.querySelectorAll('.transcript [data-entry-id]')].map((one) =>
      one.getAttribute('data-entry-id'),
    );
    expect(order).toEqual(['u1', 'd1', 'u2']);
  });

  it('asks for older entries when the reader scrolls to the top', async () => {
    const { fixture, host, morse, sent } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [dm] });
    morse.bot.open(dm.id);
    morse.bot.onTranscript({
      conversationId: dm.id,
      entries: [entry('u2', { role: 'user' }, 'newest')],
      replace: true,
      hasMore: true,
    });
    fixture.detectChanges();
    expect(host.querySelector('[data-loading-older]')).not.toBeNull();

    const log = host.querySelector('.transcript') as HTMLElement;
    log.scrollTop = 0;
    log.dispatchEvent(new Event('scroll'));

    // The oldest line held is the cursor: the host answers with what precedes it.
    expect(sent.filter((one) => one.type === 'bot/history')).toEqual([
      { type: 'bot/history', payload: { conversationId: dm.id, before: 'u2' } },
    ]);
  });

  it('reserves the floating composer height, so no line hides behind the glass', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [dm] });
    morse.bot.open(dm.id);
    morse.bot.onTranscript({
      conversationId: dm.id,
      entries: [entry('u1', { role: 'user' }, 'hi')],
      replace: true,
    });
    fixture.detectChanges();

    // The dock is measured into a custom property the transcript and the dock
    // itself read — the same mechanism code mode uses, so the slab floats over the
    // conversation instead of taking a row of it.
    const chat = host.querySelector('.chat') as HTMLElement;
    expect(chat.style.getPropertyValue('--morse-dock-height')).toMatch(/^\d+px$/);
    expect(host.querySelector('.composer-host')).not.toBeNull();
  });

  it('says so when no conversation is open', async () => {
    const { host } = await render();

    const empty = host.querySelector('.bot-chat-placeholder') as HTMLElement;
    expect(empty.textContent).toContain('No conversation open');
    expect(host.querySelector('morse-chat-composer')).toBeNull();
  });
});
