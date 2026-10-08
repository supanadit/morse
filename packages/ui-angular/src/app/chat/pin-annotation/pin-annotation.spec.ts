import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { PinAnnotation } from './pin-annotation';

/**
 * The editor is anchored and driven entirely by inputs and events, so it needs no
 * services at all: these tests exercise the writing surface (toolbar, shortcuts,
 * the in-place mirror) and the two ways out.
 */
function render(
  note = '',
  target: { path: string; range?: string } = { path: 'src/index.ts', range: 'L30-31' },
): {
  fixture: ComponentFixture<PinAnnotation>;
  host: HTMLElement;
  area: HTMLTextAreaElement;
  saved: string[];
  cancelled: number[];
} {
  const fixture = TestBed.createComponent(PinAnnotation);
  fixture.componentRef.setInput('anchor', { top: 200, left: 100, width: 40, height: 20 });
  fixture.componentRef.setInput('target', target);
  fixture.componentRef.setInput('note', note);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const saved: string[] = [];
  const cancelled: number[] = [];
  fixture.componentInstance.save.subscribe((value) => saved.push(value));
  fixture.componentInstance.cancel.subscribe(() => cancelled.push(1));
  return {
    fixture,
    host,
    area: host.querySelector('.input') as HTMLTextAreaElement,
    saved,
    cancelled,
  };
}

/** Types into the textarea the way a user does: value, then an input event. */
function type(area: HTMLTextAreaElement, value: string, fixture: ComponentFixture<PinAnnotation>): void {
  area.value = value;
  area.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

/** Selects a span of the current text, as a drag would. */
function select(area: HTMLTextAreaElement, start: number, end: number): void {
  area.selectionStart = start;
  area.selectionEnd = end;
}

function press(host: HTMLElement, label: string): void {
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click();
}

describe('PinAnnotation', () => {
  it('opens with the pin\u2019s own note and names what it annotates', () => {
    const { host, area } = render('the range that broke');
    expect(area.value).toBe('the range that broke');
    expect(host.querySelector('.target')?.textContent).toContain('src/index.ts');
    expect(host.querySelector('.range')?.textContent).toContain('L30-31');
  });

  it('renders the draft as markdown in place, while it is being typed', () => {
    const { fixture, host, area } = render();
    type(area, '**bold** and `code`', fixture);
    const mirror = host.querySelector('.mirror code') as HTMLElement;
    // The textarea stays the markdown source; the mirror is the styled rendering.
    expect(area.value).toBe('**bold** and `code`');
    expect(mirror.innerHTML).toContain('<span class="b">bold</span>');
    expect(mirror.innerHTML).toContain('<span class="code">code</span>');
  });

  it('wraps the selection in bold from the toolbar', () => {
    const { fixture, host, area } = render();
    type(area, 'hello world', fixture);
    select(area, 0, 5);
    press(host, 'Bold');
    fixture.detectChanges();
    expect(area.value).toBe('**hello** world');
    // The wrapped words stay selected, so the next tool acts on the same run.
    expect(area.selectionStart).toBe(2);
    expect(area.selectionEnd).toBe(7);
  });

  it('has the markdown shortcuts: ⌘/Ctrl+B, I, E', () => {
    const { fixture, area } = render();
    type(area, 'hello', fixture);
    select(area, 0, 5);
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
    fixture.detectChanges();
    expect(area.value).toBe('**hello**');

    select(area, 2, 7);
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }));
    fixture.detectChanges();
    expect(area.value).toBe('**`hello`**');
  });

  it('numbers every line of a numbered list', () => {
    const { fixture, host, area } = render();
    type(area, 'first\nsecond', fixture);
    select(area, 0, 12);
    press(host, 'Numbered list');
    fixture.detectChanges();
    expect(area.value).toBe('1. first\n2. second');
  });

  it('prefixes a bullet and a heading without touching other lines', () => {
    const { fixture, host, area } = render();
    type(area, 'keep\nchange\nkeep too', fixture);
    select(area, 5, 11);
    press(host, 'Bulleted list');
    fixture.detectChanges();
    expect(area.value).toBe('keep\n- change\nkeep too');

    select(area, 5, 13);
    press(host, 'Heading');
    fixture.detectChanges();
    expect(area.value).toBe('keep\n## - change\nkeep too');
  });

  it('inserts a link and selects its target for the next keystroke', () => {
    const { fixture, host, area } = render();
    type(area, 'see the docs', fixture);
    select(area, 8, 12);
    press(host, 'Link');
    fixture.detectChanges();
    expect(area.value).toBe('see the [docs](url)');
    // `url` is selected, so typing replaces the placeholder.
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe('url');
  });

  it('fences a selected block as code', () => {
    const { fixture, host, area } = render();
    type(area, 'const a = 1;', fixture);
    select(area, 0, 12);
    press(host, 'Code block');
    fixture.detectChanges();
    expect(area.value).toBe('```\nconst a = 1;\n```\n');
  });

  it('saves the markdown as it stands on ⌘/Ctrl+⏎', () => {
    const { fixture, area, saved } = render();
    type(area, '**why** this range', fixture);
    area.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    expect(saved).toEqual(['**why** this range']);
  });

  it('cancels on Escape, on the button, and on a press outside', () => {
    const outside = render();
    outside.area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(outside.cancelled).toHaveLength(1);
    (outside.host.querySelector('button.secondary') as HTMLButtonElement).click();
    expect(outside.cancelled).toHaveLength(2);

    const inside = render();
    // A press on the card itself is not "outside".
    inside.host.querySelector('.toolbar')?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    expect(inside.cancelled).toHaveLength(0);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(inside.cancelled).toHaveLength(1);
  });
});
