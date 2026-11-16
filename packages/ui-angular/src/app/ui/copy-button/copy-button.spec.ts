import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from './copy-button';

/**
 * The copy control both transcripts draw. What matters is not the clipboard call
 * — the browser owns that — but the two states a reader sees, that the words
 * after the glyph follow whatever the host row asked for, and that a component
 * torn down mid-confirmation leaves no timer behind.
 */
function render(inputs: { text: string; label?: string; title?: string; copiedTitle?: string }): {
  fixture: ComponentFixture<CopyButton>;
  host: HTMLElement;
} {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(CopyButton);
  fixture.componentRef.setInput('text', inputs.text);
  if (inputs.label !== undefined) {
    fixture.componentRef.setInput('label', inputs.label);
  }
  if (inputs.title !== undefined) {
    fixture.componentRef.setInput('title', inputs.title);
  }
  if (inputs.copiedTitle !== undefined) {
    fixture.componentRef.setInput('copiedTitle', inputs.copiedTitle);
  }
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(() => Promise.resolve());
  Object.assign(navigator, { clipboard: { writeText } });
  return writeText;
}

describe('CopyButton', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('copies the text it was given, once per click', async () => {
    const writeText = stubClipboard();
    const { host } = render({ text: 'the **answer** as markdown' });

    (host.querySelector('.copy-msg') as HTMLButtonElement).click();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('the **answer** as markdown');
  });

  it('shows the glyph alone when no label is given, and the label when one is', async () => {
    stubClipboard();
    const bare = render({ text: 'x' });
    expect(bare.host.querySelector('.copy-msg')?.textContent?.trim()).toBe('⧉');
    bare.fixture.destroy();

    const labelled = render({ text: 'x', label: 'Copy' });
    expect(labelled.host.querySelector('.copy-msg')?.textContent?.trim()).toBe('⧉ Copy');
  });

  it('says so after copying, and offers again a moment later', async () => {
    vi.useFakeTimers();
    stubClipboard();
    const { fixture, host } = render({ text: 'x', label: 'Copy', title: 'Copy response' });
    const button = host.querySelector('.copy-msg') as HTMLButtonElement;

    button.click();
    fixture.detectChanges();
    expect(button.textContent?.trim()).toBe('✓ Copied');
    // Revealed while it confirms, so the tick is not hidden by the row's hover.
    expect(button.classList.contains('revealed')).toBe(true);
    expect(button.getAttribute('title')).toBe('Copied');

    vi.advanceTimersByTime(1200);
    fixture.detectChanges();
    expect(button.textContent?.trim()).toBe('⧉ Copy');
    expect(button.classList.contains('revealed')).toBe(false);
  });

  it('keeps the host row’s own words for the tooltip', async () => {
    stubClipboard();
    const { host } = render({ text: 'x', title: 'Copy message', copiedTitle: 'Copied' });
    const button = host.querySelector('.copy-msg') as HTMLButtonElement;

    expect(button.getAttribute('title')).toBe('Copy message');
  });

  it('drops its timer when the row it lives in goes away', async () => {
    vi.useFakeTimers();
    stubClipboard();
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const { fixture, host } = render({ text: 'x' });

    (host.querySelector('.copy-msg') as HTMLButtonElement).click();
    fixture.destroy();

    // The confirmation belongs to a control that no longer exists; its timer must
    // not outlive it.
    expect(clear).toHaveBeenCalled();
  });
});
