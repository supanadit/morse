import { describe, expect, it } from 'vitest';
import type { GitCommit } from '@morse/protocol';
import { layoutGraph } from './git-graph';

function commit(hash: string, parents: string[]): GitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    refs: [],
    author: 'A',
    date: '2024-01-01T00:00:00Z',
    subject: hash,
  };
}

describe('layoutGraph', () => {
  it('lays a linear history in one lane', () => {
    const { rows, laneCount } = layoutGraph([
      commit('c', ['b']),
      commit('b', ['a']),
      commit('a', []),
    ]);

    expect(laneCount).toBe(1);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    // The middle row has an incoming line and an outgoing one, not a through line.
    expect(rows[1]?.edges).toEqual([
      { fromLane: 0, fromY: 0, toLane: 0, toY: 0.5, color: 0 },
      { fromLane: 0, fromY: 0.5, toLane: 0, toY: 1, color: 0 },
    ]);
    // A root commit only has its own incoming line.
    expect(rows[2]?.edges).toEqual([
      { fromLane: 0, fromY: 0, toLane: 0, toY: 0.5, color: 0 },
    ]);
  });

  it('forks a merge into a second lane and converges back onto the first', () => {
    const { rows, laneCount } = layoutGraph([
      commit('m', ['a', 'b']),
      commit('a', ['c']),
      commit('b', ['c']),
      commit('c', []),
    ]);

    expect(laneCount).toBe(2);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 1, 0]);
    // The merge commit fans out to both parents.
    expect(rows[0]?.edges).toContainEqual({
      fromLane: 0,
      fromY: 0.5,
      toLane: 1,
      toY: 1,
      color: 1,
    });
    // `b` joins `c`'s lane while `a`'s line passes straight through.
    expect(rows[2]?.edges).toContainEqual({
      fromLane: 1,
      fromY: 0.5,
      toLane: 0,
      toY: 1,
      color: 0,
    });
    expect(rows[2]?.edges).toContainEqual({
      fromLane: 0,
      fromY: 0,
      toLane: 0,
      toY: 1,
      color: 0,
    });
  });

  it('reuses a parent already expected by another branch instead of forking a lane', () => {
    const { rows, laneCount } = layoutGraph([
      commit('x', ['p']),
      commit('y', ['p']),
      commit('p', []),
    ]);

    expect(laneCount).toBe(2);
    // `y` is a second lane, but it joins `p`'s existing lane rather than opening a
    // third one.
    expect(rows[1]?.lane).toBe(1);
    expect(rows[1]?.edges).toContainEqual({
      fromLane: 1,
      fromY: 0.5,
      toLane: 0,
      toY: 1,
      color: 0,
    });
    // The parent then has a single incoming line, not two lanes to merge.
    expect(rows[2]?.lane).toBe(0);
    expect(rows[2]?.edges).toEqual([
      { fromLane: 0, fromY: 0, toLane: 0, toY: 0.5, color: 0 },
    ]);
  });

  it('handles an empty history', () => {
    expect(layoutGraph([])).toEqual({ rows: [], laneCount: 0 });
  });
});
