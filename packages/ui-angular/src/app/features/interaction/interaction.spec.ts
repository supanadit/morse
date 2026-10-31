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
  setRequest: (request: InteractionRequest | null) => void;
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
): {
  host: HTMLElement;
  fake: Fake;
  fixture: ReturnType<typeof TestBed.createComponent<InteractionPanel>>;
} {
  const pending = signal<InteractionRequest | null>(request);
  const fake: Fake = {
    pendingInteraction: pending.asReadonly(),
    capabilities: signal({ nativeDialogs } as HostCapabilities).asReadonly(),
    respond: vi.fn(),
    setRequest: (next) => pending.set(next),
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

/** The walk controls, by their visible label. */
function nav(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll<HTMLButtonElement>('.actions button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) ?? null
  );
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

  it('shows one question per step and walks the form with Next and Back', () => {
    const { host, fixture } = render(formRequest);

    // name (text), retries (integer, defaulted), targets (multiselect) — reason
    // is conditional on name === 'Ada' and starts hidden, so there are 3 steps.
    expect(host.querySelector('.steps-count')?.textContent?.trim()).toBe('Question 1 of 3');
    expect(host.querySelector('#form-name')).not.toBeNull();
    expect(host.querySelector('#form-retries')).toBeNull();

    nav(host, 'Next')!.click();
    fixture.detectChanges();
    expect(host.querySelector('#form-name')).toBeNull();
    expect((host.querySelector('#form-retries') as HTMLInputElement).value).toBe('3');

    nav(host, 'Next')!.click();
    fixture.detectChanges();
    expect(host.querySelector('.steps-count')?.textContent?.trim()).toBe('Question 3 of 3');
    expect(host.querySelectorAll('.choice input[type="checkbox"]')).toHaveLength(2);
    // The last step swaps Next for Submit.
    expect(nav(host, 'Next')).toBeNull();
    expect(nav(host, 'Submit')).not.toBeNull();

    nav(host, 'Back')!.click();
    fixture.detectChanges();
    expect(host.querySelector('#form-retries')).not.toBeNull();
  });

  it('recomputes the steps when an answer shows a conditional field', () => {
    const { host, fixture } = render(formRequest);

    const name = host.querySelector('#form-name') as HTMLInputElement;
    name.value = 'Ada';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    // `reason` (when name === 'Ada') is now visible: four questions to walk.
    expect(host.querySelector('.steps-count')?.textContent?.trim()).toBe('Question 1 of 4');
    nav(host, 'Next')!.click();
    nav(host, 'Next')!.click();
    fixture.detectChanges();
    expect(host.querySelector('#form-reason')).not.toBeNull();
  });

  it('lets Next pass an unanswered required step; only Submit checks the whole form', () => {
    const { host, fake, fixture } = render(formRequest);

    // Step 1 is required and empty: marked broken, but Next still works.
    expect(host.querySelector('.step-dot.broken')).not.toBeNull();
    expect(host.querySelector('.note')?.textContent).toContain('Name is required.');
    nav(host, 'Next')!.click();
    fixture.detectChanges();
    expect(host.querySelector('#form-retries')).not.toBeNull();

    // The last step holds Submit, blocked by the missing name from step 1.
    nav(host, 'Next')!.click();
    fixture.detectChanges();
    expect(nav(host, 'Submit')!.disabled).toBe(true);

    // The note names the field and jumps back to the step that owns it.
    const jump = host.querySelector('.note-link') as HTMLButtonElement;
    expect(jump.textContent).toContain('Name is required.');
    jump.click();
    fixture.detectChanges();
    expect(host.querySelector('#form-name')).not.toBeNull();

    // Answer it: the note clears and the walk can finish.
    const name = host.querySelector('#form-name') as HTMLInputElement;
    name.value = 'Ada';
    name.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelector('.note')).toBeNull();

    nav(host, 'Next')!.click(); // retries (default 3)
    fixture.detectChanges();
    nav(host, 'Next')!.click(); // reason (optional, now visible)
    fixture.detectChanges();
    nav(host, 'Next')!.click(); // targets
    fixture.detectChanges();
    nav(host, 'Submit')!.click();
    expect(fake.respond).toHaveBeenCalledWith({
      requestId: 'form-1',
      values: { name: 'Ada', retries: 3 },
    });
  });

  it('renders a select as compact numbered rows and sends the picked value', () => {
    const { host, fake, fixture } = render({
      requestId: 'form-select',
      kind: 'form',
      title: 'Pick a database',
      fields: [
        {
          key: 'db',
          label: 'Database',
          type: 'select',
          options: [
            { value: 'pg', label: 'PostgreSQL', description: 'Recommended' },
            { value: 'sqlite', label: 'SQLite' },
          ],
        },
      ],
    });

    // A single field is one question: no stepper chrome, just Cancel and Submit.
    expect(host.querySelector('.steps')).toBeNull();
    const radios = [...host.querySelectorAll<HTMLInputElement>('.choice input[type="radio"]')];
    expect(radios).toHaveLength(2);
    expect(radios[0]?.name).toBe('form-db');
    // The row wears the number, not a visible radio.
    expect(
      [...host.querySelectorAll('.choice-ordinal')].map((row) => row.textContent?.trim()),
    ).toEqual(['1.', '2.', '3.']);
    expect(host.querySelectorAll('.choice-description')).toHaveLength(1);

    radios[1]!.click();
    fixture.detectChanges();
    expect(host.querySelectorAll('.choice.picked')).toHaveLength(1);

    (host.querySelector('.actions button:not(.secondary)') as HTMLButtonElement).click();
    expect(fake.respond).toHaveBeenCalledWith({
      requestId: 'form-select',
      values: { db: 'sqlite' },
    });
  });

  it('accepts a hand-typed answer when no option fits', () => {
    const { host, fake, fixture } = render({
      requestId: 'form-custom',
      kind: 'form',
      title: 'Pick a database',
      fields: [
        {
          key: 'db',
          label: 'Database',
          type: 'select',
          options: [{ value: 'pg', label: 'PostgreSQL' }],
        },
      ],
    });

    (host.querySelector('button.choice-other') as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = host.querySelector('.custom-input') as HTMLInputElement;
    expect(input).not.toBeNull();

    input.value = 'DuckDB';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    // The typed row becomes the picked answer and Submit is no longer blocked.
    expect(host.querySelector('.custom-input')).toBeNull();
    expect(host.querySelector('.choice.picked .choice-label')?.textContent?.trim()).toBe('DuckDB');
    expect(host.querySelector('.note')).toBeNull();

    (host.querySelector('.actions button:not(.secondary)') as HTMLButtonElement).click();
    expect(fake.respond).toHaveBeenCalledWith({
      requestId: 'form-custom',
      values: { db: 'DuckDB' },
    });
  });

  it('collapses the hand-typed row on Escape without answering', () => {
    const { host, fake, fixture } = render({
      requestId: 'form-custom-esc',
      kind: 'form',
      title: 'Pick a database',
      fields: [
        {
          key: 'db',
          label: 'Database',
          type: 'select',
          options: [{ value: 'pg', label: 'PostgreSQL' }],
        },
      ],
    });

    (host.querySelector('button.choice-other') as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = host.querySelector('.custom-input') as HTMLInputElement;
    input.value = 'DuckDB';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(host.querySelector('.custom-input')).toBeNull();
    expect(host.querySelector('.choice.picked')).toBeNull();
    // Escape inside the input collapses it; it must not cancel the whole form.
    expect(fake.respond).not.toHaveBeenCalled();
  });

  it('adds a hand-typed multiselect entry as a removable row', () => {
    const { host, fake, fixture } = render({
      requestId: 'form-custom-multi',
      kind: 'form',
      title: 'Targets',
      fields: [
        {
          key: 'targets',
          label: 'Targets',
          type: 'multiselect',
          options: [{ value: 'linux', label: 'Linux' }],
        },
      ],
    });

    (host.querySelector('button.choice-other') as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = host.querySelector('.custom-input') as HTMLInputElement;
    input.value = 'plan9';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    // The typed entry joins the list as a checked row; the add-row returns.
    expect(host.querySelectorAll('.choice-check')).toHaveLength(2);
    expect(host.querySelector('button.choice-other')).not.toBeNull();

    (host.querySelector('.actions button:not(.secondary)') as HTMLButtonElement).click();
    expect(fake.respond).toHaveBeenCalledWith({
      requestId: 'form-custom-multi',
      values: { targets: ['plan9'] },
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
    retries.value = '1';
    retries.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelector('.note')?.textContent).toContain('at least 2');

    // Free navigation: an invalid step does not trap the reader.
    nav(host, 'Next')!.click();
    fixture.detectChanges();
    const slug = host.querySelector('#form-slug') as HTMLInputElement;
    slug.value = 'Not A Slug';
    slug.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.querySelector('.note')?.textContent).toContain('expected format');

    slug.value = 'a-slug';
    slug.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    // This step is fixed; the note now reports the earlier problem and jumps to it.
    expect(host.querySelector('.note-link')?.textContent).toContain('at least 2');
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
    const boxes = [...host.querySelectorAll<HTMLInputElement>('.choice input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);
    boxes[0]!.click();
    boxes[1]!.click();
    fixture.detectChanges();
    (host.querySelector('.actions button:not(.secondary)') as HTMLButtonElement).click();
    expect(fake.respond).toHaveBeenCalledWith({
      requestId: 'form-3',
      values: { targets: ['linux', 'macos'] },
    });
  });

  it('advances a step on Enter and submits on the last', () => {
    const { host, fake, fixture } = render({
      requestId: 'form-enter',
      kind: 'form',
      title: 'Enter walk',
      fields: [
        { key: 'name', label: 'Name', type: 'text' },
        {
          key: 'targets',
          label: 'Targets',
          type: 'multiselect',
          options: [{ value: 'a', label: 'A' }],
        },
      ],
    });

    const name = host.querySelector('#form-name') as HTMLInputElement;
    name.value = 'Ada';
    name.dispatchEvent(new Event('input'));
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(host.querySelector('.choice input[type="checkbox"]')).not.toBeNull();

    const box = host.querySelector('.choice input[type="checkbox"]') as HTMLInputElement;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(fake.respond).toHaveBeenCalledWith({
      requestId: 'form-enter',
      values: { name: 'Ada' },
    });
  });

  it('starts a new question at its first step', () => {
    const { host, fake, fixture } = render(formRequest);
    nav(host, 'Next')!.click();
    fixture.detectChanges();
    expect(host.querySelector('#form-retries')).not.toBeNull();

    fake.setRequest({
      requestId: 'form-next',
      kind: 'form',
      title: 'One question',
      fields: [{ key: 'only', label: 'Only', type: 'text' }],
    });
    fixture.detectChanges();
    expect(host.querySelector('h2')?.textContent?.trim()).toBe('One question');
    expect(host.querySelector('#form-only')).not.toBeNull();
    expect(host.querySelector('.steps')).toBeNull();
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
