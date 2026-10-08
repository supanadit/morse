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

  it('names the command a production user has, not only the repo script', () => {
    const fixture = TestBed.createComponent(ConnectionScreen);
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const rows = [...element.querySelectorAll('.help-cmd')];
    // Someone who installed the CLI must not be told to run a monorepo script.
    expect(rows.map((row) => row.querySelector('code')?.textContent?.trim())).toEqual([
      'morse start',
      'npm run dev:server',
    ]);
    expect(rows.map((row) => row.querySelector('.help-label')?.textContent?.trim())).toEqual([
      'installed CLI',
      'from the repo',
    ]);
    // Stopping the host is how most people end up on this screen, and the install
    // path matters for the case where there is no CLI yet.
    expect(element.textContent).toContain('morse stop');
    expect(element.textContent).toContain('npm install -g @supanadit/morse-web');
  });

  it('emits the typed server url when the form is submitted', () => {    const fixture = TestBed.createComponent(ConnectionScreen);
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
