import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ThinkingLevel } from '@morse/protocol';
import { brainIntensity } from './thinking-brain';
import { ThinkingPicker } from './thinking-picker';

describe('brainIntensity', () => {
  it('ranks levels so the halo rings grow with effort', () => {
    expect(brainIntensity('off')).toBe(0);
    expect(brainIntensity('medium')).toBe(3);
    expect(brainIntensity('max')).toBe(6);
  });

  it('falls back to a modest default for an unknown level', () => {
    expect(brainIntensity('weird')).toBe(2);
  });
});

describe('ThinkingPicker', () => {
  const LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ThinkingPicker] });
  });

  function create(current: ThinkingLevel = 'medium') {
    const fixture = TestBed.createComponent(ThinkingPicker);
    fixture.componentRef.setInput('levels', LEVELS);
    fixture.componentRef.setInput('current', current);
    fixture.detectChanges();
    return fixture;
  }

  it('shows the current level on an animated brain trigger', () => {
    const fixture = create();
    const trigger = fixture.nativeElement.querySelector('.trigger') as HTMLElement;

    expect(trigger.textContent).toContain('medium');
    expect(trigger.querySelector('morse-brain')).toBeTruthy();
  });

  it('opens a themed list instead of a native select', () => {
    const fixture = create();
    expect(fixture.nativeElement.querySelector('.panel')).toBeNull();

    (fixture.nativeElement.querySelector('.trigger') as HTMLElement).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.row')).toHaveLength(LEVELS.length);
    expect(fixture.nativeElement.querySelector('select')).toBeNull();
  });

  it('emits the picked level and closes', () => {
    const fixture = create();
    const picked: ThinkingLevel[] = [];
    fixture.componentInstance.pick.subscribe((level) => picked.push(level));

    (fixture.nativeElement.querySelector('.trigger') as HTMLElement).click();
    fixture.detectChanges();
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.row');
    rows[4]?.click();
    fixture.detectChanges();

    expect(picked).toEqual(['high']);
    expect(fixture.nativeElement.querySelector('.panel')).toBeNull();
  });

  it('says it is reading the picked model\'s levels, and refuses a pick until they land', () => {
    const fixture = create('medium');
    const picked: ThinkingLevel[] = [];
    fixture.componentInstance.pick.subscribe((level) => picked.push(level));
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();

    // The wait is visible without opening anything: the trigger spins where the
    // caret was, and says what it is waiting for.
    const trigger = fixture.nativeElement.querySelector('.trigger') as HTMLElement;
    expect(trigger.querySelector('.spinner')).toBeTruthy();
    expect(trigger.querySelector('.caret')).toBeNull();
    expect(trigger.getAttribute('aria-busy')).toBe('true');

    trigger.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.status')?.textContent).toContain(
      'Reading this model',
    );

    // The previous model's rows stay on screen (the panel must not jump under the
    // pointer) but they are not pickable: that level may not exist on this model.
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
      '.row',
    );
    expect(rows).toHaveLength(LEVELS.length);
    expect([...rows].every((row) => row.disabled)).toBe(true);
    rows[4]?.click();
    fixture.detectChanges();
    expect(picked).toEqual([]);
    expect(fixture.nativeElement.querySelector('.panel')).not.toBeNull();

    const panel = fixture.nativeElement.querySelector('.panel') as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(picked).toEqual([]);
  });

  it('picks with the keyboard', () => {
    const fixture = create('off');
    const picked: ThinkingLevel[] = [];
    fixture.componentInstance.pick.subscribe((level) => picked.push(level));

    (fixture.nativeElement.querySelector('.trigger') as HTMLElement).click();
    fixture.detectChanges();
    const panel = fixture.nativeElement.querySelector('.panel') as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(picked).toEqual(['minimal']);
    expect(fixture.nativeElement.querySelector('.panel')).toBeNull();
  });

  it('closes on Escape and on an outside pointer press', () => {
    const fixture = create();

    (fixture.nativeElement.querySelector('.trigger') as HTMLElement).click();
    fixture.detectChanges();
    const panel = fixture.nativeElement.querySelector('.panel') as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.panel')).toBeNull();

    (fixture.nativeElement.querySelector('.trigger') as HTMLElement).click();
    fixture.detectChanges();
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.panel')).toBeNull();
  });
});
