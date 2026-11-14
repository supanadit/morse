import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { MentionPicker, type MentionCandidate } from './mention-picker';

/**
 * The bot conversation's `@` list. It owns no state — the composer filters,
 * highlights and handles the keyboard — so what is tested here is what it *says*:
 * a handle, the name that belongs to it, the special mentions when the room has
 * more than one bot, and an honest empty state.
 */
function render(
  members: MentionCandidate[],
  options: { broadcast?: boolean; query?: string; active?: number } = {},
): { fixture: ComponentFixture<MentionPicker>; host: HTMLElement } {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(MentionPicker);
  fixture.componentRef.setInput('members', members);
  fixture.componentRef.setInput('broadcast', options.broadcast ?? false);
  fixture.componentRef.setInput('query', options.query ?? '');
  fixture.componentRef.setInput('active', options.active ?? 0);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

const members: MentionCandidate[] = [
  { username: 'job-hunter', name: 'Job Hunter', avatar: '🔎', description: 'You are Job Seeker' },
  { username: 'chitchatter', name: 'Chit Chat Bot', description: 'Friendly Chit Chat' },
];

afterEach(() => TestBed.resetTestingModule());

describe('MentionPicker', () => {
  it('lists a handle with the name and the note that belong to it', () => {
    const { host } = render(members);

    const handles = [...host.querySelectorAll('.handle')].map((one) => one.textContent?.trim());
    expect(handles).toEqual(['@job-hunter', '@chitchatter']);
    // Both, because nobody remembers a handle on sight.
    const names = [...host.querySelectorAll('.name')].map((one) => one.textContent?.trim());
    expect(names).toEqual(['Job Hunter', 'Chit Chat Bot']);
    expect(host.querySelectorAll('.avatar')[0]?.textContent?.trim()).toBe('🔎');
    // A bot without an avatar still has a mark: its initial.
    expect(host.querySelectorAll('.avatar')[1]?.textContent?.trim()).toBe('C');
    expect(host.textContent).toContain('You are Job Seeker');
  });

  it('puts the special mentions in their own section, after the people', () => {
    const { host } = render(members, { broadcast: true });

    expect(host.textContent).toContain('Special mentions');
    const handles = [...host.querySelectorAll('.handle')].map((one) => one.textContent?.trim());
    expect(handles).toEqual(['@job-hunter', '@chitchatter', '@all', '@everyone']);
  });

  it('leaves the special mentions out of a room with one bot', () => {
    const { host } = render([members[1] as MentionCandidate]);

    expect(host.textContent).not.toContain('Special mentions');
    expect([...host.querySelectorAll('.handle')].map((one) => one.textContent?.trim())).toEqual([
      '@chitchatter',
    ]);
  });

  it('says nobody matches instead of showing an empty box', () => {
    const { host } = render([], { query: 'zzz' });

    expect(host.querySelector('.empty')?.textContent).toContain('Nobody here matches');
  });

  it('reports the handle of the row that was clicked', () => {
    const { fixture, host } = render(members, { broadcast: true });
    const picked: string[] = [];
    fixture.componentInstance.pick.subscribe((handle) => picked.push(handle));

    const rows = [...host.querySelectorAll<HTMLButtonElement>('.row')];
    rows[2]?.click();

    expect(picked).toEqual(['all']);
    // Hovering a row moves the highlight with it, so the mouse and the keys agree.
    const highlighted: number[] = [];
    fixture.componentInstance.activeChange.subscribe((index) => highlighted.push(index));
    rows[0]?.dispatchEvent(new MouseEvent('mouseenter'));
    expect(highlighted).toEqual([0]);
  });

  it('marks the highlighted row it was told about', () => {
    const { host } = render(members, { active: 1 });

    const rows = [...host.querySelectorAll('li')];
    expect(rows[0]?.classList.contains('active')).toBe(false);
    expect(rows[1]?.classList.contains('active')).toBe(true);
  });

  it('prints the keys that move it, because the caret never leaves the prompt', () => {
    const { host } = render(members);

    expect(host.querySelector('.hint')?.textContent).toContain('Enter');
    expect(host.querySelector('.hint')?.textContent).toContain('Esc');
  });
});
