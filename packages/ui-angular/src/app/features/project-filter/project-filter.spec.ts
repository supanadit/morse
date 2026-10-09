import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ALL_PROJECTS, ProjectFilter, projectRows, type ProjectOption } from './project-filter';
import { OverlayEscape } from '../../ui/overlay-escape';

const PROJECTS: ProjectOption[] = [
  { path: '/work/morse', name: 'morse', sessionCount: 12 },
  { path: '/work/buku', name: 'buku', sessionCount: 3 },
  { path: '/work/eigen-erp', name: 'eigen-erp', sessionCount: 41 },
];

describe('projectRows', () => {
  it('puts "all projects" first with the total, and never filters it out', () => {
    const rows = projectRows(PROJECTS, '', 56);

    expect(rows[0]).toMatchObject({ path: '', name: ALL_PROJECTS, sessionCount: 56, all: true });
    expect(rows.map((row) => row.name)).toEqual([ALL_PROJECTS, 'morse', 'buku', 'eigen-erp']);

    // The exit from a filter has to survive the search inside the filter.
    expect(projectRows(PROJECTS, 'buku', 56).map((row) => row.name)).toEqual([
      ALL_PROJECTS,
      'buku',
    ]);
  });

  it('matches a project by name or by path', () => {
    expect(projectRows(PROJECTS, 'eigen', 56).map((row) => row.name)).toEqual([
      ALL_PROJECTS,
      'eigen-erp',
    ]);
    expect(projectRows(PROJECTS, '/work/buku', 56).map((row) => row.name)).toEqual([
      ALL_PROJECTS,
      'buku',
    ]);
    expect(projectRows(PROJECTS, 'nothing like this', 56)).toHaveLength(1);
  });
});

interface Rendered {
  host: HTMLElement;
  fixture: ComponentFixture<ProjectFilter>;
}

function render(selected = ''): Rendered {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [ProjectFilter] });
  // The dialog no longer listens for Escape itself: the shell owns that one
  // listener (`ui/overlay-escape.ts`), so a spec that presses Escape mounts it.
  TestBed.inject(OverlayEscape);
  const fixture = TestBed.createComponent(ProjectFilter);
  fixture.componentRef.setInput('projects', PROJECTS);
  fixture.componentRef.setInput('totalSessions', 56);
  fixture.componentRef.setInput('selected', selected);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fixture };
}

const rowNames = (host: HTMLElement): (string | undefined)[] =>
  [...host.querySelectorAll('.row')].map((row) =>
    row.querySelector('.name')?.textContent?.trim(),
  );

function type(host: HTMLElement, value: string): void {
  const input = host.querySelector('input') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('ProjectFilter', () => {
  it('lists every project with its count, marking the one already chosen', () => {
    const { host } = render('/work/buku');

    expect(rowNames(host)).toEqual([ALL_PROJECTS, 'morse', 'buku', 'eigen-erp']);
    // "All projects" shows the total; each project its own count.
    expect([...host.querySelectorAll('.count')].map((count) => count.textContent)).toEqual([
      '56',
      '12',
      '3',
      '41',
    ]);
    expect(host.querySelector('.row.selected .name')?.textContent?.trim()).toBe('buku');
  });

  it('narrows the list as the reader types', () => {
    const { host, fixture } = render();

    type(host, 'erp');
    fixture.detectChanges();
    expect(rowNames(host)).toEqual([ALL_PROJECTS, 'eigen-erp']);

    type(host, 'zzz');
    fixture.detectChanges();
    // Only the way back, so the reader is never stuck inside the panel.
    expect(rowNames(host)).toEqual([ALL_PROJECTS]);
  });

  it('emits the chosen path — and an empty one for "all projects"', () => {
    const { host, fixture } = render('/work/buku');
    const select = vi.fn();
    fixture.componentInstance.select.subscribe(select);

    ([...host.querySelectorAll('.row')][1] as HTMLElement).click();
    expect(select).toHaveBeenLastCalledWith('/work/morse');

    ([...host.querySelectorAll('.row')][0] as HTMLElement).click();
    expect(select).toHaveBeenLastCalledWith('');
  });

  it('closes on Escape and on the backdrop, but not when the card is clicked', () => {
    const { host, fixture } = render();
    const close = vi.fn();
    fixture.componentInstance.close.subscribe(close);

    // A click inside the card is a click on the list, not a way out.
    (host.querySelector('.modal-card') as HTMLElement).click();
    expect(close).not.toHaveBeenCalled();

    (host.querySelector('.modal-layer') as HTMLElement).click();
    expect(close).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('walks the list with the arrow keys and picks with Enter', () => {
    const { host, fixture } = render();
    const select = vi.fn();
    fixture.componentInstance.select.subscribe(select);
    const input = host.querySelector('input') as HTMLInputElement;

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    // Opens on the first row and moves from there.
    expect(select).toHaveBeenLastCalledWith('/work/morse');
  });
});
