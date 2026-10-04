import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { BranchPicker } from './branch-picker';

function render(branches: {
  isRepo: boolean;
  current?: string;
  local: string[];
  remote: string[];
  tags: string[];
}): ComponentFixture<BranchPicker> {
  TestBed.configureTestingModule({ imports: [BranchPicker] });
  const fixture = TestBed.createComponent(BranchPicker);
  fixture.componentRef.setInput('branches', branches);
  fixture.detectChanges();
  return fixture;
}

function rows(fixture: ComponentFixture<BranchPicker>): HTMLButtonElement[] {
  return [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.row')];
}

function type(fixture: ComponentFixture<BranchPicker>, input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

describe('BranchPicker', () => {
  const branches = {
    isRepo: true,
    current: 'main',
    local: ['main', 'dev'],
    remote: ['origin/main', 'origin/feat/one'],
    tags: ['v1.0', 'v0.9'],
  };

  it('lists locals, remote short names and tags', () => {
    const fixture = render(branches);
    const labels = rows(fixture).map((row) => row.querySelector('.name')?.textContent?.trim());

    // Order: create, detach, locals, remote short names, tags.
    expect(labels).toEqual([
      undefined,
      undefined,
      'dev',
      'main',
      'feat/one',
      'main',
      'v0.9',
      'v1.0',
    ]);
    // The full remote name stays one hover away.
    const remote = rows(fixture).find((row) => row.querySelector('.remote')?.textContent?.includes('origin/feat/one'));
    expect(remote?.getAttribute('title')).toBe('origin/feat/one');
  });

  it('emits a tag to check out', () => {
    const fixture = render(branches);
    const pick = vi.fn();
    fixture.componentInstance.pick.subscribe(pick);

    const tag = rows(fixture).find(
      (row) => row.querySelector('.name')?.textContent?.trim() === 'v0.9',
    )!;
    tag.click();

    expect(pick).toHaveBeenCalledWith('v0.9');
  });

  it('emits a ref to check out detached', () => {
    const fixture = render(branches);
    const detach = vi.fn();
    fixture.componentInstance.detach.subscribe(detach);
    const host = fixture.nativeElement as HTMLElement;

    host.querySelector<HTMLButtonElement>('.detach-row')!.click();
    fixture.detectChanges();
    const ref = host.querySelector<HTMLInputElement>('.name-input')!;
    type(fixture, ref, 'abc1234');
    host.querySelector<HTMLButtonElement>('.primary')!.click();

    expect(detach).toHaveBeenCalledWith('abc1234');
  });

  it('narrows the list to what is typed', () => {
    const fixture = render(branches);
    const filter = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('.filter')!;
    type(fixture, filter, 'dev');

    const labels = rows(fixture)
      .map((row) => row.querySelector('.name')?.textContent?.trim())
      .filter((label): label is string => label !== undefined);
    expect(labels).toEqual(['dev']);
  });

  it('emits the picked branch and closes nothing on its own', () => {
    const fixture = render(branches);
    const pick = vi.fn();
    fixture.componentInstance.pick.subscribe(pick);

    const dev = rows(fixture).find((row) => row.querySelector('.name')?.textContent?.trim() === 'dev')!;
    dev.click();

    expect(pick).toHaveBeenCalledWith('dev');
  });

  it('emits a new branch name from the create step', () => {
    const fixture = render(branches);
    const create = vi.fn();
    fixture.componentInstance.create.subscribe(create);
    const host = fixture.nativeElement as HTMLElement;

    host.querySelector<HTMLButtonElement>('.create-row')!.click();
    fixture.detectChanges();
    const name = host.querySelector<HTMLInputElement>('.name-input')!;
    type(fixture, name, 'feat/new');
    host.querySelector<HTMLButtonElement>('.primary')!.click();

    expect(create).toHaveBeenCalledWith('feat/new');
  });
});
