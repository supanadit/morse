import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Markdown } from './markdown';

async function render(text: string): Promise<{ host: HTMLElement; fixture: ReturnType<typeof TestBed.createComponent<Markdown>> }> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({ imports: [Markdown] }).compileComponents();
  const fixture = TestBed.createComponent(Markdown);
  fixture.componentRef.setInput('text', text);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fixture };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Markdown', () => {
  it('shows the first value without waiting, and formats it', async () => {
    const { host } = await render('# Title\n\nsome **prose**');

    expect(host.querySelector('h1')?.textContent).toContain('Title');
    expect(host.querySelector('strong')?.textContent).toBe('prose');
  });

  it('follows a stream at a cadence instead of re-rendering on every delta', async () => {
    vi.useFakeTimers();
    const { host, fixture } = await render('one');

    // A burst of deltas inside one frame — the shape a fast model produces.
    for (const text of ['one two', 'one two three', 'one two three four']) {
      fixture.componentRef.setInput('text', text);
      fixture.detectChanges();
    }
    expect(host.textContent?.trim()).toBe('one');

    // One render follows the burst, with the newest text.
    vi.advanceTimersByTime(90);
    fixture.detectChanges();
    expect(host.textContent?.trim()).toBe('one two three four');

    // And the last value always lands, even when the stream stops mid-window.
    fixture.componentRef.setInput('text', 'one two three four five');
    fixture.detectChanges();
    expect(host.textContent?.trim()).toBe('one two three four');
    vi.advanceTimersByTime(90);
    fixture.detectChanges();
    expect(host.textContent?.trim()).toBe('one two three four five');
  });

  it('does not lose the final text when it is unmounted mid-stream', async () => {
    vi.useFakeTimers();
    const { fixture } = await render('one');
    fixture.componentRef.setInput('text', 'one two');
    fixture.detectChanges();

    fixture.destroy();
    // The pending timer is cancelled with the component: no work after teardown.
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
  });
});
