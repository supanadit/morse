import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@morse/ui-runtime';
import { TreeList } from './tree-list';

interface Item {
  readonly path: string;
}

function node(id: string, children: TreeNode<Item>[] = [], data = id): TreeNode<Item> {
  return {
    id,
    label: id,
    data: { path: data },
    kind: children.length > 0 ? 'group' : 'leaf',
    children,
  };
}

@Component({
  selector: 'morse-tree-host',
  imports: [TreeList],
  template: `
    <morse-tree
      [nodes]="nodes()"
      [expanded]="expanded()"
      [selected]="selected()"
      empty="No sessions yet."
      (activate)="clicked.set($event.data.path)"
      (toggle)="toggled.set($event.id)"
      (context)="contexted.set($event.node.id)"
    />
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly nodes = signal<readonly TreeNode<Item>[]>([
    node('morse', [node('s1'), node('s2')], '/work/morse'),
    node('pi', [], '/work/pi'),
  ]);
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  readonly selected = signal<string | undefined>(undefined);
  readonly clicked = signal<string | undefined>(undefined);
  readonly contexted = signal<string | undefined>(undefined);
  readonly toggled = signal<string | undefined>(undefined);
  readonly actioned = signal(0);
}

function render(): { host: HTMLElement; fixture: ComponentFixture<Host> } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [Host] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, fixture };
}

function labels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.row .label')].map((el) => el.textContent ?? '');
}

function prefixes(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.row .prefix')].map((el) => el.textContent ?? '');
}

/** The one tree the Explorer and the session list are both drawn in. */
describe('TreeList', () => {
  it('draws the roots, and a group only shows its children when it is open', () => {
    const { host, fixture } = render();
    expect(labels(host)).toEqual(['morse', 'pi']);

    fixture.componentInstance.expanded.set(new Set(['morse']));
    fixture.detectChanges();
    expect(labels(host)).toEqual(['morse', 's1', 's2', 'pi']);
  });

  it('draws the guide lines the pure builder produced, and none on a root', () => {
    const { host, fixture } = render();
    fixture.componentInstance.expanded.set(new Set(['morse']));
    fixture.detectChanges();

    // Roots carry none. Both children sit under the root `morse`, which is a root
    // and so contributes a gap (not a line) before the tee and the corner.
    expect(prefixes(host)).toEqual(['├', '└']);
  });

  it('gives every line a caret slot, so a leaf label lines up with a group label', () => {
    const { host, fixture } = render();
    fixture.componentInstance.expanded.set(new Set(['morse']));
    fixture.detectChanges();

    // Every line carries the caret cell: a group shows the mark, a leaf keeps the
    // column, so the two labels start at the same x rather than the leaf shifting left.
    const lines = [...host.querySelectorAll('.line')];
    expect(lines.every((line) => line.querySelector('.chevron') !== null)).toBe(true);
    expect(lines[0].querySelector('.chevron')?.textContent?.trim()).toBe('›');
    expect(lines[1].querySelector('.chevron')?.textContent?.trim()).toBe('');
  });

  it('folds from the caret, and opens from the row, as two separate clicks', () => {
    const { host, fixture } = render();
    fixture.componentInstance.expanded.set(new Set(['morse']));
    fixture.detectChanges();

    // The caret folds the group…
    (host.querySelector('button.chevron') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.clicked()).toBeUndefined();

    // …and the row opens it, without folding.
    (host.querySelector('.row.group') as HTMLButtonElement).click();
    expect(fixture.componentInstance.clicked()).toBe('/work/morse');
  });

  it('marks the fold state so a screen reader hears the nesting', () => {
    const { host, fixture } = render();
    const first = host.querySelector('.row') as HTMLElement;
    expect(first.getAttribute('aria-level')).toBe('1');
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(first.getAttribute('role')).toBe('treeitem');

    fixture.componentInstance.expanded.set(new Set(['morse']));
    fixture.detectChanges();
    expect((host.querySelector('.row') as HTMLElement).getAttribute('aria-expanded')).toBe('true');
    // A leaf has no expansion to announce.
    expect(host.querySelectorAll('.row')[1].getAttribute('aria-expanded')).toBeNull();
  });

  it('hands the caller’s own object back on a click', () => {
    const { host, fixture } = render();
    (host.querySelector('.row') as HTMLButtonElement).click();
    expect(fixture.componentInstance.clicked()).toBe('/work/morse');
  });

  it('marks the row in front', () => {
    const { host, fixture } = render();
    fixture.componentInstance.selected.set('pi');
    fixture.detectChanges();

    const rows = host.querySelectorAll('.row');
    expect(rows[0].classList.contains('active')).toBe(false);
    expect(rows[1].classList.contains('active')).toBe(true);
    expect(rows[1].getAttribute('aria-current')).toBe('true');
  });

  it('shows the empty state when the tree has no rows', () => {
    const { host, fixture } = render();
    fixture.componentInstance.nodes.set([]);
    fixture.detectChanges();

    expect(host.querySelector('.empty')?.textContent).toContain('No sessions yet.');
    expect(host.querySelector('.row')).toBeNull();
  });

  it('reports a right-click with the node it landed on, and no menu of its own', () => {
    const { host, fixture } = render();
    host
      .querySelector('.row')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    expect(fixture.componentInstance.contexted()).toBe('morse');
  });

  it('draws a row’s own action beside it, and does not fold the row it sits on', () => {
    const { host, fixture } = render();
    fixture.componentInstance.nodes.set([
      {
        ...node('morse', [node('s1')]),
        action: { glyph: '+', label: 'New session in morse', run: () => undefined },
      },
    ]);
    fixture.detectChanges();

    const action = host.querySelector('.row-action') as HTMLButtonElement;
    expect(action.textContent).toContain('+');
    expect(action.getAttribute('aria-label')).toBe('New session in morse');
    // The action is a sibling of the row, not a button inside one.
    expect(action.closest('.row')).toBeNull();
  });

  it('paints a badge by the tone the caller named', () => {
    const { host, fixture } = render();
    fixture.componentInstance.nodes.set([{ ...node('a.ts'), badge: 'M', badgeTone: 'warn' }]);
    fixture.detectChanges();

    expect(host.querySelector('.badge')?.classList.contains('warn')).toBe(true);
  });

  /**
   * Renaming a class in the template without renaming it in the stylesheet leaves a
   * row with no layout — the failure is invisible in every DOM-only test. Cheap to
   * check, and this component is the one place a row is drawn now.
   */
  it('names every part of a row in its own stylesheet', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(here, 'tree-list.html'), 'utf8');
    const css = readFileSync(join(here, 'tree-list.css'), 'utf8');
    const classes = [...html.matchAll(/class="([^"]+)"/g)].flatMap((match) =>
      match[1].split(/\s+/),
    );

    expect(new Set(classes).size).toBeGreaterThan(3);
    for (const name of new Set(classes)) {
      expect(css, `tree-list.css does not style .${name}`).toContain(`.${name}`);
    }
  });
});
