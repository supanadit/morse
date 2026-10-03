import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionScreen } from './connection-screen';

describe('ConnectionScreen', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ConnectionScreen] }).compileComponents();
  });

  it('shows the given copy and offers retry / explore', () => {
    const fixture = TestBed.createComponent(ConnectionScreen);
    fixture.componentRef.setInput('title', 'Morse is waiting for a host');
    fixture.componentRef.setInput('body', 'Start a host and this clears itself.');
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.title')?.textContent).toContain('waiting for a host');
    expect(element.textContent).toContain('Start a host and this clears itself.');

    const retry = vi.fn();
    const explore = vi.fn();
    fixture.componentInstance.retry.subscribe(retry);
    fixture.componentInstance.explore.subscribe(explore);
    (element.querySelector('.actions .primary') as HTMLButtonElement).click();
    (element.querySelector('.actions .ghost') as HTMLButtonElement).click();

    expect(retry).toHaveBeenCalledTimes(1);
    expect(explore).toHaveBeenCalledTimes(1);
  });

  it('emits the typed server url when the form is submitted', () => {
    const fixture = TestBed.createComponent(ConnectionScreen);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector('.server input') as HTMLInputElement;
    input.value = 'ws://localhost:4399';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const connect = vi.fn();
    fixture.componentInstance.connect.subscribe(connect);
    (element.querySelector('.server') as HTMLFormElement).dispatchEvent(new Event('submit'));

    expect(connect).toHaveBeenCalledWith('ws://localhost:4399');
  });
});
