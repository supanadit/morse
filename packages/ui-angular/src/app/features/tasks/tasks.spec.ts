import { signal, type Signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolTranscriptItem, TranscriptItem } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
import { TaskOverlay } from './tasks';

interface Fake {
  items: Signal<TranscriptItem[]>;
}

function tool(id: string, details: unknown, status: ToolTranscriptItem['status'] = 'ok'): ToolTranscriptItem {
  return {
    kind: 'tool',
    id,
    at: 0,
    name: 'anything',
    title: 'anything',
    status,
    details: details as ToolTranscriptItem['details'],
  };
}

function render(items: TranscriptItem[]): ComponentFixture<TaskOverlay> {
  const fake: Fake = { items: signal(items).asReadonly() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [TaskOverlay],
    providers: [{ provide: MorseService, useValue: fake }],
  });
  const fixture = TestBed.createComponent(TaskOverlay);
  fixture.detectChanges();
  return fixture;
}

function hostOf(fixture: ComponentFixture<TaskOverlay>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * The persistent todo strip above the composer. It is rebuilt from the
 * transcript's task-shaped tool results, so the things worth locking are: it
 * appears when there is open work, it disappears when none is left, and it never
 * renders for details that are not a task list (a diff, a build matrix).
 */
describe('TaskOverlay', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows the session task list with a done count and every row', () => {
    const host = hostOf(render([
      tool('t1', {
        tasks: [
          { id: 1, subject: 'Create entity', status: 'completed' },
          { id: 2, subject: 'Wire repo', status: 'in_progress', activeForm: 'wiring it' },
          { id: 3, subject: 'Test', status: 'pending', blockedBy: [2] },
        ],
      }),
    ]));

    expect(host.querySelector('.card')).not.toBeNull();
    expect(host.textContent).toContain('Tasks');
    expect(host.textContent).toContain('1/3 done');
    expect(host.textContent).toContain('Wire repo');
    expect(host.textContent).toContain('wiring it');
  });

  it('stays out of the layout when the list is finished', () => {
    const host = hostOf(render([
      tool('t1', {
        tasks: [
          { id: 1, subject: 'a', status: 'completed' },
          { id: 2, subject: 'b', status: 'completed' },
        ],
      }),
    ]));
    expect(host.querySelector('.card')).toBeNull();
  });

  it('stays out of the layout when no tool returned a task list', () => {
    expect(hostOf(render([tool('t1', { diff: '+1 -1' })])).querySelector('.card')).toBeNull();
    expect(hostOf(render([])).querySelector('.card')).toBeNull();
  });

  it('uses the newest list, so a later snapshot replaces an earlier one', () => {
    const host = hostOf(render([
      tool('t1', { tasks: [{ id: 1, subject: 'old work', status: 'pending' }] }),
      tool('t2', {
        tasks: [
          { id: 1, subject: 'old work', status: 'completed' },
          { id: 2, subject: 'new work', status: 'pending' },
        ],
      }),
    ]));
    expect(host.textContent).toContain('new work');
    expect(host.textContent).toContain('1/2 done');
  });

  it('hides a deleted row and keeps the remaining work visible', () => {
    const host = hostOf(render([
      tool('t1', {
        tasks: [
          { id: 1, subject: 'gone', status: 'deleted' },
          { id: 2, subject: 'kept', status: 'pending' },
        ],
      }),
    ]));
    expect(host.textContent).toContain('kept');
    expect(host.textContent).not.toContain('gone');
  });

  it('folds and unfolds the rows, keeping the strip itself mounted', () => {
    const fixture = render([
      tool('t1', { tasks: [{ id: 1, subject: 'row one', status: 'pending' }] }),
    ]);
    const host = hostOf(fixture);
    expect(host.querySelector('.body')).not.toBeNull();

    host.querySelector<HTMLElement>('.head')!.click();
    fixture.detectChanges();
    expect(host.querySelector('.card')).not.toBeNull();
    expect(host.querySelector('.body')).toBeNull();

    host.querySelector<HTMLElement>('.head')!.click();
    fixture.detectChanges();
    expect(host.querySelector('.body')).not.toBeNull();
  });
});
