import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { BotSummary } from '@morse/protocol';
import { MemoryHostTransport } from '@morse/ui-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MorseService } from '../../host/morse.service';
import { MORSE_TRANSPORT } from '../../host/transport.token';
import { BotGroupDialog } from './bot-group-dialog';

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
const ember: BotSummary = {
  name: 'Ember',
  description: 'Tends the coals',
  engineKind: 'pi',
  warm: false,
};

async function render(): Promise<{
  fixture: ComponentFixture<BotGroupDialog>;
  host: HTMLElement;
  morse: MorseService;
}> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [BotGroupDialog],
    providers: [{ provide: MORSE_TRANSPORT, useFactory: () => new MemoryHostTransport() }],
  }).compileComponents();
  const fixture = TestBed.createComponent(BotGroupDialog);
  fixture.detectChanges();
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    morse: TestBed.inject(MorseService),
  };
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

    chooseMember(host, 'Forge');
    fixture.detectChanges();
    chooseMember(host, 'Sable');
    fixture.detectChanges();

    const lead = field<HTMLSelectElement>(host, 'select[name="lead"]');
    const options = [...lead.options].map((option) => option.value);
    // The empty value is "no lead"; the rest are members only.
    expect(options).toEqual(['', 'Forge', 'Sable']);
    expect(lead.textContent).not.toContain('Ember');
  });

  it('drops a lead that stops being a member', async () => {
    const { fixture, host, morse } = await render();
    morse.bot.onRoster({ bots: [forge, sable], conversations: [] });
    fixture.detectChanges();

    chooseMember(host, 'Forge');
    fixture.detectChanges();
    const lead = field<HTMLSelectElement>(host, 'select[name="lead"]');
    lead.value = 'Forge';
    lead.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(lead.value).toBe('Forge');

    chooseMember(host, 'Forge');
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
    chooseMember(host, 'Forge');
    fixture.detectChanges();
    chooseMember(host, 'Sable');
    fixture.detectChanges();

    const lead = field<HTMLSelectElement>(host, 'select[name="lead"]');
    lead.value = 'Sable';
    lead.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    field<HTMLButtonElement>(host, '.create').click();

    expect(create).toHaveBeenCalledWith({
      name: 'The workshop',
      members: ['Forge', 'Sable'],
      lead: 'Sable',
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
    chooseMember(host, 'Forge');
    fixture.detectChanges();
    chooseMember(host, 'Sable');
    fixture.detectChanges();
    field<HTMLButtonElement>(host, '.create').click();

    expect(create).toHaveBeenCalledWith({
      name: 'The workshop',
      members: ['Forge', 'Sable'],
      chainCap: 8,
    });
  });
});
