import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { BotConversationSummary, BotSummary } from '@morse/protocol';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { BotGroupDialog } from './bot-group-dialog';

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
const ember: BotSummary = {
  username: 'ember',
  name: 'Ember',
  description: 'Tends the coals',
  engineKind: 'pi',
  warm: false,
};

const launch: BotConversationSummary = {
  id: 'grp-launch-ab12',
  kind: 'group',
  title: 'Launch',
  members: ['forge', 'sable'],
  lead: 'forge',
  chainCap: 4,
  updatedAt: 1,
};

async function render(setup?: (morse: MorseService) => void): Promise<{
  fixture: ComponentFixture<BotGroupDialog>;
  host: HTMLElement;
  morse: MorseService;
}> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [BotGroupDialog],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
  }).compileComponents();
  const morse = TestBed.inject(MorseService);
  setup?.(morse);
  const fixture = TestBed.createComponent(BotGroupDialog);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, morse };
}

function field<T extends HTMLElement>(host: HTMLElement, selector: string): T {
  return host.querySelector(selector) as T;
}

function chooseMember(host: HTMLElement, name: string): void {
  const box = host.querySelector(`.member input[data-bot="${name}"]`) as HTMLInputElement;
  box.click();
}

describe('BotGroupDialog', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('offers every roster bot as a member', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable, ember], conversations: [] });
    fixture.detectChanges();

    const members = [...host.querySelectorAll('.member .member-name')].map((row) =>
      row.textContent?.trim(),
    );
    expect(members).toEqual(['Forge', 'Sable', 'Ember']);
  });

  it('limits the lead list to the members chosen so far', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable, ember], conversations: [] });
    fixture.detectChanges();

    chooseMember(host, 'forge');
    fixture.detectChanges();
    chooseMember(host, 'sable');
    fixture.detectChanges();

    const lead = field<HTMLSelectElement>(host, 'select[name="lead"]');
    // The value is the identity (a username); the label is what the reader knows.
    expect([...lead.options].map((option) => option.value)).toEqual(['', 'forge', 'sable']);
    expect([...lead.options].map((option) => option.textContent?.trim())).toEqual([
      'No lead — only @mentions answer',
      'Forge',
      'Sable',
    ]);
    expect(lead.textContent).not.toContain('Ember');
  });

  it('drops a lead that stops being a member', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [] });
    fixture.detectChanges();

    chooseMember(host, 'forge');
    fixture.detectChanges();
    const lead = field<HTMLSelectElement>(host, 'select[name="lead"]');
    lead.value = 'forge';
    lead.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(lead.value).toBe('forge');

    chooseMember(host, 'forge');
    fixture.detectChanges();
    // Forge is no longer a member, so it cannot answer for the group either.
    expect(field<HTMLSelectElement>(host, 'select[name="lead"]').value).toBe('');
  });

  it('creates the group from the name, the members and the lead', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable, ember], conversations: [] });
    fixture.detectChanges();
    const create = vi.spyOn(morse, 'createGroup');

    expect(field<HTMLButtonElement>(host, '.create').disabled).toBe(true);

    const name = field<HTMLInputElement>(host, 'input[name="name"]');
    name.value = 'The workshop';
    name.dispatchEvent(new Event('input'));
    chooseMember(host, 'forge');
    fixture.detectChanges();
    chooseMember(host, 'sable');
    fixture.detectChanges();

    const lead = field<HTMLSelectElement>(host, 'select[name="lead"]');
    lead.value = 'sable';
    lead.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    field<HTMLButtonElement>(host, '.create').click();

    expect(create).toHaveBeenCalledWith({
      name: 'The workshop',
      members: ['forge', 'sable'],
      lead: 'sable',
      chainCap: 8,
    });
  });

  it('omits the lead when none was crowned', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [] });
    fixture.detectChanges();
    const create = vi.spyOn(morse, 'createGroup');

    const name = field<HTMLInputElement>(host, 'input[name="name"]');
    name.value = 'The workshop';
    name.dispatchEvent(new Event('input'));
    chooseMember(host, 'forge');
    fixture.detectChanges();
    chooseMember(host, 'sable');
    fixture.detectChanges();
    field<HTMLButtonElement>(host, '.create').click();

    expect(create).toHaveBeenCalledWith({
      name: 'The workshop',
      members: ['forge', 'sable'],
      chainCap: 8,
    });
  });

  it('prefills and submits an edit for the group it was opened on', async () => {
    const { fixture, host, morse } = await render((service) => {
      service.bot.onRoster({ bots: [forge, sable, ember], conversations: [launch] });
      service.ui.groupTarget.set(launch.id);
    });
    const update = vi.spyOn(morse, 'updateGroup');

    expect(host.querySelector('h2')?.textContent).toContain('Edit group');
    expect(field<HTMLInputElement>(host, 'input[name="name"]').value).toBe('Launch');
    expect(
      (host.querySelector('.member input[data-bot="forge"]') as HTMLInputElement).checked,
    ).toBe(true);
    expect((host.querySelector('select[name="lead"]') as HTMLSelectElement).value).toBe('forge');
    expect(field<HTMLButtonElement>(host, '.actions button.create').textContent).toContain(
      'Save changes',
    );

    field<HTMLButtonElement>(host, '.actions button.create').click();
    fixture.detectChanges();

    expect(update).toHaveBeenCalledWith({
      id: launch.id,
      name: 'Launch',
      members: ['forge', 'sable'],
      lead: 'forge',
      chainCap: 4,
    });
    expect(morse.ui.groupOpen()).toBe(false);
    expect(morse.ui.groupTarget()).toBeNull();
  });

  it('drops a member whose bot is gone, so the edit can still be saved', async () => {
    // The group remembers `ghost`, but the roster no longer runs it: the dialog
    // cannot render an uncheckable member, and the host would refuse the save.
    const ghosted: BotConversationSummary = {
      ...launch,
      members: ['forge', 'ghost'],
      lead: 'ghost',
    };
    const { fixture, host, morse } = await render((service) => {
      service.bot.onRoster({ bots: [forge, sable], conversations: [ghosted] });
      service.ui.groupTarget.set(ghosted.id);
    });
    const update = vi.spyOn(morse, 'updateGroup');

    expect(host.querySelector('.former-note')?.textContent).toContain('@ghost');
    expect(field<HTMLSelectElement>(host, 'select[name="lead"]').value).toBe('');

    field<HTMLButtonElement>(host, '.actions button.create').click();
    fixture.detectChanges();

    // The former member is dropped and its lead goes with it; no ghost reaches the host.
    expect(update).toHaveBeenCalledWith({
      id: ghosted.id,
      name: 'Launch',
      members: ['forge'],
      chainCap: 4,
    });
  });

  it('closes without saving when the edit is cancelled', async () => {
    const { fixture, host, morse } = await render((service) => {
      service.bot.onRoster({ bots: [forge, sable], conversations: [launch] });
      service.ui.groupTarget.set(launch.id);
      service.ui.groupOpen.set(true);
    });
    const update = vi.spyOn(morse, 'updateGroup');

    field<HTMLButtonElement>(host, '.actions button.cancel').click();
    fixture.detectChanges();

    expect(update).not.toHaveBeenCalled();
    expect(morse.ui.groupTarget()).toBeNull();
    expect(morse.ui.groupOpen()).toBe(false);
  });
});
