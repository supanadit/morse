import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessStep } from '@morse/ui-runtime';
import { DisplayPrefs } from '../../state/display-prefs';
import { ToolGroup } from './tool-group';

function step(key: string, title: string, status: 'ok' | 'running' = 'ok'): ProcessStep {
  return {
    key,
    kind: 'tool',
    item: { kind: 'tool', id: key, at: 1, name: 'bash', title, status },
  };
}

async function render(steps: ProcessStep[], working: boolean) {
  TestBed.configureTestingModule({ imports: [ToolGroup] });
  // The calmer density is the one this behavior is about.
  TestBed.inject(DisplayPrefs).setToolDisplay('compact');
  const fixture = TestBed.createComponent(ToolGroup);
  fixture.componentRef.setInput('steps', steps);
  fixture.componentRef.setInput('working', working);
  fixture.detectChanges();
  return fixture;
}

describe('ToolGroup collapse', () => {
  beforeEach(() => localStorage.clear());

  afterEach(() => TestBed.resetTestingModule());

  it('shows only the newest step while the turn is running', async () => {
    const fixture = await render([step('a', 'first-command'), step('b', 'latest-command')], true);
    const host = fixture.nativeElement as HTMLElement;

    const rows = [...host.querySelectorAll('.tree .node-row .target')].map((node) =>
      node.textContent?.trim(),
    );
    expect(rows).toEqual(['latest-command']);
  });

  it('folds completely once the turn finishes', async () => {
    const fixture = await render([step('a', 'first-command'), step('b', 'latest-command')], false);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('.summary')).not.toBeNull();
    expect(host.querySelectorAll('.tree .node-row')).toHaveLength(0);
  });

  it('keeps a trace the reader opened open when the turn finishes', async () => {
    const fixture = await render([step('a', 'first-command'), step('b', 'latest-command')], true);
    const host = fixture.nativeElement as HTMLElement;

    host.querySelector<HTMLButtonElement>('.summary')?.click();
    fixture.detectChanges();
    expect(host.querySelectorAll('.tree .node-row')).toHaveLength(2);

    // The run ends: the reader's expansion stands, the trace does not fold.
    fixture.componentRef.setInput('working', false);
    fixture.detectChanges();
    expect(host.querySelectorAll('.tree .node-row')).toHaveLength(2);
  });

  it('collapses every step detail when the reader collapses the trace', async () => {
    const fixture = await render([step('a', 'first-command'), step('b', 'latest-command')], true);
    const host = fixture.nativeElement as HTMLElement;

    host.querySelector<HTMLButtonElement>('.summary')?.click();
    fixture.detectChanges();
    host.querySelector<HTMLButtonElement>('.tree .node-row')?.click();
    fixture.detectChanges();
    expect(host.querySelector('.tree .body')).not.toBeNull();

    // Closing the trace closes its details too; opening it again starts from
    // the summary, not from the old step expansion.
    host.querySelector<HTMLButtonElement>('.summary')?.click();
    fixture.detectChanges();
    host.querySelector<HTMLButtonElement>('.summary')?.click();
    fixture.detectChanges();

    expect(host.querySelector('.tree .body')).toBeNull();
  });
});
