import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

/**
 * The point of this dialog is that a stray click cannot confirm it. The tests lock
 * both halves of that: the safe button is the focused one, and every other way out
 * (Escape, the backdrop) cancels.
 */

interface Rendered {
  host: HTMLElement;
  fixture: ComponentFixture<ConfirmDialog>;
}

function render(): Rendered {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [ConfirmDialog] });
  const fixture = TestBed.createComponent(ConfirmDialog);
  fixture.componentRef.setInput('title', 'Compact the conversation?');
  fixture.componentRef.setInput('body', 'pi replaces what it is holding with a summary.');
  fixture.componentRef.setInput('note', 'This cannot be undone.');
  fixture.componentRef.setInput('confirmLabel', 'Compact context');
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fixture };
}

/** The focus is deferred a tick, so the DOM settles before it lands. */
const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('ConfirmDialog', () => {
  it('renders the question, the consequence and both choices', () => {
    const { host } = render();

    expect(host.querySelector('h2')?.textContent).toContain('Compact the conversation?');
    expect(host.querySelector('.body')?.textContent).toContain('summary');
    expect(host.querySelector('.note')?.textContent).toContain('cannot be undone');
    const labels = [...host.querySelectorAll('.actions button')].map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).toEqual(['Cancel', 'Compact context']);
  });

  it('lands focus on Cancel, so the click that opened it cannot confirm it', async () => {
    const { host } = render();
    await nextTick();

    expect(document.activeElement).toBe(host.querySelector('.actions button.secondary'));
  });

  it('confirms only when the confirm button is used', () => {
    const { host, fixture } = render();
    const confirmed = vi.fn();
    const cancelled = vi.fn();
    fixture.componentInstance.confirmed.subscribe(confirmed);
    fixture.componentInstance.cancelled.subscribe(cancelled);

    (host.querySelector('.actions button:not(.secondary)') as HTMLButtonElement).click();

    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('cancels on Escape and on the backdrop, but not when the card is clicked', () => {
    const { host, fixture } = render();
    const cancelled = vi.fn();
    const confirmed = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);
    fixture.componentInstance.confirmed.subscribe(confirmed);

    // A click inside the card is a click on the question, not a way out.
    (host.querySelector('.modal-card') as HTMLElement).click();
    expect(cancelled).not.toHaveBeenCalled();

    (host.querySelector('.modal-layer') as HTMLElement).click();
    expect(cancelled).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(cancelled).toHaveBeenCalledTimes(2);
    expect(confirmed).not.toHaveBeenCalled();
  });
});
