import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptySession } from './empty';

function render(hasTabs = false) {
  const fixture = TestBed.createComponent(EmptySession);
  fixture.componentRef.setInput('hasTabs', hasTabs);
  fixture.detectChanges();
  return fixture;
}

describe('EmptySession', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('tells the reader to start a session when none is open', () => {
    const fixture = render();

    expect(fixture.nativeElement.textContent).toContain('No session open');
    expect(fixture.nativeElement.textContent).toContain('Start a new session');
    // The one action the placeholder offers.
    expect(fixture.nativeElement.querySelector('button')?.textContent?.trim()).toBe('New session');
  });

  it('offers to pick an already-open tab instead when there is one', () => {
    const fixture = render(true);

    expect(fixture.nativeElement.textContent).toContain('Pick a session from the tabs above');
    expect(fixture.nativeElement.textContent).not.toContain('Start a new session to talk');
  });

  it('emits create from its button', () => {
    const fixture = render();
    const create = vi.fn();
    fixture.componentInstance.create.subscribe(create);

    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();

    expect(create).toHaveBeenCalledTimes(1);
  });
});
