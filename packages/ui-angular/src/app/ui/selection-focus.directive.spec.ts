import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SelectionFocusDirective } from './selection-focus.directive';

@Component({
  imports: [SelectionFocusDirective],
  template: `
    <div id="shell" morseSelectionFocus>
      <p id="prose">Selectable answer text</p>
      <button id="button" type="button">Copy</button>
      <textarea id="prompt">draft</textarea>
      <input id="input" value="draft" />
      <a id="link" href="#">link</a>
      <div id="editable" contenteditable="true">editable</div>
      <span id="chip" role="button" tabindex="0">chip</span>
    </div>
  `,
})
class HostComponent {}

/** The injected API's presence is what makes `hasVsCodeApi()` say "webview". */
const webview = globalThis as { acquireVsCodeApi?: () => unknown };

function render(): HTMLElement {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** A press as the browser delivers one: bubbling up to the guarded surface. */
function press(target: Element): PointerEvent {
  const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('SelectionFocusDirective', () => {
  beforeEach(() => {
    webview.acquireVsCodeApi = () => ({ postMessage: () => undefined });
  });

  afterEach(() => {
    delete webview.acquireVsCodeApi;
    TestBed.resetTestingModule();
  });

  it('gives the surface a programmatic focus target in a webview', () => {
    const host = render();
    expect(host.querySelector('#shell')?.getAttribute('tabindex')).toBe('-1');
  });

  it('lands a press on plain text on the surface, not on the composer', () => {
    const host = render();
    const shell = host.querySelector<HTMLElement>('#shell');
    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt');
    const prose = host.querySelector('#prose');
    prompt?.focus();
    expect(document.activeElement).toBe(prompt);

    const event = press(prose!);

    // A non-editable activeElement is the condition VS Code's clipboard path
    // keys off: with it, the last editable is not refocused and the selection
    // stays put when Copy runs.
    expect(document.activeElement).toBe(shell);
    // The press still belongs to the page: selection must start as it did.
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves controls that own focus alone', () => {
    const host = render();
    const shell = host.querySelector<HTMLElement>('#shell');
    for (const id of ['button', 'prompt', 'input', 'link', 'editable', 'chip']) {
      const control = host.querySelector<HTMLElement>(`#${id}`)!;
      control.focus();
      press(control);
      expect(document.activeElement, id).not.toBe(shell);
    }
  });

  it('stands down when something else already claimed the press', () => {
    const host = render();
    const shell = host.querySelector<HTMLElement>('#shell');
    const prose = host.querySelector('#prose')!;
    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt');
    prompt?.focus();
    // The composer's resize handle is a press the drag owns, and the pin slider
    // does the same; neither may end up focusing the shell behind it.
    const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true });
    prose.addEventListener('pointerdown', (one) => one.preventDefault(), { once: true });
    prose.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(shell);
  });

  it('stays out of the way outside a webview', () => {
    delete webview.acquireVsCodeApi;
    TestBed.resetTestingModule();
    const host = render();
    const shell = host.querySelector<HTMLElement>('#shell');
    const prose = host.querySelector('#prose')!;
    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt');
    prompt?.focus();

    press(prose);

    expect(shell?.hasAttribute('tabindex')).toBe(false);
    expect(document.activeElement).toBe(prompt);
  });
});
