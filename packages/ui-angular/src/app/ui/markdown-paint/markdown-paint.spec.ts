import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownPaint } from './markdown-paint';

@Component({
  imports: [MarkdownPaint],
  template: `<morse-markdown-paint [value]="value()"><textarea></textarea></morse-markdown-paint>`,
})
class PaintHost {
  readonly value = signal('plain **bold** `code`');
}

const SAMPLE = ['# H', '```json', '{"a": 1}', '```', '- `x` **y** [z](u)'].join('\n');

function mount(): {
  fixture: ComponentFixture<PaintHost>;
  root: HTMLElement;
  paint: HTMLElement;
  area: HTMLTextAreaElement;
} {
  const fixture = TestBed.createComponent(PaintHost);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    root: host,
    paint: host.querySelector('.paint') as HTMLElement,
    area: host.querySelector('textarea') as HTMLTextAreaElement,
  };
}

/**
 * Hands the scheduled frame callbacks to the test. Angular's zoneless scheduler
 * also uses requestAnimationFrame, so each request is tagged by its call stack:
 * `mine()` counts only frames the paint layer scheduled.
 */
function frameQueue(): { mine(): number; flush(): void } {
  const pending: Array<{ callback: FrameRequestCallback; mine: boolean }> = [];
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    pending.push({ callback, mine: (new Error().stack ?? '').includes('MarkdownPaint') });
    return pending.length;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  return {
    mine: () => pending.filter((frame) => frame.mine).length,
    flush(): void {
      for (const { callback } of pending.splice(0)) {
        callback(0);
      }
    },
  };
}

