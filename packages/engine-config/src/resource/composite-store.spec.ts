import type { ConfigScope } from '@morse/protocol';
import { describe, expect, it } from 'vitest';

import { CompositeResourceStore } from './composite-store.js';
import { ResourceStore, type ResourceList, type ResourceMutation } from './resource-store.js';

type Row = { name: string; scope: ConfigScope; body: string };

type RowSave = { name: string; body: string; source?: 'file' | 'config' };

/** A child store that records nothing: its answers name the child, which is the routing proof. */
class FakeChild extends ResourceStore<Row, RowSave> {
  constructor(
    private readonly label: string,
    private readonly rows: Row[],
  ) {
    super();
  }

  list(): ResourceList<Row> {
    return { items: this.rows, issues: [] };
  }

  save(input: RowSave, scope: ConfigScope): ResourceMutation {
    return { ok: true, scope, path: `${this.label}/${input.name}`, issues: [] };
  }

  remove(name: string, scope: ConfigScope): ResourceMutation {
    return { ok: true, scope, path: `${this.label}/${name}`, issues: [] };
  }

  signature(): string {
    return this.label;
  }
}

function composite(): CompositeResourceStore<Row, RowSave> {
  return new CompositeResourceStore<Row, RowSave>([
    {
      source: 'file',
      store: new FakeChild('file', [
        { name: 'a', scope: 'global', body: 'file a' },
        { name: 'dup', scope: 'global', body: 'file dup' },
      ]),
    },
    {
      source: 'config',
      store: new FakeChild('config', [{ name: 'dup', scope: 'global', body: 'config dup' }]),
    },
  ]);
}

describe('CompositeResourceStore', () => {
  it('lists children in order and keeps a duplicate name twice', () => {
    const listed = composite().list('/work');

    expect(listed.issues).toEqual([]);
    expect(listed.items.map((item) => item.body)).toEqual(['file a', 'file dup', 'config dup']);
  });

  it('routes save and remove to the child named by source', () => {
    const store = composite();

    expect(store.save({ name: 'x', body: '', source: 'config' }, 'global', '/work').path).toBe(
      'config/x',
    );
    // An absent source is the first child, the same default a lone file store takes.
    expect(store.save({ name: 'y', body: '' }, 'global', '/work').path).toBe('file/y');
    expect(store.remove('z', 'global', '/work', 'config').path).toBe('config/z');
    expect(store.remove('w', 'global', '/work').path).toBe('file/w');
    expect(store.signature('/work')).toBe('file,config');
  });
});
