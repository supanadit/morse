import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostCapabilities, InteractionRequest } from '@morse/protocol';
import { MorseService } from '../../host/morse.service';
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
): { host: HTMLElement; fake: Fake; fixture: ReturnType<typeof TestBed.createComponent<InteractionPanel>> } {
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
  return { host: fixture.nativeElement as HTMLElement, fake, fixture };
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

const formRequest: InteractionRequest = {
  requestId: 'form-1',
  kind: 'form',
  title: 'Set up the task',
  message: 'Answer what applies.',
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Ada' },
    { key: 'retries', label: 'Retries', type: 'integer', min: 1, max: 9, defaultValue: 3 },
    {
      key: 'reason',
      label: 'Why retry?',
      type: 'text',
      when: { field: 'name', equals: 'Ada' },
    },
    {
      key: 'targets',
      label: 'Targets',
      type: 'multiselect',
      options: [
        { value: 'linux', label: 'Linux' },
        { value: 'macos', label: 'macOS' },
      ],
    },
  ],
};

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

  it('renders a form even where the host answers other kinds natively', () => {
    const { host } = render(formRequest, true);
    expect(host.querySelector('.card')).not.toBeNull();
    expect(host.querySelector('h2')?.textContent?.trim()).toBe('Set up the task');
  });

  it('renders one control per field type and hides a field until its condition holds', () => {
    const { host, fixture } = render(formRequest);

    // name (text), retries (integer, defaulted), targets (multiselect) — reason
    // is conditional on name === 'Ada' and starts hidden.
    expect(host.querySelectorAll('.form-field')).toHaveLength(3);
    expect((host.querySelector('#form-name') as HTMLInputElement).placeholder).toBe('Ada');
    expect((host.querySelector('#form-retries') as HTMLInputElement).value).toBe('3');
    expect(host.querySelector('#form-targets')).toBeNull();

    const name = host.querySelector('#form-name') as HTMLInputElement;
    name.value = 'Ada';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(host.querySelector('#form-reason')).not.toBeNull();
    expect([...host.querySelectorAll('.form-check')].map((row) => row.textContent?.trim())).toEqual([
      'Linux',
      'macOS',
    ]);
  });

  it('holds Submit until a required field is answered, then sends every keyed value', () => {
    const { host, fake, fixture } = render(formRequest);

    const submit = (): HTMLButtonElement =>
      host.querySelector('.form .actions button:not(.secondary)') as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    expect(host.querySelector('.note')?.textContent).toContain('Name is required.');

    const name = host.querySelector('#form-name') as HTMLInputElement;
    name.value = 'Ada';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(submit().disabled).toBe(false);

    // The conditional field is now visible but optional, so it is not required.
    expect(host.querySelector('.note')).toBeNull();

    submit().click();
    expect(fake.respond).toHaveBeenCalledWith({
      requestId: 'form-1',
      values: { name: 'Ada', retries: 3 },
    });
  });

  it('checks ranges, integers and patterns locally before sending', () => {
    const { host, fixture } = render({
      requestId: 'form-2',
      kind: 'form',
      title: 'Tune',
      fields: [
        { key: 'retries', label: 'Retries', type: 'integer', min: 2, max: 5 },
        { key: 'slug', label: 'Slug', type: 'text', pattern: '^[a-z-]+$' },
      ],
    });
    const retries = host.querySelector('#form-retries') as HTMLInputElement;
    const slug = host.querySelector('#form-slug') as HTMLInputElement;

    retries.value = '1';
    retries.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelector('.note')?.textContent).toContain('at least 2');

    retries.value = '3';
    retries.dispatchEvent(new Event('input'));
    slug.value = 'Not A Slug';
    slug.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelector('.note')?.textContent).toContain('expected format');

    slug.value = 'a-slug';
    slug.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelector('.note')).toBeNull();
  });

  it('sends multiselect answers as a list, and cancel as a cancellation', () => {
    const { host, fake, fixture } = render({
      requestId: 'form-3',
      kind: 'form',
      title: 'Targets',
      fields: [
        {
          key: 'targets',
          label: 'Targets',
          type: 'multiselect',
          options: [
            { value: 'linux', label: 'Linux' },
            { value: 'macos', label: 'macOS' },
          ],
        },
      ],
    });
    const boxes = [...host.querySelectorAll('.form-check input')] as HTMLInputElement[];
    boxes[0]!.click();
    boxes[1]!.click();
    fixture.detectChanges();
    (host.querySelector('.form .actions button:not(.secondary)') as HTMLButtonElement).click();
    expect(fake.respond).toHaveBeenCalledWith({
      requestId: 'form-3',
      values: { targets: ['linux', 'macos'] },
    });
  });

  it('cancels a form without values, which is not the same as submitting', () => {
    const { host, fake } = render(formRequest);
    (host.querySelector('.form .actions button.secondary') as HTMLButtonElement).click();
    expect(fake.respond).toHaveBeenCalledWith({ requestId: 'form-1', cancelled: true });
    expect(fake.respond).not.toHaveBeenCalledWith(
      expect.objectContaining({ values: expect.anything() }),
    );
  });

  /**
   * With no question pending the host is an empty box whose padding is a gap in the
   * conversation. The class is what takes it out of the layout.
   */
  it('takes no room from the conversation when nothing is being asked', () => {
    expect(render(null).host.classList.contains('gone')).toBe(true);
    expect(render(selectRequest).host.classList.contains('gone')).toBe(false);
  });
});
