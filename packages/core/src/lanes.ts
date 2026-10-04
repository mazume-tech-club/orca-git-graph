import type { Commit, GraphRow, LaneEdge } from './types.js';

interface Lane {
  /** Hash of the commit this lane is waiting for (the next commit that will occupy it) */
  hash: string;
  color: number;
}

/** Carried between calls so a long history can be laid out page by page. */
export interface LaneState {
  lanes: Array<Lane | null>;
  nextColor: number;
}

export function createLaneState(): LaneState {
  return { lanes: [], nextColor: 0 };
}

/**
 * Assign each commit a column and the edges to draw in its row.
 *
 * Input must be topologically ordered (children before parents), as produced by
 * `git log --topo-order`. Mutates `state`; pass the same state for the next page.
 *
 * Properties:
 * - the first parent continues in the same column, so a branch keeps its column
 * - a lane that merges into an existing lane frees its column, and the lowest free column is reused
 */
export function layoutRows(commits: ReadonlyArray<Pick<Commit, 'hash' | 'parents'>>, state: LaneState): GraphRow[] {
  const rows: GraphRow[] = [];
  const lanes = state.lanes;

  for (const commit of commits) {
    const matching: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i]?.hash === commit.hash) matching.push(i);
    }

    let col: number;
    let color: number;
    if (matching.length === 0) {
      col = lanes.indexOf(null);
      if (col === -1) col = lanes.length;
      color = state.nextColor++;
    } else {
      col = matching[0]!;
      color = lanes[col]!.color;
    }

    const edges: LaneEdge[] = [];
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i];
      if (!lane) continue;
      if (lane.hash === commit.hash) edges.push({ type: 'in', col: i, color: lane.color });
      else edges.push({ type: 'through', col: i, color: lane.color });
    }
    for (const i of matching) lanes[i] = null;

    commit.parents.forEach((parent, k) => {
      if (k === 0) {
        // The first parent always keeps this column, even if another lane already waits for the same
        // commit: both lanes then converge when the parent is reached, as `git log --graph` does.
        lanes[col] = { hash: parent, color };
        edges.push({ type: 'out', col, color });
        return;
      }
      const existing = lanes.findIndex((l) => l?.hash === parent);
      if (existing >= 0) {
        edges.push({ type: 'out', col: existing, color: lanes[existing]!.color });
        return;
      }
      let slot = lanes.indexOf(null);
      if (slot === -1) slot = lanes.length;
      const laneColor = state.nextColor++;
      lanes[slot] = { hash: parent, color: laneColor };
      edges.push({ type: 'out', col: slot, color: laneColor });
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    let width = col + 1;
    for (const e of edges) if (e.col + 1 > width) width = e.col + 1;
    rows.push({ hash: commit.hash, col, color, edges, width });
  }

  return rows;
}
