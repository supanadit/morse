import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ChangeList, type ChangeGroupView } from './change-list';

function render(groups: readonly ChangeGroupView[]) {
  TestBed.configureTestingModule({ imports: [ChangeList] });
  const fixture = TestBed.createComponent(ChangeList);
  fixture.componentRef.setInput('groups', groups);
  const toggled: Array<{ path: string; staged: boolean }> = [];
  const folded: ChangeGroupView[] = [];
  const all: ChangeGroupView[] = [];
  fixture.componentInstance.toggleRow.subscribe((event) => toggled.push(event));
  fixture.componentInstance.toggleGroup.subscribe((event) => folded.push(event));
  fixture.componentInstance.toggleAll.subscribe((event) => all.push(event));
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, toggled, folded, all };
}

const GROUPS: ChangeGroupView[] = [
  { id: 'staged', label: 'Staged', collapsed: false, rows: [{ path: 'a.ts', kind: 'M' }] },
  { id: 'unstaged', label: 'Unstaged', collapsed: false, rows: [{ path: 'b.ts', kind: 'M' }] },
];

describe('ChangeList', () => {
  it('checks staged rows and unchecks unstaged ones', () => {
    const { host } = render(GROUPS);
    const checks = [...host.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[];

    expect(checks.map((check) => check.checked)).toEqual([true, false]);
  });

  it('asks to stage an unchecked row and unstage a checked one', () => {
    const { host, toggled } = render(GROUPS);

    (host.querySelectorAll('.change-row input')[1] as HTMLInputElement).click();
    expect(toggled.at(-1)).toEqual({ path: 'b.ts', staged: true });

    (host.querySelectorAll('.change-row input')[0] as HTMLInputElement).click();
    expect(toggled.at(-1)).toEqual({ path: 'a.ts', staged: false });
  });

  it('folds a group and stages all of it from the header', () => {
    const { host, folded, all } = render(GROUPS);

    (host.querySelector('.group-toggle') as HTMLButtonElement).click();
    expect(folded.at(-1)?.id).toBe('staged');

    (host.querySelectorAll('.group-all')[1] as HTMLButtonElement).click();
    expect(all.at(-1)?.id).toBe('unstaged');
  });

  it('shows the folder a file sits in beside its name', () => {
    const { host } = render([
      {
        id: 'unstaged',
        label: 'Unstaged',
        collapsed: false,
        rows: [{ path: 'src/app/a.ts', kind: 'M' }],
      },
    ]);

    expect(host.querySelector('.name')?.textContent).toBe('a.ts');
    expect(host.querySelector('.dir')?.textContent).toBe('src/app');
  });
});
