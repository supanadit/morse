import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { promptTemplateForm } from '@morse/ui-runtime';
import { PromptTemplateDialog, type PromptTemplateRequest } from './prompt-template-dialog';

const REVIEW = `---
description: Review staged git changes
argument-hint: "[focus] <file>"
---
Review \${1:-the staged} changes in $2.`;

function request(): PromptTemplateRequest {
  return {
    name: 'review',
    description: 'Review staged git changes',
    form: promptTemplateForm(REVIEW)!,
  };
}

interface Rendered {
  host: HTMLElement;
  fixture: ComponentFixture<PromptTemplateDialog>;
}

function render(input: PromptTemplateRequest = request()): Rendered {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [PromptTemplateDialog] });
  const fixture = TestBed.createComponent(PromptTemplateDialog);
  fixture.componentRef.setInput('request', input);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fixture };
}

/** Type into a field the way the browser does. */
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event('input'));
}

const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('PromptTemplateDialog', () => {
  it('renders a field per declared argument plus the extra box', () => {
    const { host } = render();
    const inputs = [...host.querySelectorAll('input')] as HTMLInputElement[];
    expect(inputs).toHaveLength(2);
    expect(inputs[0].getAttribute('aria-label')).toBe('focus');
    expect(inputs[1].getAttribute('aria-label')).toBe('file');
    // Angle brackets in the hint mark the field required.
    expect(host.querySelectorAll('.required')).toHaveLength(1);
    expect(host.querySelector('textarea[aria-label="Additional instructions"]')).not.toBeNull();
  });

  it('updates the preview as fields and extra change', () => {
    const { host, fixture } = render();
    const [focus, file] = [...host.querySelectorAll('input')] as HTMLInputElement[];

    type(focus, 'concurrency');
    type(file, 'src/app.ts');
    fixture.detectChanges();
    expect(host.querySelector('pre')?.textContent).toContain('Review concurrency changes in src/app.ts.');

    const extra = host.querySelector('textarea[aria-label="Additional instructions"]') as HTMLTextAreaElement;
    type(extra, 'Also check the API.');
    fixture.detectChanges();
    expect(host.querySelector('pre')?.textContent).toContain(
      'Review concurrency changes in src/app.ts.\n\nAlso check the API.',
    );
  });

  it('uses the template default for a blank optional field', () => {
    const { host, fixture } = render();
    const file = [...host.querySelectorAll('input')] as HTMLInputElement[];
    type(file[1], 'src/app.ts');
    fixture.detectChanges();
    expect(host.querySelector('pre')?.textContent).toContain('Review the staged changes in src/app.ts.');
  });

  it('will not send until a required field is filled', () => {
    const { host, fixture } = render();
    const send = host.querySelector('.actions button:not(.secondary)') as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    type(host.querySelectorAll('input')[1] as HTMLInputElement, 'src/app.ts');
    fixture.detectChanges();
    expect(send.disabled).toBe(false);
  });

  it('emits the composed prompt on submit', () => {
    const { host, fixture } = render();
    const submitted = vi.fn();
    const cancelled = vi.fn();
    fixture.componentInstance.submitted.subscribe(submitted);
    fixture.componentInstance.cancelled.subscribe(cancelled);

    type(host.querySelectorAll('input')[0] as HTMLInputElement, 'concurrency');
    type(host.querySelectorAll('input')[1] as HTMLInputElement, 'src/app.ts');
    type(host.querySelector('textarea[aria-label="Additional instructions"]') as HTMLTextAreaElement, 'Be brief.');
    fixture.detectChanges();

    (host.querySelector('.actions button:not(.secondary)') as HTMLButtonElement).click();

    expect(submitted).toHaveBeenCalledWith(
      'Review concurrency changes in src/app.ts.\n\nBe brief.',
    );
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('cancels on Escape and on the backdrop', () => {
    const { host, fixture } = render();
    const cancelled = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);

    (host.querySelector('.modal-card') as HTMLElement).click();
    expect(cancelled).not.toHaveBeenCalled();

    (host.querySelector('.modal-layer') as HTMLElement).click();
    expect(cancelled).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it('lands focus on the first field', async () => {
    const { host } = render();
    await nextTick();
    expect(document.activeElement).toBe(host.querySelector('input'));
  });

  it('offers a shell-quoted raw-arguments field for a catch-all template', () => {
    const form = promptTemplateForm('Run: $@')!;
    const { host, fixture } = render({ name: 'tests', form });
    const field = host.querySelector('textarea[aria-label="Arguments"]') as HTMLTextAreaElement;
    type(field, '"api tests" lint');
    fixture.detectChanges();
    expect(host.querySelector('pre')?.textContent).toContain('Run: api tests lint');
  });
});
