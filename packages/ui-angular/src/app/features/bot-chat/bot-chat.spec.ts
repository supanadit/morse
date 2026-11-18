import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type {
  BotActivity,
  BotConversationSummary,
  BotHandoff,
  BotRoutingActive,
  BotRoutingState,
  BotSummary,
  BotTranscriptEntry,
  BotTurnTrace,
  ClientToHostMessage,
} from '@morse/protocol';
import { clockTime, fullTime, MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { AttachmentStore } from '../../state/attachments';
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

/**
 * One routing push as the host sends it: the conversation on the envelope and the
 * round inside. Kept as a helper because every test below is about the round, and
 * the envelope is the same in all of them.
 */
function round(
  conversationId: string,
  state: Omit<BotRoutingState, 'conversationId'> | null,
): { conversationId: string; state: BotRoutingState | null } {
  return {
    conversationId,
    state: state === null ? null : { conversationId, ...state },
  };
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

function entry(
  id: string,
  author: BotTranscriptEntry['author'],
  text: string,
  at = 1,
): BotTranscriptEntry {
  return { id, author, text, at };
}

/** Types into the composer's prompt, the way a reader does while `@` is open. */
function mentionInto(fixture: ComponentFixture<BotChat>, host: HTMLElement, text: string): void {
  const box = host.querySelector('textarea[aria-label="Prompt"]') as HTMLTextAreaElement;
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
}

/** A finished turn, worded the way the host keeps it. */
function turn(overrides: Partial<BotTurnTrace> = {}): BotTurnTrace {
  return {
    id: 'delivery-1',
    conversationId: 'dm-forge',
    username: 'sigil',
    name: 'Sigil',
    startedAt: 0,
    endedAt: 100,
    status: 'done',
    steps: [],
    handoffs: [],
    ...overrides,
  };
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

/**
 * One live row as the host pushes it: the current step, what has been written so
 * far and the asks this turn handed on.
 */
function live(overrides: Partial<BotRoutingActive> = {}): BotRoutingActive {
  const activity: BotActivity = overrides.activity ?? {
    kind: 'thinking',
    label: 'Wait, let me think…',
    at: 1_000,
  };
  return {
    target: 'Forge',
    username: 'forge',
    activity,
    startedAt: activity.at,
    steps: [activity],
    handoffs: [],
    ...overrides,
  };
}

describe('BotChat', () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it('draws a finished turn above its answer', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [dm] });
    morse.bot.open(dm.id);
    morse.bot.onTranscript({
      conversationId: dm.id,
      entries: [
        entry('u1', { role: 'user' }, 'what changed?', 50),
        entry(
          'a1',
          { role: 'bot', name: 'Sigil', username: 'sigil', avatar: 'S' },
          'The **tests** pass.',
          120,
        ),
      ],
      replace: true,
      traces: [
        turn({
          // The host appends the answer and only then stamps the trace, so the
          // turn's end follows the line it produced.
          startedAt: 90,
          endedAt: 130,
          steps: [
            { kind: 'thinking', label: 'Reading the brief…', at: 10, status: 'ok' },
            {
              kind: 'tool',
              label: 'Running the tests…',
              tool: 'bash',
              at: 40,
              status: 'error',
              error: 'exit code 1',
            },
          ],
          handoffs: [
            {
              username: 'loom',
              conversationId: 'thread-sigil-loom',
              deliveryId: 'delivery-2',
              at: 60,
              state: 'done',
            },
          ],
        }),
      ],
    });
    fixture.detectChanges();

    // The line is one gesture, named by the name the turn was written with — Sigil
    // is not in this roster, so resolving the roster would draw nothing.
    const turnRow = host.querySelector('.turn') as HTMLElement;
    const summary = turnRow.querySelector('.turn-line') as HTMLButtonElement;
    expect(turnRow.querySelector('.turn-summary')?.textContent?.trim()).toBe(
      'Sigil · 0s · 2 steps · asked @loom',
    );
    expect(summary.getAttribute('aria-expanded')).toBe('false');

    // The turn sits above the answer it produced, not after it: the reader sees
    // how the work went before reading what it wrote.
    const order = [...host.querySelectorAll('.transcript > .entry')].map((one) =>
      one.classList.contains('turn')
        ? one.getAttribute('data-trace-id')
        : one.getAttribute('data-entry-id'),
    );
    expect(order).toEqual(['u1', 'delivery-1', 'a1']);

    // Expanding opens the record: each step's words and outcome, the failure's own
    // text, and the ask as a link back to the conversation it happened in.
    summary.click();
    fixture.detectChanges();
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(turnRow.textContent).toContain('Reading the brief…');
    expect(turnRow.textContent).toContain('ok');
    expect(turnRow.textContent).toContain('Running the tests…');
    expect(turnRow.querySelector('.step-error')?.textContent?.trim()).toBe('exit code 1');

    const open = vi.spyOn(morse, 'openBotConversation');
    (turnRow.querySelector('.handoff') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith('thread-sigil-loom');
  });

  it('puts each finished turn above its own answer, not both above the first', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [dm] });
    morse.bot.open(dm.id);
    morse.bot.onTranscript({
      conversationId: dm.id,
      entries: [
        entry('a1', { role: 'bot', name: 'Sigil', username: 'sigil' }, 'The first answer.', 120),
        entry('u2', { role: 'user' }, 'and then?', 140),
        entry('a2', { role: 'bot', name: 'Sigil', username: 'sigil' }, 'The second answer.', 180),
      ],
      replace: true,
      traces: [
        // Each trace ends after its own answer; the spans do not overlap, so the
        // handle alone cannot tell them apart — the window does.
        turn({ id: 'turn-1', startedAt: 90, endedAt: 130 }),
        turn({ id: 'turn-2', startedAt: 150, endedAt: 190 }),
      ],
    });
    fixture.detectChanges();

    const order = [...host.querySelectorAll('.transcript > .entry')].map((one) =>
      one.classList.contains('turn')
        ? one.getAttribute('data-trace-id')
        : one.getAttribute('data-entry-id'),
    );
    expect(order).toEqual(['turn-1', 'a1', 'u2', 'turn-2', 'a2']);
  });

  it('keeps a turn with no answer in place by when it ended', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [dm] });
    morse.bot.open(dm.id);
    morse.bot.onTranscript({
      conversationId: dm.id,
      entries: [
        entry('u1', { role: 'user' }, 'before', 100),
        entry('u2', { role: 'user' }, 'after', 200),
      ],
      replace: true,
      traces: [turn({ id: 'stopped', status: 'cancelled', startedAt: 110, endedAt: 150 })],
    });
    fixture.detectChanges();

    // A cancelled turn wrote no line, so nothing anchors it: it falls where it
    // ended, still drawn and still in the transcript's own order.
    const order = [...host.querySelectorAll('.transcript > .entry')].map((one) =>
      one.classList.contains('turn')
        ? one.getAttribute('data-trace-id')
        : one.getAttribute('data-entry-id'),
    );
    expect(order).toEqual(['u1', 'stopped', 'u2']);
    expect(host.querySelector('.turn-line')).not.toBeNull();
  });

  it('draws a finished turn that recorded no steps and no handoffs', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge], conversations: [dm] });
    morse.bot.open(dm.id);
    morse.bot.onTranscript({
      conversationId: dm.id,
      entries: [entry('a1', { role: 'bot', name: 'Sigil' }, 'Nothing to report.', 120)],
      replace: true,
      traces: [turn({ status: 'cancelled', steps: [], handoffs: [] })],
    });
    fixture.detectChanges();

    const summary = host.querySelector('.turn-line') as HTMLButtonElement;
    // Duration is always shown, even when it rounds to none: a cancelled turn is
    // still a turn, and its record still says how long it ran.
    expect(host.querySelector('.turn-summary')?.textContent?.trim()).toBe('Sigil · 0s · 0 steps');

    summary.click();
    fixture.detectChanges();
    expect(host.querySelector('.turn')?.textContent).toContain('No steps were recorded');
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

  it('lists the room’s members when @ is typed, handles and names together', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    fixture.detectChanges();
    mentionInto(fixture, host, '@');

    const picker = host.querySelector('morse-mention-picker') as HTMLElement;
    expect(picker).not.toBeNull();
    // The people first; the broadcast words are the second section below them.
    expect([...picker.querySelectorAll('.handle')].map((one) => one.textContent?.trim())).toEqual([
      '@forge',
      '@sable',
      '@all',
      '@everyone',
    ]);
    // The name travels with the handle: nobody remembers `@sable` on sight.
    expect([...picker.querySelectorAll('.name')].map((one) => one.textContent?.trim())).toEqual([
      'Forge',
      'Sable',
    ]);
  });

  it('offers the broadcast words in a group, and not in a direct message', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    fixture.detectChanges();
    mentionInto(fixture, host, '@');

    expect(host.querySelector('morse-mention-picker')?.textContent).toContain('Special mentions');
    const handles = [
      ...(host.querySelector('morse-mention-picker') as HTMLElement).querySelectorAll('.handle'),
    ].map((one) => one.textContent?.trim());
    expect(handles).toEqual(['@forge', '@sable', '@all', '@everyone']);

    // A direct message has one member, so a broadcast word would mean what a
    // plain line already does.
    open(morse, dm, []);
    fixture.detectChanges();
    mentionInto(fixture, host, '@');
    expect(host.querySelector('morse-mention-picker')?.textContent).not.toContain(
      'Special mentions',
    );
  });

  it('shows what the reader attached, and sends it on with the line', async () => {
    const { fixture, host, morse } = await render();
    open(morse, dm, [
      {
        id: '1',
        author: { role: 'user' },
        text: 'what is wrong with this?',
        at: 1,
        images: [{ data: 'aW1n', mimeType: 'image/png' }],
        files: ['cv.pdf'],
      },
    ]);
    fixture.detectChanges();

    // The reader's own bubble keeps what they sent: a thumbnail and a file chip.
    const bubble = host.querySelector('.entry.user .bubble') as HTMLElement;
    expect(bubble.querySelector('.sent-image')?.getAttribute('src')).toBe(
      'data:image/png;base64,aW1n',
    );
    expect(bubble.querySelector('.sent-file')?.textContent?.trim()).toBe('cv.pdf');
    expect(bubble.textContent).toContain('what is wrong with this?');
  });

  it('keeps the bot draft and its attachments out of the code session behind it', async () => {
    const { fixture, morse } = await render();
    const attachments = TestBed.inject(AttachmentStore);
    // The code session in front is editing its own draft while bot mode is open.
    attachments.use('session-code');
    open(morse, dm, []);
    fixture.detectChanges();

    await attachments.acceptFiles([
      new File(['img'], 'shot.png', { type: 'image/png' }),
      new File(['file'], 'cv.pdf', { type: 'application/pdf' }),
    ]);
    fixture.detectChanges();

    // The bot message owns them: the code session's composer stays empty.
    expect(attachments.isEmpty('session-code')).toBe(true);
    expect(attachments.isEmpty('bot:dm-forge')).toBe(false);
  });

  it('draws the round where the answer will land, and takes it away again', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, [entry('1', { role: 'user' }, 'plan the launch')]);
    fixture.detectChanges();
    expect(host.querySelector('.acting')).toBeNull();

    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          {
            target: 'Forge',
            username: 'forge',
            activity: { kind: 'tool', label: 'Reading launch-brief.md…', tool: 'read', at: 10 },
            startedAt: 10,
            steps: [{ kind: 'tool', label: 'Reading launch-brief.md…', tool: 'read', at: 10 }],
            handoffs: [],
          },
        ],
        queued: ['Sable'],
      }),
    );
    fixture.detectChanges();

    const row = host.querySelector('.transcript .acting') as HTMLElement;
    expect(row.querySelector('.doing-label')?.textContent?.trim()).toBe('Reading launch-brief.md…');
    expect(row.querySelector('.author')?.textContent?.trim()).toBe('Forge');
    expect(row.querySelector('.queued')?.textContent).toContain('Sable');
    // Presence, not history: the row is not a line anyone scrolls back to.
    expect(host.querySelectorAll('.transcript .entry:not(.acting)').length).toBe(1);

    morse.bot.onRouting(round(workshop.id, null));
    fixture.detectChanges();
    expect(host.querySelector('.acting')).toBeNull();
    expect(host.querySelector('.transcript')?.textContent).toContain('plan the launch');
    expect(host.querySelector('.transcript')?.textContent).not.toContain('Reading launch-brief.md');
  });

  it('replaces the line as the bot moves on, and animates the new one', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);

    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          {
            target: 'Forge',
            username: 'forge',
            activity: { kind: 'thinking', label: 'Wait, let me think…', at: 20 },
            startedAt: 20,
            steps: [{ kind: 'thinking', label: 'Wait, let me think…', at: 20 }],
            handoffs: [],
          },
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();
    const first = host.querySelector('.acting .doing-label') as HTMLElement;

    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          {
            target: 'Forge',
            username: 'forge',
            activity: { kind: 'writing', label: 'Writing the answer…', at: 21 },
            startedAt: 21,
            steps: [{ kind: 'writing', label: 'Writing the answer…', at: 21 }],
            handoffs: [],
          },
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();

    const second = host.querySelector('.acting .doing-label') as HTMLElement;
    expect(second.textContent?.trim()).toBe('Writing the answer…');
    // A new node, so the row's entrance animation replays rather than the words
    // quietly swapping inside a node that never moved.
    expect(second).not.toBe(first);
  });

  it('shows what the bot is doing now, how long it has run, and the words already written', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const words = 'Tally is the one that survives being said out loud';
    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          live({
            startedAt: 62_000,
            partial: words,
            activity: { kind: 'writing', label: 'Writing the answer…', at: 70_000 },
            steps: [
              { kind: 'thinking', label: 'Wait, let me think…', at: 63_000, status: 'ok' },
              { kind: 'writing', label: 'Writing the answer…', at: 70_000 },
            ],
          }),
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();

    const row = host.querySelector('.acting') as HTMLElement;
    expect(row.querySelector('.doing-label')?.textContent?.trim()).toBe('Writing the answer…');
    // The timer is hidden while the turn is young and counts once it is not.
    expect(row.querySelector('.elapsed')?.textContent?.trim()).toBe('38s');
    // Nothing is revealed before the first tick: the row starts at the beginning.
    expect(row.querySelector('.partial')).toBeNull();

    vi.advanceTimersByTime(50);
    fixture.detectChanges();
    const first = host.querySelector('.acting .partial')?.textContent ?? '';
    expect(first.length).toBeGreaterThan(0);
    expect(words.startsWith(first)).toBe(true);

    vi.advanceTimersByTime(1_000);
    fixture.detectChanges();
    const later = host.querySelector('.acting .partial')?.textContent ?? '';
    expect(later.length).toBeGreaterThan(first.length);
    expect(words.startsWith(later)).toBe(true);
    expect(later.length).toBeLessThanOrEqual(words.length);
  });

  it('starts a turn’s words over when the bot begins a new one', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    morse.bot.onRouting(
      round(workshop.id, {
        active: [live({ partial: 'Tally is the one that survives being said out loud' })],
        queued: [],
      }),
    );
    fixture.detectChanges();
    vi.advanceTimersByTime(200);
    fixture.detectChanges();
    expect(host.querySelector('.acting .partial')?.textContent?.length).toBeGreaterThan(0);

    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          live({
            startedAt: 99_500,
            activity: { kind: 'writing', label: 'Writing the answer…', at: 99_500 },
            partial: 'A completely different answer',
          }),
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();

    // Not one word of the new turn before its first tick: the cursor was the old
    // turn's, and borrowing it would put words on screen the reader never waited for.
    expect(host.querySelector('.acting .partial')).toBeNull();
  });

  it('stops revealing at the end, and forgets the words when the row goes away', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    morse.bot.onRouting(
      round(workshop.id, {
        active: [live({ partial: 'a '.repeat(300) })],
        queued: [],
      }),
    );
    fixture.detectChanges();
    vi.advanceTimersByTime(50);
    fixture.detectChanges();
    expect(host.querySelector('.acting .partial')?.textContent?.length).toBeGreaterThan(0);

    // The row leaves while there is still text unread: its clock and its reveal
    // stop with it, rather than ticking into a conversation it no longer belongs to.
    const clear = vi.spyOn(globalThis, 'clearInterval');
    morse.bot.onRouting(round(workshop.id, null));
    fixture.detectChanges();
    expect(host.querySelector('.acting')).toBeNull();
    expect(clear).toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    fixture.detectChanges();
    expect(host.querySelector('.partial')).toBeNull();
  });

  it('goes quiet after twenty seconds without a step, keeping its label and clock', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          live({
            activity: { kind: 'thinking', label: 'Wait, let me think…', at: 99_000 },
            steps: [{ kind: 'thinking', label: 'Wait, let me think…', at: 99_000 }],
          }),
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();
    expect(host.querySelector('.acting')?.getAttribute('data-quiet')).toBeNull();
    expect(host.querySelector('.acting .quiet')).toBeNull();

    vi.advanceTimersByTime(20_000);
    fixture.detectChanges();
    const row = host.querySelector('.acting') as HTMLElement;
    expect(row.getAttribute('data-quiet')).toBe('true');
    expect(row.querySelector('.quiet')?.textContent).toContain('waiting on the model');
    // Quiet is about the shimmer, not about forgetting the turn.
    expect(row.querySelector('.doing-label')?.textContent?.trim()).toBe('Wait, let me think…');
    expect(row.querySelector('.elapsed')?.textContent?.trim()).toBe('21s');
  });

  it('stays at work while a tool is still running, however long it takes', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          live({
            activity: {
              kind: 'tool',
              label: 'Running the tests…',
              tool: 'bash',
              at: 99_000,
              status: 'running',
            },
            steps: [
              {
                kind: 'tool',
                label: 'Running the tests…',
                tool: 'bash',
                at: 99_000,
                status: 'running',
              },
            ],
          }),
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();

    vi.advanceTimersByTime(60_000);
    fixture.detectChanges();
    const row = host.querySelector('.acting') as HTMLElement;
    expect(row.getAttribute('data-quiet')).toBeNull();
    expect(row.querySelector('.quiet')).toBeNull();
  });

  it('stays at work when the running step is only the current activity', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    // A host that reported the current step as the activity and no history yet:
    // the activity is still the step the row is on, and a running tool there
    // means the turn has not gone quiet.
    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          live({
            activity: {
              kind: 'tool',
              label: 'Running the tests…',
              tool: 'bash',
              at: 99_000,
              status: 'running',
            },
            steps: [],
          }),
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();

    vi.advanceTimersByTime(60_000);
    fixture.detectChanges();
    const row = host.querySelector('.acting') as HTMLElement;
    expect(row.getAttribute('data-quiet')).toBeNull();
    expect(row.querySelector('.quiet')).toBeNull();
  });

  it('opens the newest three steps, with a failed step’s error behind its own disclosure', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const steps: BotActivity[] = [
      { kind: 'tool', label: 'Reading brief.md', tool: 'read', at: 90_000, status: 'ok' },
      { kind: 'thinking', label: 'Weighing the options', at: 91_000, status: 'ok' },
      { kind: 'tool', label: 'Reading the log', tool: 'read', at: 92_000, status: 'ok' },
      {
        kind: 'tool',
        label: 'Running the tests',
        tool: 'bash',
        at: 93_000,
        status: 'error',
        error: 'exit code 1',
      },
      { kind: 'writing', label: 'Writing the answer…', at: 94_000, status: 'running' },
    ];
    morse.bot.onRouting(
      round(workshop.id, {
        active: [live({ activity: steps[4] as BotActivity, steps, startedAt: 90_000 })],
        queued: [],
      }),
    );
    fixture.detectChanges();

    const toggle = host.querySelector('.acting .steps-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // A long turn shows what a glance holds, and says so rather than claiming
    // five steps are on screen.
    expect(toggle.querySelector('.steps-label')?.textContent?.trim()).toBe('Latest 3 of 5 steps');
    expect(host.querySelector('.acting .live-step-list')).toBeNull();
    toggle.click();
    fixture.detectChanges();

    // The newest three, oldest first: what the bot did a while ago is the
    // finished turn's job, not the live row's.
    expect(
      [...host.querySelectorAll('.acting .live-step-list .step-label')].map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(['Reading the log', 'Running the tests', 'Writing the answer…']);
    const failed = host.querySelector(
      '.acting .live-step-list .step[data-status="error"]',
    ) as HTMLElement;
    const error = failed.querySelector('details.step-error') as HTMLDetailsElement;
    expect(error.querySelector('summary')?.textContent).toContain('error');
    expect(error.textContent).toContain('exit code 1');
  });

  it('keeps a step’s node and its opened error when the newest three slide', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const readBrief: BotActivity = {
      kind: 'tool',
      label: 'Reading brief.md',
      tool: 'read',
      at: 90_000,
      status: 'ok',
    };
    const failedTests: BotActivity = {
      kind: 'tool',
      label: 'Running the tests',
      tool: 'bash',
      at: 91_000,
      status: 'error',
      error: 'exit code 1',
    };
    const writing: BotActivity = { kind: 'writing', label: 'Writing the answer…', at: 92_000 };
    const readLog: BotActivity = {
      kind: 'tool',
      label: 'Reading the log',
      tool: 'read',
      at: 93_000,
      status: 'ok',
    };
    // The activity is held still so this isolates the step list's own keying: a
    // real push also changes the row's key, which is the entrance animation's job.
    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          live({ activity: writing, steps: [readBrief, failedTests, writing], startedAt: 90_000 }),
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();
    (host.querySelector('.acting .steps-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();

    const dropped = host.querySelector('.acting .live-step-list .step') as HTMLElement;
    expect(dropped.textContent).toContain('Reading brief.md');
    const failed = host.querySelector(
      '.acting .live-step-list .step[data-status="error"]',
    ) as HTMLElement;
    const error = failed.querySelector('details.step-error') as HTMLDetailsElement;
    error.open = true;

    // The window slides by one step: the oldest leaves, a newer one arrives.
    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          live({ activity: writing, steps: [failedTests, writing, readLog], startedAt: 90_000 }),
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();

    expect(
      [...host.querySelectorAll('.acting .live-step-list .step-label')].map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(['Running the tests', 'Writing the answer…', 'Reading the log']);
    // The step that left is gone; the failed step kept its node and its open error,
    // so neither the disclosure nor focus moved onto another row.
    expect(dropped.isConnected).toBe(false);
    expect(failed.isConnected).toBe(true);
    expect(error.open).toBe(true);
  });

  it('draws one chip per ask, in words, opening the room it happened in', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const handoffs: BotHandoff[] = [
      {
        username: 'loom',
        conversationId: 'thread-forge-loom',
        deliveryId: 'd1',
        at: 90_001,
        state: 'asked',
      },
      {
        username: 'sable',
        conversationId: 'thread-forge-sable',
        deliveryId: 'd2',
        at: 90_002,
        state: 'working',
        activity: {
          kind: 'tool',
          label: 'Reading the fine print',
          tool: 'read',
          at: 95_000,
          status: 'running',
        },
      },
      {
        username: 'dye',
        conversationId: 'thread-forge-dye',
        deliveryId: 'd3',
        at: 90_003,
        state: 'done',
      },
      {
        username: 'ash',
        conversationId: 'thread-forge-ash',
        deliveryId: 'd4',
        at: 90_004,
        state: 'failed',
      },
    ];
    morse.bot.onRouting(round(workshop.id, { active: [live({ handoffs })], queued: [] }));
    fixture.detectChanges();

    const chips = [...host.querySelectorAll('.acting .handoff-chip')] as HTMLButtonElement[];
    expect(chips.map((chip) => chip.textContent?.replace(/\s+/g, ' ').trim() ?? '')).toEqual([
      'asked @loom',
      'sable is working Reading the fine print',
      'dye answered',
      'ash failed',
    ]);
    // The extra detail is visible, but the chip's name is the state sentence the
    // row is required to say, without the activity text read on top of it.
    expect(chips[1]?.getAttribute('aria-label')).toBe('sable is working');
    expect(chips[1]?.querySelector('.chip-doing')?.getAttribute('aria-hidden')).toBe('true');

    const opened = vi.spyOn(morse, 'openBotConversation');
    chips[1]?.click();
    expect(opened).toHaveBeenCalledWith('thread-forge-sable');
  });

  it('draws no words until the bot has written some', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    morse.bot.onRouting(
      round(workshop.id, {
        active: [live({ activity: { kind: 'starting', label: 'Getting started…', at: 99_000 } })],
        queued: [],
      }),
    );
    fixture.detectChanges();

    vi.advanceTimersByTime(1_000);
    fixture.detectChanges();
    expect(host.querySelector('.acting .partial')).toBeNull();
  });

  it('keeps one sentence for assistive tech, naming the bot and its work', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          live({
            activity: {
              kind: 'tool',
              label: 'Reading launch-brief.md…',
              tool: 'read',
              at: 99_000,
            },
          }),
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();

    const status = host.querySelector('.acting [role="status"]') as HTMLElement;
    expect(status.textContent?.trim()).toBe('Forge is reading launch-brief.md.');
  });

  it('keeps an acronym’s capitals when the label starts with one', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          live({
            activity: {
              kind: 'tool',
              label: 'API lookup started…',
              tool: 'read',
              at: 99_000,
            },
          }),
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();

    // Only ordinary sentence-start capitalisation is lowered; an acronym is how
    // the reader knows the thing, not a word that needed a capital.
    const status = host.querySelector('.acting [role="status"]') as HTMLElement;
    expect(status.textContent?.trim()).toBe('Forge is API lookup started.');
  });

  it('draws one presence row per working bot', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);

    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          {
            target: 'Forge',
            username: 'forge',
            activity: { kind: 'starting', label: 'Getting started…', at: 1 },
            startedAt: 1,
            steps: [{ kind: 'starting', label: 'Getting started…', at: 1 }],
            handoffs: [],
          },
          {
            target: 'Sable',
            username: 'sable',
            activity: { kind: 'thinking', label: 'Wait, let me think…', at: 2 },
            startedAt: 2,
            steps: [{ kind: 'thinking', label: 'Wait, let me think…', at: 2 }],
            handoffs: [],
          },
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();

    // Two lanes, two rooms' worth of work at once: the room shows both members.
    expect(
      [...host.querySelectorAll('.acting .author')].map((one) => one.textContent?.trim()),
    ).toEqual(['Forge', 'Sable']);
    expect(
      [...host.querySelectorAll('.acting .doing-label')].map((one) => one.textContent?.trim()),
    ).toEqual(['Getting started…', 'Wait, let me think…']);
  });

  it('keeps two bots with one display name on separate rows, rings and stops', async () => {
    const { fixture, host, morse } = await render();
    // Two bots both called Forge: the reader sees the same heading twice, and
    // only the handle can tell them apart.
    const twin: BotSummary = { ...forge, username: 'builder', name: 'Forge', avatar: 'B' };
    const forgeTwin = { ...workshop, id: 'group-twin', members: ['forge', 'builder'] };
    morse.bot.onRoster({ bots: [forge, twin], conversations: [forgeTwin] });
    morse.bot.open(forgeTwin.id);
    morse.bot.onUsage({
      conversationId: forgeTwin.id,
      username: 'forge',
      bot: 'Forge',
      contextUsage: { tokens: 21_000, contextWindow: 100_000, percent: 21 },
    });
    morse.bot.onUsage({
      conversationId: forgeTwin.id,
      username: 'builder',
      bot: 'Forge',
      contextUsage: { tokens: 84_000, contextWindow: 200_000, percent: 42 },
    });
    morse.bot.onRouting(
      round(forgeTwin.id, {
        active: [
          {
            target: 'Forge',
            username: 'forge',
            activity: { kind: 'thinking', label: 'Wait, let me think…', at: 1 },
            startedAt: 1,
            steps: [{ kind: 'thinking', label: 'Wait, let me think…', at: 1 }],
            handoffs: [],
          },
          {
            target: 'Forge',
            username: 'builder',
            activity: { kind: 'thinking', label: 'Wait, let me think…', at: 2 },
            startedAt: 2,
            steps: [{ kind: 'thinking', label: 'Wait, let me think…', at: 2 }],
            handoffs: [],
          },
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();

    const presence = [...host.querySelectorAll('.transcript .acting')] as HTMLElement[];
    expect(presence.map((row) => row.querySelector('.author')?.textContent?.trim())).toEqual([
      'Forge',
      'Forge',
    ]);
    // Each row draws its own bot's ring, not the first Forge's twice.
    expect(
      presence.map((row) => row.querySelector('morse-usage-indicator .pct')?.textContent?.trim()),
    ).toEqual(['21.0%', '42.0%']);
    // Each row's mark comes from its own roster entry.
    expect(presence.map((row) => row.querySelector('.avatar')?.textContent?.trim())).toEqual([
      'F',
      'B',
    ]);

    // Stop on the second row takes the second handle, not the first bot twice.
    const stop = vi.spyOn(morse, 'stopBotRound');
    (presence[1]?.querySelector('.stop') as HTMLButtonElement).click();
    expect(stop).toHaveBeenCalledWith(forgeTwin.id, 'builder');
  });

  it('gives each working bot its own ring, and the composer the last one reported', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);

    // Two engine sessions, so two sets of counters: the room must not paint both
    // rows with whichever bot answered last.
    morse.bot.onUsage({
      conversationId: workshop.id,
      username: 'forge',
      bot: 'Forge',
      contextUsage: { tokens: 21_000, contextWindow: 100_000, percent: 21 },
    });
    morse.bot.onUsage({
      conversationId: workshop.id,
      username: 'sable',
      bot: 'Sable',
      contextUsage: { tokens: 84_000, contextWindow: 200_000, percent: 42 },
    });
    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          {
            target: 'Forge',
            username: 'forge',
            activity: { kind: 'thinking', label: 'Wait, let me think…', at: 1 },
            startedAt: 1,
            steps: [{ kind: 'thinking', label: 'Wait, let me think…', at: 1 }],
            handoffs: [],
          },
          {
            target: 'Sable',
            username: 'sable',
            activity: { kind: 'thinking', label: 'Wait, let me think…', at: 2 },
            startedAt: 2,
            steps: [{ kind: 'thinking', label: 'Wait, let me think…', at: 2 }],
            handoffs: [],
          },
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();

    const presence = [...host.querySelectorAll('.transcript .acting')] as HTMLElement[];
    expect(
      presence.map((row) => row.querySelector('morse-usage-indicator .pct')?.textContent?.trim()),
    ).toEqual(['21.0%', '42.0%']);

    // The composer keeps one ring, and it belongs to the bot that reported most
    // recently — the session the reader just watched work.
    expect(
      host.querySelector('.composer-host morse-usage-indicator .pct')?.textContent?.trim(),
    ).toBe('42.0%');

    // A row's ring opens that bot's own budget, named, not the room's.
    (presence[1]?.querySelector('morse-usage-indicator .mini') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(presence[1]?.querySelector('morse-usage-indicator .subtitle')?.textContent).toContain(
      'Sable',
    );

    // Presence goes, rings go with it: a room with nobody running shows none, while
    // the composer keeps the last answer's counters.
    morse.bot.onRouting(round(workshop.id, null));
    fixture.detectChanges();
    expect(host.querySelectorAll('.transcript morse-usage-indicator')).toHaveLength(0);
    expect(
      host.querySelector('.composer-host morse-usage-indicator .pct')?.textContent?.trim(),
    ).toBe('42.0%');
  });

  it('does not draw another conversation’s round', async () => {
    const { fixture, host, morse } = await render();
    open(morse, dm, []);

    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          {
            target: 'Sable',
            username: 'sable',
            activity: { kind: 'thinking', label: 'Wait, let me think…', at: 30 },
            startedAt: 30,
            steps: [{ kind: 'thinking', label: 'Wait, let me think…', at: 30 }],
            handoffs: [],
          },
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();

    expect(host.querySelector('.acting')).toBeNull();
  });

  it('stops the round in flight, and only offers it while one is set', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    fixture.detectChanges();
    expect(host.querySelector('.stop')).toBeNull();

    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          {
            target: 'Forge',
            username: 'forge',
            activity: { kind: 'starting', label: 'Getting started…', at: 1 },
            startedAt: 1,
            steps: [{ kind: 'starting', label: 'Getting started…', at: 1 }],
            handoffs: [],
          },
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();
    const stop = vi.spyOn(morse, 'stopBotRound');

    (host.querySelector('.stop') as HTMLButtonElement).click();

    // The row belongs to one bot, so its Stop halts that bot alone: the room's
    // other lane keeps running, and its menu names handles, not display names.
    expect(stop).toHaveBeenCalledWith(workshop.id, 'forge');
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

  it('clears the conversation only after asking, and says which one', async () => {
    const { fixture, host, morse, sent } = await render();
    open(morse, workshop, [entry('1', { role: 'user' }, 'hi')]);
    fixture.detectChanges();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    (host.querySelector('.clear-messages') as HTMLButtonElement).click();

    // Clearing deletes the transcript and every engine session, so it asks first.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)).toEqual({
      type: 'bot/clear',
      payload: { conversationId: workshop.id },
    });
  });

  it('keeps the messages when clearing is declined', async () => {
    const { fixture, host, morse, sent } = await render();
    open(morse, workshop, [entry('1', { role: 'user' }, 'hi')]);
    fixture.detectChanges();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const before = sent.length;

    (host.querySelector('.clear-messages') as HTMLButtonElement).click();

    expect(sent.length).toBe(before);
    expect(host.querySelector('.transcript')?.textContent).toContain('hi');
  });

  it('compacts the conversation without asking, since nothing is lost', async () => {
    const { fixture, host, morse, sent } = await render();
    open(morse, workshop, [entry('1', { role: 'user' }, 'hi')]);
    fixture.detectChanges();
    const confirm = vi.spyOn(window, 'confirm');

    (host.querySelector('.head-action.compact') as HTMLButtonElement).click();

    // Compaction is about the engine's context, not the reader's history: the
    // lines stay, so there is nothing to warn about.
    expect(confirm).not.toHaveBeenCalled();
    expect(sent.at(-1)).toEqual({
      type: 'bot/compact',
      payload: { conversationId: workshop.id },
    });
  });

  it('copies a line, and shows the tick on the control that did it', async () => {
    const { fixture, host, morse } = await render();
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    open(morse, workshop, [
      entry('1', { role: 'user' }, 'the reader said this'),
      entry('2', { role: 'bot', name: 'Forge', avatar: 'F' }, 'the **bot** said this'),
    ]);
    fixture.detectChanges();

    const userCopy = host.querySelector('.entry.user .copy-msg') as HTMLButtonElement;
    expect(userCopy.getAttribute('title')).toBe('Copy message');
    userCopy.click();
    fixture.detectChanges();

    // The answer's markdown source is what leaves, the way code mode copies it.
    const botCopy = host.querySelector('.entry.bot .copy-msg') as HTMLButtonElement;
    botCopy.click();
    fixture.detectChanges();

    expect(writeText).toHaveBeenNthCalledWith(1, 'the reader said this');
    expect(writeText).toHaveBeenNthCalledWith(2, 'the **bot** said this');
    expect(botCopy.textContent?.trim()).toBe('✓ Copied');
    expect(botCopy.classList.contains('revealed')).toBe(true);
  });

  it('draws the context ring from what the conversation reported', async () => {
    const { fixture, host, morse } = await render();
    open(morse, dm, []);
    fixture.detectChanges();
    // Nothing has answered yet, so there is nothing to describe.
    expect(host.querySelector('morse-usage-indicator')).toBeNull();

    morse.bot.onUsage({
      conversationId: dm.id,
      username: 'forge',
      bot: 'Forge',
      contextUsage: { tokens: 42_000, contextWindow: 200_000, percent: 21 },
    });
    fixture.detectChanges();

    expect(host.querySelector('morse-usage-indicator')).toBeTruthy();

    // The popup is the budget, not a code session's whole economics: a bot
    // answers from its own engine session, so messages, cache, speed and cost
    // would be half-known numbers claiming more than they can.
    (host.querySelector('morse-usage-indicator .mini') as HTMLButtonElement).click();
    fixture.detectChanges();
    const panel = host.querySelector('morse-usage-indicator .panel') as HTMLElement;
    expect(panel.textContent).toContain('Remaining');
    expect(panel.textContent).not.toContain('Session totals');
    expect(panel.textContent).not.toContain('Tool calls');
  });

  it('keeps a round running while the reader reads another conversation', async () => {
    const { fixture, host, morse } = await render();
    open(morse, workshop, []);
    morse.bot.onRouting(
      round(workshop.id, {
        active: [
          {
            target: 'Forge',
            username: 'forge',
            activity: { kind: 'writing', label: 'Writing the answer…', at: 5 },
            startedAt: 5,
            steps: [{ kind: 'writing', label: 'Writing the answer…', at: 5 }],
            handoffs: [],
          },
        ],
        queued: [],
      }),
    );
    fixture.detectChanges();
    expect(host.querySelector('.acting .doing-label')?.textContent?.trim()).toBe(
      'Writing the answer…',
    );

    // The reader switches rooms: the round belongs to the conversation it runs
    // in, so coming back must find it exactly as it was.
    morse.openBotConversation(dm.id);
    fixture.detectChanges();
    expect(host.querySelector('.acting')).toBeNull();

    morse.openBotConversation(workshop.id);
    fixture.detectChanges();
    expect(host.querySelector('.acting .doing-label')?.textContent?.trim()).toBe(
      'Writing the answer…',
    );
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

  it('stamps every line, reader and bot alike', async () => {
    const { fixture, host, morse } = await render();
    const at = Date.UTC(2026, 10, 15, 7, 42, 4);
    open(morse, dm, [
      { id: '1', author: { role: 'user' }, text: 'hello', at },
      { id: '2', author: { role: 'bot', name: 'Forge', avatar: 'F' }, text: 'hi', at: at + 60_000 },
    ]);
    fixture.detectChanges();

    const times = [...host.querySelectorAll('time.when')] as HTMLTimeElement[];
    expect(times).toHaveLength(2);
    expect(times[0]?.textContent?.trim()).toBe(clockTime(at));
    expect(times[0]?.title).toBe(fullTime(at));
    expect(times[1]?.textContent?.trim()).toBe(clockTime(at + 60_000));
  });

  it('says so when no conversation is open', async () => {
    const { host } = await render();

    const empty = host.querySelector('.bot-chat-placeholder') as HTMLElement;
    expect(empty.textContent).toContain('No conversation open');
    expect(host.querySelector('morse-chat-composer')).toBeNull();
  });
});
