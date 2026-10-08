import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostCapabilities, InteractionRequest } from '@morse/protocol';
import { MorseService } from '../../../host/morse.service';
import { InteractionPanel, parseOption } from './interaction';

interface Fake {
  pendingInteraction: Signal<InteractionRequest | null>;
  capabilities: Signal<HostCapabilities | null>;
  respond: ReturnType<typeof vi.fn>;
}

/**
 * The panel is the browser host's fallback for pi's whole dialog sub-protocol
 * (`select`, `confirm`, `input`, `editor`), so the things worth locking are: it
 * hides where the host answers natively, every path sends exactly one
 * `interaction/respond` naming the request, and an option's own number is never
 * printed twice.
 */
function render(
  request: InteractionRequest | null,
  nativeDialogs = false,
): { host: HTMLElement; fake: Fake } {
  const fake: Fake = {
    pendingInteraction: signal(request).asReadonly(),
    capabilities: signal({ nativeDialogs } as HostCapabilities).asReadonly(),
    respond: vi.fn(),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InteractionPanel],
    providers: [{ provide: MorseService, useValue: fake }],
  });
  const fixture = TestBed.createComponent(InteractionPanel);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fake };
}

/**
 * pi sends `options: string[]`, and a plugin numbering its own list would get a
 * second number from us. The marker is reused when it agrees with the position.
 */
describe('parseOption', () => {
  it('reuses a marker that matches the position', () => {
    expect(parseOption({ value: 'a', label: '1. Do the thing' }, 0)).toEqual({
      value: 'a',
      ordinal: '1.',
      label: 'Do the thing',
    });
  });

  it('supplies its own marker when the option has none', () => {
    expect(parseOption({ value: 'a', label: 'Do the thing' }, 1)).toEqual({
      value: 'a',
      ordinal: '2.',
      label: 'Do the thing',
    });
  });

  it('ignores a number that does not match, so the text survives intact', () => {
    // "3." on the first row is part of the sentence, not a marker.
    expect(parseOption({ value: 'a', label: '3.5 days left' }, 0).label).toBe('3.5 days left');
  });
});

const selectRequest: InteractionRequest = {
  requestId: 'r1',
  kind: 'select',
  title: 'Which database?',
  options: [
    { value: 'pg', label: '1. PostgreSQL' },
    { value: 'sqlite', label: '2. SQLite' },
  ],
};

describe('InteractionPanel', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders nothing without a request', () => {
    expect(render(null).host.querySelector('.card')).toBeNull();
  });

  it('stays out of the way where the host shows native dialogs', () => {
    expect(render(selectRequest, true).host.querySelector('.card')).toBeNull();
  });

  it('renders a select as full-width option rows without doubling the number', () => {
    const { host } = render(selectRequest);

    expect(host.querySelector('h2')?.textContent?.trim()).toBe('Which database?');
    const rows = [...host.querySelectorAll('.option')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.option-ordinal')?.textContent?.trim()).toBe('1.');
    expect(rows[0]?.querySelector('.option-label')?.textContent?.trim()).toBe('PostgreSQL');
  });

  it('answers a select with the option value', () => {
    const { host, fake } = render(selectRequest);

    (host.querySelectorAll('.option')[1] as HTMLButtonElement).click();

    expect(fake.respond).toHaveBeenCalledTimes(1);
    expect(fake.respond).toHaveBeenCalledWith({ requestId: 'r1', value: 'sqlite' });
  });

  /**
   * A plugin folding its list into the title (pi's `select` has no body field) must
   * still read as a list, so the header keeps the first line only.
   */
  it('splits a multi-line title into a heading and body text', () => {
    const { host } = render({
      ...selectRequest,
      title: 'Pick a mode\n\n1. Fast\n2. Careful',
    });

    expect(host.querySelector('h2')?.textContent?.trim()).toBe('Pick a mode');
    expect(host.querySelector('.message')?.textContent).toContain('1. Fast');
  });

  it('answers a confirm with a boolean, and warns when the plugin said danger', () => {
    const { host, fake } = render({
      requestId: 'r2',
      kind: 'confirm',
      title: 'Clear the session?',
      message: 'All messages are lost.',
      danger: true,
    });

    expect(host.querySelector('.card')?.classList.contains('danger')).toBe(true);
    (host.querySelector('.actions button:not(.secondary)') as HTMLButtonElement).click();
    expect(fake.respond).toHaveBeenCalledWith({ requestId: 'r2', confirmed: true });
  });

  it('submits the typed input value', () => {
    const { host, fake } = render({
      requestId: 'r3',
      kind: 'input',
      title: 'Project name',
      placeholder: 'my-app',
    });

    const field = host.querySelector('.field') as HTMLInputElement;
    expect(field.placeholder).toBe('my-app');
    field.value = 'morse';
    field.dispatchEvent(new Event('input'));
    (host.querySelector('.actions button:not(.secondary)') as HTMLButtonElement).click();

    expect(fake.respond).toHaveBeenCalledWith({ requestId: 'r3', value: 'morse' });
  });

  it('seeds the editor with the prefill, so it is editable and submittable', () => {
    const { host } = render({
      requestId: 'r4',
      kind: 'editor',
      title: 'Edit the prompt',
      value: 'line one',
    });

    expect((host.querySelector('textarea.field') as HTMLTextAreaElement).value).toBe('line one');
  });

  it('cancels on Escape', () => {
    const { fake } = render(selectRequest);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(fake.respond).toHaveBeenCalledWith({ requestId: 'r1', cancelled: true });
  });
});
