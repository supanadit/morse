import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { PinActions } from './pin-actions';

/** A row that reacts to clicks, so a press that escapes the buttons is visible. */
@Component({
  imports: [PinActions],
  template: `
    <div class="row" (click)="bubbled = bubbled + 1">
      <morse-pin-actions
        [note]="note()"
        [target]="target()"
        [hint]="hint()"
        (edit)="edited.push($event)"
        (cancel)="cancelled = cancelled + 1"
      />
    </div>
  `,
})
class Host {
  readonly note = signal<string | undefined>(undefined);
  readonly target = signal('this change of main.ts');
  readonly hint = signal('');
  bubbled = 0;
  cancelled = 0;
  readonly edited: HTMLElement[] = [];
}

function render(): {
  fixture: ComponentFixture<Host>;
  host: Host;
  element: HTMLElement;
} {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance, element: fixture.nativeElement as HTMLElement };
}

describe('PinActions', () => {
  it('offers the file preview’s two buttons: ✎ note and Cancel', () => {
    const { element } = render();

    expect(element.querySelector('button.note')?.textContent?.trim()).toBe('✎ note');
    expect(element.querySelector('button.cancel')?.textContent?.trim()).toBe('Cancel');
  });

  it('shows a written note’s first line on the button', () => {
    const { fixture, host, element } = render();
    host.note.set('why this line');
    host.hint.set('why this line');
    fixture.detectChanges();

    expect(element.querySelector('button.note')?.textContent).toContain('why this line');
    expect(element.querySelector('button.note')?.classList.contains('has-note')).toBe(true);
  });

  it('hands the pressed button up so the editor can anchor to it', () => {
    const { host, element } = render();

    element.querySelector<HTMLButtonElement>('button.note')?.click();

    expect(host.edited).toHaveLength(1);
    expect(host.edited[0]?.tagName).toBe('BUTTON');
  });

  it('never lets a press reach the row underneath', () => {
    const { host, element } = render();

    element.querySelector<HTMLButtonElement>('button.note')?.click();
    element.querySelector<HTMLButtonElement>('button.cancel')?.click();

    expect(host.bubbled).toBe(0);
  });

  it('cancels the pin', () => {
    const { host, element } = render();

    element.querySelector<HTMLButtonElement>('button.cancel')?.click();

    expect(host.cancelled).toBe(1);
  });
});
