import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTE_HOVER_DELAY_MS, NoteHoverDirective } from './note-hover.directive';

/** A stand-in host: one trigger with a note the test can change mid-flight. */
@Component({
  imports: [NoteHoverDirective],
  template: `<span class="trigger" [morseNoteHover]="note()">✎ note</span>`,
})
class Host {
  readonly note = signal('');
}

function render(note: string): {
  fixture: ComponentFixture<Host>;
  trigger: HTMLElement;
  host: Host;
} {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.note.set(note);
  fixture.detectChanges();
  return {
    fixture,
    host: fixture.componentInstance,
    trigger: fixture.nativeElement.querySelector('.trigger') as HTMLElement,
  };
}

describe('NoteHoverDirective', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the rendered note after the pointer rests on the trigger', async () => {
    const { fixture, trigger } = render('**why** this range');
    trigger.dispatchEvent(new PointerEvent('pointerenter'));
    // Nothing yet: the delay is what tells "resting here" from "passing through".
    expect(fixture.nativeElement.querySelector('morse-note-hover')).toBeNull();

    await vi.advanceTimersByTimeAsync(NOTE_HOVER_DELAY_MS);
    fixture.detectChanges();
    const card = fixture.nativeElement.querySelector('morse-note-hover') as HTMLElement;
    expect(card).not.toBeNull();
    // The card renders the markdown itself, not the raw text.
    expect(card.querySelector('.md')?.innerHTML).toContain('<strong>why</strong>');
  });

  it('never appears for a pin with nothing written', async () => {
    const { fixture, trigger } = render('   ');
    trigger.dispatchEvent(new PointerEvent('pointerenter'));
    await vi.advanceTimersByTimeAsync(NOTE_HOVER_DELAY_MS);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('morse-note-hover')).toBeNull();
  });

  it('leaves as soon as the pointer does', async () => {
    const { fixture, trigger } = render('the fallback');
    trigger.dispatchEvent(new PointerEvent('pointerenter'));
    await vi.advanceTimersByTimeAsync(NOTE_HOVER_DELAY_MS);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('morse-note-hover')).not.toBeNull();

    trigger.dispatchEvent(new PointerEvent('pointerleave'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('morse-note-hover')).toBeNull();
  });

  it('does not appear when the pointer only passes through', async () => {
    const { fixture, trigger } = render('the fallback');
    trigger.dispatchEvent(new PointerEvent('pointerenter'));
    await vi.advanceTimersByTimeAsync(NOTE_HOVER_DELAY_MS - 50);
    trigger.dispatchEvent(new PointerEvent('pointerleave'));
    await vi.advanceTimersByTimeAsync(NOTE_HOVER_DELAY_MS);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('morse-note-hover')).toBeNull();
  });

  it('dismisses on a press, so the editor it opens is not covered', async () => {
    const { fixture, trigger } = render('the fallback');
    trigger.dispatchEvent(new PointerEvent('pointerenter'));
    await vi.advanceTimersByTimeAsync(NOTE_HOVER_DELAY_MS);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('morse-note-hover')).not.toBeNull();

    trigger.dispatchEvent(new PointerEvent('pointerdown'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('morse-note-hover')).toBeNull();
  });

  it('gets out of the way when anything scrolls under it', async () => {
    const { fixture, trigger } = render('the fallback');
    trigger.dispatchEvent(new PointerEvent('pointerenter'));
    await vi.advanceTimersByTimeAsync(NOTE_HOVER_DELAY_MS);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('morse-note-hover')).not.toBeNull();

    // A fixed card would drift from a trigger inside a scrolling pane.
    window.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('morse-note-hover')).toBeNull();
  });
});
