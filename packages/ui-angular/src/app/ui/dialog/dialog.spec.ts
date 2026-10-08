import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayStack } from '../../state/overlay-stack';
import { OverlayEscape } from '../overlay-escape';
import { Dialog } from './dialog';

/** A dialog that keeps its own content, the way the eight callers do. */
@Component({
  selector: 'morse-dialog-host',
  imports: [Dialog],
  template: `
    <morse-dialog labelledBy="host-title" [role]="role()" (dismiss)="dismissed()">
      <h2 id="host-title">Discard the draft?</h2>
      <p class="body">It cannot be recovered.</p>
      <button type="button" class="inside">Stay</button>
    </morse-dialog>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly role = signal('dialog');
  readonly dismissed = vi.fn();
}

interface Rendered {
  host: HTMLElement;
  fixture: ComponentFixture<Host>;
}

function render(): Rendered {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fixture };
}

describe('Dialog', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the backdrop, the card and whatever the dialog put in it', () => {
    const { host } = render();

    const card = host.querySelector('.modal-card') as HTMLElement;
    expect(host.querySelector('.modal-layer')).not.toBeNull();
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    expect(card.getAttribute('aria-labelledby')).toBe('host-title');
    expect(host.querySelector('h2')?.textContent).toBe('Discard the draft?');
  });

  it('passes the role through, for the dialogs that need alertdialog', () => {
    const { host, fixture } = render();
    fixture.componentInstance.role.set('alertdialog');
    fixture.detectChanges();

    expect(host.querySelector('.modal-card')?.getAttribute('role')).toBe('alertdialog');
  });

  it('leaves on a click outside, but not on a click inside the card', () => {
    const { host, fixture } = render();
    const dismissed = fixture.componentInstance.dismissed;

    (host.querySelector('.inside') as HTMLButtonElement).click();
    expect(dismissed).not.toHaveBeenCalled();

    (host.querySelector('.modal-layer') as HTMLElement).click();
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  it('is the overlay Escape reaches while it is up, and leaves the stack when it goes', () => {
    const { fixture } = render();
    const stack = TestBed.inject(OverlayStack);
    TestBed.inject(OverlayEscape);
    const dismissed = fixture.componentInstance.dismissed;

    expect(stack.depth()).toBe(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(dismissed).toHaveBeenCalledTimes(1);

    TestBed.resetTestingModule();
    expect(stack.depth()).toBe(0);
  });
});
