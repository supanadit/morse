import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { fileIcon, type ChangeKind } from '@morse/ui-runtime';

/** One changed path in the working tree. */
export interface ChangeView {
  path: string;
  kind: ChangeKind;
}

/** A staged or unstaged group of changes. */
export interface ChangeGroupView {
  id: 'staged' | 'unstaged';
  label: string;
  rows: readonly ChangeView[];
  collapsed: boolean;
}

/**
 * The working tree's rows: a checkbox per path (checked when staged), the file's
 * mark, its name and its git letter. The header folds the group and stages or
 * unstages all of it. The shared tree is not used here because a checkbox is not
 * a tree concept and would leak into every other list.
 */
@Component({
  selector: 'morse-change-list',
  templateUrl: './change-list.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './change-list.css',
})
export class ChangeList {
  readonly groups = input.required<readonly ChangeGroupView[]>();
  /** Emitted when a row is checked or unchecked: stage it, or take it back out. */
  readonly toggleRow = output<{ path: string; staged: boolean }>();
  readonly toggleGroup = output<ChangeGroupView>();
  readonly toggleAll = output<ChangeGroupView>();
  /** A row's name: open the file in a preview tab. */
  readonly openRow = output<ChangeView>();

  protected iconFor = fileIcon;

  protected checked(group: ChangeGroupView): boolean {
    return group.id === 'staged';
  }

  protected onRow(row: ChangeView, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    // The checkbox's new state is the request: checked stages, unchecked unstages.
    this.toggleRow.emit({ path: row.path, staged: checked });
  }

  protected name(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? path : path.slice(slash + 1);
  }

  protected dir(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? '' : path.slice(0, slash);
  }
}
