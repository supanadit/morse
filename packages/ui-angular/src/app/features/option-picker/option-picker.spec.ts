import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { OptionPicker, type PickerOption } from './option-picker';

describe('OptionPicker', () => {
  const OPTIONS: PickerOption[] = [
    { id: 'build', label: 'Build', description: 'The default agent', badge: 'default' },
    { id: 'plan', label: 'Plan', description: 'Think before acting' },
  ];

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [OptionPicker] });
  });

  function create(current = 'build', loading = false) {
    const fixture = TestBed.createComponent(OptionPicker);
    fixture.componentRef.setInput('options', OPTIONS);
    fixture.componentRef.setInput('current', current);
    fixture.componentRef.setInput('label', 'Mode');
    fixture.componentRef.setInput('loading', loading);
    fixture.detectChanges();
    return fixture;
  }

  function trigger(fixture: ReturnType<typeof create>): HTMLElement {
    return fixture.nativeElement.querySelector('.trigger') as HTMLElement;
  }

  it('names the current option on a themed trigger', () => {
    const fixture = create();
    expect(trigger(fixture).textContent).toContain('Build');
    expect(fixture.nativeElement.querySelector('select')).toBeNull();
  });

  it('opens a listbox with descriptions and the default badge', () => {
    const fixture = create();
    trigger(fixture).click();
    fixture.detectChanges();

    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('The default agent');
    expect(rows[0]?.textContent).toContain('default');
    expect(rows[1]?.textContent).toContain('Think before acting');
    expect(fixture.nativeElement.querySelector('.panel')?.getAttribute('role')).toBe('listbox');
  });

  it('emits the picked id and closes', () => {
    const fixture = create();
    const picked: string[] = [];
    fixture.componentInstance.pick.subscribe((id) => picked.push(id));

    trigger(fixture).click();
    fixture.detectChanges();
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('.row');
    rows[1]?.click();
    fixture.detectChanges();

    expect(picked).toEqual(['plan']);
    expect(fixture.nativeElement.querySelector('.panel')).toBeNull();
  });

  it('moves with the arrow keys and picks with Enter', () => {
    const fixture = create();
    const picked: string[] = [];
    fixture.componentInstance.pick.subscribe((id) => picked.push(id));

    trigger(fixture).click();
    fixture.detectChanges();
    const panel = fixture.nativeElement.querySelector('.panel') as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    expect(picked).toEqual(['plan']);
  });

  it('closes on Escape', () => {
    const fixture = create();
    trigger(fixture).click();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('.panel') as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.panel')).toBeNull();
  });

  it('shows a reading row while loading and refuses a pick', () => {
    const fixture = create('build', true);
    const picked: string[] = [];
    fixture.componentInstance.pick.subscribe((id) => picked.push(id));

    expect(trigger(fixture).querySelector('.spinner')).toBeTruthy();
    trigger(fixture).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.status')?.textContent).toContain('Reading');

    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.row');
    expect([...rows].every((row) => row.disabled)).toBe(true);
    rows[0]?.click();
    fixture.detectChanges();
    expect(picked).toEqual([]);
  });

  it('announces the open so the owner can refresh the list', () => {
    const fixture = create();
    let opened = 0;
    fixture.componentInstance.opened.subscribe(() => (opened += 1));

    trigger(fixture).click();
    expect(opened).toBe(1);
  });
});
