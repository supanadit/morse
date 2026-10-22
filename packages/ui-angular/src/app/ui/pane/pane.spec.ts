import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { Pane, type PaneAction } from './pane';

@Component({
  selector: 'morse-pane-host',
  imports: [Pane],
  template: `
    <morse-pane
      title="Explorer"
      [meta]="meta()"
      [folded]="folded()"
      [actions]="actions()"
      (foldToggle)="toggles.update((count) => count + 1)"
    >
      <button paneActions type="button" class="act">⟳</button>
      <p class="content">a list of files</p>
    </morse-pane>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly meta = signal<string | undefined>('12');
  readonly folded = signal<boolean | undefined>(false);
  readonly toggles = signal(0);
  readonly actions = signal<readonly PaneAction[]>([]);
}

function render(): { host: HTMLElement; fixture: ComponentFixture<Host> } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fixture };
}

/** The frame every panel is drawn in: a title bar the shell owns, content the panel owns. */
describe('Pane', () => {
  it('draws the name and the count, and projects the actions and the content', () => {
    const { host } = render();

    expect(host.querySelector('.pane-title')?.textContent).toBe('Explorer');
    expect(host.querySelector('.pane-meta')?.textContent).toBe('12');
    expect(host.querySelector('.pane-head .act')).not.toBeNull();
    expect(host.querySelector('.pane-body .content')?.textContent).toContain('a list of files');
  });

  it('folds from its title bar, and only offers that when the panel can fold', () => {
    const { host, fixture } = render();
    const fold = host.querySelector('.pane-fold') as HTMLButtonElement;
    expect(fold.getAttribute('aria-expanded')).toBe('true');

    fold.click();
    expect(fixture.componentInstance.toggles()).toBe(1);

    fixture.componentInstance.folded.set(undefined);
    fixture.detectChanges();
    expect(host.querySelector('.pane-fold')).toBeNull();
    expect(host.querySelector('.pane-title')?.textContent).toBe('Explorer');
  });

  /**
   * Renaming a class in the template without renaming it in the stylesheet leaves a pane
   * with no layout at all — a header squashed to nothing under its own body. Cheap to check,
   * and the failure it prevents is invisible in every unit test that reads the DOM.
   */
  it('names every part of its frame in its own stylesheet', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(here, 'pane.html'), 'utf8');
    const css = readFileSync(join(here, 'pane.css'), 'utf8');
    const classes = [...html.matchAll(/class="([^"]+)"/g)].flatMap((match) =>
      match[1].split(/\s+/),
    );

    expect(new Set(classes).size).toBeGreaterThan(3);
    for (const name of new Set(classes)) {
      expect(css, `pane.css does not style .${name}`).toContain(`.${name}`);
    }
  });

  /** The two glyphs used to be one: "more rows" drew the panel's "bigger panel" arrows. */
  it('draws "every row" with its own glyph, not the panel-expand one', () => {
    const { host, fixture } = render();
    fixture.componentInstance.actions.set([
      { id: 'rows', run: () => {}, active: false },
      { id: 'expand', run: () => {}, active: false },
    ]);
    fixture.detectChanges();
    const paths = [...host.querySelectorAll('.pane-action svg')].map((svg) =>
      [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d')).join('|'),
    );
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
  });

  it('marks its title bar as the grip a docking drag takes hold of', () => {
    const { host } = render();

    expect(host.querySelector('[data-pane-handle]')).not.toBeNull();
  });
});
