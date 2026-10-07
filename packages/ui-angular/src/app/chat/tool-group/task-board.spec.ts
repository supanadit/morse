import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskRow } from '../../core/task-list';
import { TaskBoard } from './task-board';

@Component({
  imports: [TaskBoard],
  template: `<morse-task-board [tasks]="tasks()" />`,
})
class Host {
  readonly tasks = input.required<TaskRow[]>();
}

function render(tasks: TaskRow[]): HTMLElement {
  const fixture = TestBed.createComponent(Host);
  (fixture.componentRef as unknown as { setInput: (name: string, value: unknown) => void }).setInput('tasks', tasks);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('TaskBoard', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders a summary and one row per task, driven only by the rows it is given', () => {
    const host = render([
      { id: 1, subject: 'Create entity', status: 'completed' },
      { id: 2, subject: 'Wire repo', status: 'in_progress', activeForm: 'wiring it' },
      { id: 3, subject: 'Test', status: 'pending', blockedBy: [2] },
    ]);

    expect(host.querySelector('.head')?.textContent).toContain('1/3 done');
    const rows = [...host.querySelectorAll('.task')];
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain('Wire repo');
    // An in-progress row shows its present-continuous label.
    expect(rows[1]?.textContent).toContain('wiring it');
    // A blocked row names its dependencies.
    expect(rows[2]?.textContent).toContain('#2');
  });

  it('marks a completed row done and a deleted row as such, by class', () => {
    const host = render([
      { id: 1, subject: 'done', status: 'completed' },
      { id: 2, subject: 'gone', status: 'deleted' },
    ]);
    const rows = [...host.querySelectorAll('.task')];
    expect(rows[0]?.classList.contains('completed')).toBe(true);
    expect(rows[1]?.classList.contains('deleted')).toBe(true);
  });

  it('renders nothing when it is handed no rows', () => {
    expect(render([]).querySelector('.board')).toBeNull();
  });
});
