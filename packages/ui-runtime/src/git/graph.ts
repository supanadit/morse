import type { GitCommit } from '@morse/protocol';

/**
 * Where an edge attaches inside one graph row: the top boundary (the row above),
 * the commit's node (the row's middle), or the bottom boundary (the row below).
 */
export type GraphY = 0 | 0.5 | 1;

/** One line of the graph inside a row, coloured by the lane it belongs to. */
export interface GraphEdge {
  fromLane: number;
  fromY: GraphY;
  toLane: number;
  toY: GraphY;
  /** Lane index the edge takes its colour from. */
  color: number;
}

export interface GraphRow {
  /** The commit's own lane and colour (the node). */
  lane: number;
  color: number;
  edges: GraphEdge[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Lanes ever active, so the SVG column keeps a stable width. */
  laneCount: number;
}

/**
 * Assigns each commit a lane and the edges across its row, newest first — the
 * layout a git graph draws. `parents` is all the graph needs: a lane is simply
 * "the commit a line is waiting for", reused once it is claimed, so two branches
 * side by side get two lanes and a merge converges back onto one.
 *
 * Pure and synchronous: the renderer only has to turn a number into an x.
 */
export function layoutGraph(commits: readonly GitCommit[]): GraphLayout {
  /** lane -> hash the lane is waiting for (the next commit that claims it). */
  const lanes: Array<string | undefined> = [];
  const rows: GraphRow[] = [];
  let laneCount = 0;

  for (const commit of commits) {
    const before = lanes.slice();
    const incoming: number[] = [];
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index] === commit.hash) {
        incoming.push(index);
      }
    }

    const lane = incoming.length > 0 ? incoming[0]! : firstFree(lanes);
    // The commit claims its lane now, and every other lane that was waiting for
    // it merges in. Clearing before the pass-through sweep is what keeps the
    // commit's own lane out of it (it is an incoming line, not a through line).
    lanes[lane] = undefined;
    for (let index = 1; index < incoming.length; index += 1) {
      lanes[incoming[index]!] = undefined;
    }

    const edges: GraphEdge[] = [];
    // Branch lines that belong to other commits pass straight through.
    for (let index = 0; index < before.length; index += 1) {
      if (before[index] !== undefined && lanes[index] === before[index]) {
        edges.push({ fromLane: index, fromY: 0, toLane: index, toY: 1, color: index });
      }
    }
    // The commit's own incoming line, then the merges that end on its node.
    if (before[lane] === commit.hash) {
      edges.push({ fromLane: lane, fromY: 0, toLane: lane, toY: 0.5, color: lane });
    }
    for (const source of incoming) {
      if (source !== lane) {
        edges.push({ fromLane: source, fromY: 0, toLane: lane, toY: 0.5, color: source });
      }
    }

    // A parent another branch already expects keeps that lane instead of forking
    // a second one; only then does the first parent continue in this lane.
    for (let index = 0; index < commit.parents.length; index += 1) {
      const parent = commit.parents[index]!;
      let target = existingLane(lanes, parent, lane);
      if (target === -1) {
        target = index === 0 ? lane : firstFree(lanes);
      }
      lanes[target] = parent;
      edges.push({ fromLane: lane, fromY: 0.5, toLane: target, toY: 1, color: target });
    }

    laneCount = Math.max(laneCount, lanes.length);
    rows.push({ lane, color: lane, edges });
  }

  return { rows, laneCount };
}

function firstFree(lanes: Array<string | undefined>): number {
  const free = lanes.indexOf(undefined);
  return free === -1 ? lanes.length : free;
}

function existingLane(
  lanes: Array<string | undefined>,
  parent: string,
  skip: number,
): number {
  for (let index = 0; index < lanes.length; index += 1) {
    if (index !== skip && lanes[index] === parent) {
      return index;
    }
  }
  return -1;
}
