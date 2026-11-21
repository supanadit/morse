/**
 * One resource kind that lives on more than one surface (files and a config
 * block) behind a single store: listing concatenates the children in order,
 * while a mutation routes to the child the item's `source` names.
 */
import type { ConfigIssue, ConfigMutation, ConfigScope } from '@morse/protocol';

import { ResourceStore, type ResourceList } from './resource-store.js';

/** One child store and the `source` value an item names to reach it. */
export interface CompositeChild<TItem, TSave = TItem> {
  source: string;
  store: ResourceStore<TItem, TSave>;
}

/**
 * A store over several children. `source` is part of the item shape an engine
 * exposes (`'file'` / `'config'`); an absent or unknown source takes the first
 * child, the same default a lone file store would.
 */
export class CompositeResourceStore<TItem, TSave = TItem> extends ResourceStore<TItem, TSave> {
  private readonly children: readonly CompositeChild<TItem, TSave>[];

  constructor(children: readonly CompositeChild<TItem, TSave>[]) {
    super();
    if (children.length === 0) {
      throw new Error('A composite store needs at least one child.');
    }
    this.children = children;
  }

  /** Every child's items in order, then every child's issues in order. */
  list(cwd?: string): ResourceList<TItem> {
    const items: TItem[] = [];
    const issues: ConfigIssue[] = [];
    for (const child of this.children) {
      const listed = child.store.list(cwd);
      items.push(...listed.items);
      issues.push(...listed.issues);
    }
    return { items, issues };
  }

  save(input: TSave, scope: ConfigScope, cwd?: string): ConfigMutation {
    return this.childFor(sourceOf(input)).save(input, scope, cwd);
  }

  remove(name: string, scope: ConfigScope, cwd?: string, source?: string): ConfigMutation {
    return this.childFor(source).remove(name, scope, cwd, source);
  }

  /** Every child's signature, so a change on either surface changes the whole. */
  signature(cwd?: string): string {
    return this.children.map((child) => child.store.signature(cwd)).join(',');
  }

  private childFor(source?: string): ResourceStore<TItem, TSave> {
    const named =
      source === undefined ? undefined : this.children.find((child) => child.source === source);
    return (named ?? this.children[0]!).store;
  }
}

/** The surface an item names, when its shape carries one. */
function sourceOf(input: unknown): string | undefined {
  const source = (input as { source?: unknown }).source;
  return typeof source === 'string' ? source : undefined;
}