describe('MarkdownPaint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('paints the buffer’s exact characters, decorated and hidden from AT', () => {
    const frames = frameQueue();
    TestBed.configureTestingModule({ imports: [MarkdownPaint] });
    const { fixture, root, paint } = mount();
    const component = root.querySelector('morse-markdown-paint') as HTMLElement;

    fixture.componentInstance.value.set(SAMPLE);
    fixture.detectChanges();
    frames.flush();
    fixture.detectChanges();

    // The geometry contract: the mirror holds the buffer's characters exactly.
    expect(paint.textContent).toBe(SAMPLE);
    expect(paint.getAttribute('aria-hidden')).toBe('true');
    expect(paint.querySelector('.md-fence')?.textContent).toBe('```json');
    expect(paint.querySelector('.md-strong')?.textContent).toBe('**y**');
    expect(paint.querySelectorAll('.md-code')).toHaveLength(1);
    expect(paint.querySelectorAll('span[class^="md-"]').length).toBeGreaterThan(3);
    expect(component.classList.contains('composing')).toBe(false);
  });

  /**
   * The mirror and the textarea are one view: identical metrics mean identical
   * wrapping, so a painted line sits exactly under the line it decorates.
   * jsdom has no layout engine and does not resolve `var()`, so the contract
   * is asserted where it lives — one set of metrics on the host, read by both
   * layers (the rendered-row check is the browser pass in tasks 4.1/4.2).
   */
  it('keeps the mirror aligned with the textarea: one set of metrics, one box', () => {
    frameQueue();
    TestBed.configureTestingModule({ imports: [MarkdownPaint] });
    const { fixture, root, paint, area } = mount();
    fixture.componentInstance.value.set(SAMPLE);
    fixture.detectChanges();

    const host = root.querySelector('morse-markdown-paint') as HTMLElement;
    const styles = [...document.querySelectorAll('style')]
      .map((style) => style.textContent ?? '')
      .join('\n');
    // The shared metrics exist, and both layers read the same source.
    expect(getComputedStyle(host).getPropertyValue('--mdp-padding')).toBe('4px 6px');
    expect(getComputedStyle(host).getPropertyValue('--mdp-line-height')).toBe('1.5');
    expect(styles).toMatch(/\.paint[^{]*\{[^}]*padding: var\(--mdp-padding\)/);
    expect(styles).toMatch(/\.paint[^{]*\{[^}]*line-height: var\(--mdp-line-height\)/);
    // Same box, same scrolling surface: the mirror covers the textarea's area.
    expect(paint.getBoundingClientRect().height).toBe(area.getBoundingClientRect().height);
    expect(paint.scrollHeight).toBe(area.scrollHeight);
    expect(paint.textContent).toBe(area.value);
  });

  it('coalesces a burst of typing into one paint per frame, never on the input path', () => {
    const frames = frameQueue();
    TestBed.configureTestingModule({ imports: [MarkdownPaint] });
    const { fixture, paint, root } = mount();
    const host = fixture.componentInstance;
    // Drain the initial paint so the frame window starts empty.
    frames.flush();
    fixture.detectChanges();
    frames.flush();

    // One input event schedules one paint — and the input path itself never
    // paints: a keystroke never waits on decoration.
    host.value.set('draft');
    fixture.detectChanges();
    expect(frames.mine()).toBe(1);
    expect(paint.textContent).toBe('plain **bold** `code`');
    frames.flush();
    fixture.detectChanges();
    expect(paint.textContent).toBe('draft');

    // Five input events in the same frame coalesce into exactly one paint.
    for (let i = 0; i < 5; i += 1) {
      host.value.set(`draft ${i}`);
      fixture.detectChanges();
    }
    expect(frames.mine()).toBe(1);
    frames.flush();
    fixture.detectChanges();
    expect(paint.textContent).toBe('draft 4');
    expect(root.querySelectorAll('.paint')).toHaveLength(1);
  });

  it('scrolls the mirror where the textarea scrolls', () => {
    const frames = frameQueue();
    TestBed.configureTestingModule({ imports: [MarkdownPaint] });
    const { fixture, paint, area } = mount();
    fixture.componentInstance.value.set(SAMPLE);
    fixture.detectChanges();
    frames.flush();

    let scrolled = -1;
    Object.defineProperty(area, 'scrollTop', { value: 42, configurable: true });
    Object.defineProperty(paint, 'scrollTop', {
      get: () => 0,
      set: (value: number) => {
        scrolled = value;
      },
      configurable: true,
    });
    area.dispatchEvent(new Event('scroll'));
    expect(scrolled).toBe(42);
  });

  it('shows the textarea’s own text during IME composition, painting after it settles', () => {
    const frames = frameQueue();
    TestBed.configureTestingModule({ imports: [MarkdownPaint] });
    const { fixture, paint, area, root } = mount();
    const host = fixture.componentInstance;
    const component = root.querySelector('morse-markdown-paint') as HTMLElement;

    area.dispatchEvent(new CompositionEvent('compositionstart'));
    fixture.detectChanges();
    expect(component.classList.contains('composing')).toBe(true);
    expect(paint.classList.contains('composing')).toBe(true);

    // While composing, the buffer lags behind the composition; painting it now
    // would show stale text under the textarea's own composition text.
    host.value.set('partial');
    fixture.detectChanges();
    frames.flush();
    fixture.detectChanges();
    expect(paint.textContent).toBe('');

    area.dispatchEvent(new CompositionEvent('compositionend'));
    fixture.detectChanges();
    frames.flush();
    fixture.detectChanges();
    expect(component.classList.contains('composing')).toBe(false);
    expect(paint.textContent).toBe('partial');
  });

  /**
   * Worst-case draft: ~50 KB of mixed markdown. The keystroke path only flips
   * a signal — the scan never runs inside it, so a keystroke never waits on
   * decoration regardless of draft size. The frame-time budget itself is
   * asserted where the scanner runs without jsdom/parallel-spec noise, in
   * `decorate.spec.ts`; this records the end-to-end numbers.
   */
  it('paints a ~50 KB draft in one frame and keeps keystrokes off the scan', () => {
    const frames = frameQueue();
    TestBed.configureTestingModule({ imports: [MarkdownPaint] });
    const { fixture, paint } = mount();
    const host = fixture.componentInstance;
    frames.flush();
    fixture.detectChanges();
    frames.flush();
    const painted = paint.textContent;

    const unit = [
      '## Section',
      'Prose with **bold**, *em*, `inline` and [a link](https://example.com).',
      '```ts',
      'const answer: number = 42;',
      '```',
      '- item one',
      '- item two',
      '',
    ].join('\n');
    const draft = unit.repeat(Math.ceil(50_000 / unit.length));
    expect(draft.length).toBeGreaterThanOrEqual(50_000);

    // The keystroke: a signal flip and change detection, no decoration work.
    const typedAt = performance.now();
    host.value.set(draft);
    fixture.detectChanges();
    const keystrokeMs = performance.now() - typedAt;
    expect(paint.textContent).toBe(painted); // nothing painted on the input path

    const paintedAt = performance.now();
    frames.flush();
    const paintMs = performance.now() - paintedAt;
    fixture.detectChanges();
    expect(paint.textContent).toBe(draft);
    expect(keystrokeMs).toBeLessThan(16);
    process.stdout.write(
      `\n[markdown-paint] 50 KB draft: keystroke ${keystrokeMs.toFixed(2)} ms, paint ${paintMs.toFixed(2)} ms\n`,
    );
  });
});
