import { signal, type Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionViewState } from '@morse/protocol';
import { MorseService } from '../../core/morse.service';
import { PiUi } from './pi-ui';

type Chrome = Pick<SessionViewState, 'widgets' | 'statuses'>;

function render(chrome: Chrome = {}): HTMLElement {
  const state = signal(chrome).asReadonly();
  TestBed.configureTestingModule({
    providers: [{ provide: MorseService, useValue: { state: state as Signal<SessionViewState> } }],
  });
  const fixture = TestBed.createComponent(PiUi);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('PiUi', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders nothing while no extension set any chrome', () => {
    expect(render().querySelector('.pi-ui')).toBeNull();
  });

  it('renders widget lines as text, in a stable order', () => {
    const host = render({
      widgets: [
        { key: 'below', lines: ['below line'], placement: 'belowEditor' },
        { key: 'above', lines: ['[Prompts]', '/review'], placement: 'aboveEditor' },
      ],
    });

    // Above-editor blocks come first, whatever order pi set them in.
    const widgets = [...host.querySelectorAll('.widget')];
    expect(widgets.map((node) => node.getAttribute('title'))).toEqual(['above', 'below']);
    expect(widgets[0]?.textContent).toContain('/review');
  });

  it('renders the footer status lines', () => {
    const host = render({
      statuses: [
        { key: 'ext', text: 'Turn 2 done' },
        { key: 'other', text: 'idle' },
      ],
    });

    expect([...host.querySelectorAll('.status .entry')].map((node) => node.textContent?.trim())).toEqual(
      ['Turn 2 done', 'idle'],
    );
  });
});
