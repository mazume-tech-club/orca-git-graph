import { describe, expect, it } from 'vitest';
import { createLaneState, layoutRows } from './lanes.js';
import type { GraphRow } from './types.js';

type C = { hash: string; parents: string[] };
const c = (hash: string, ...parents: string[]): C => ({ hash, parents });

/** Render rows as text: `*` is the commit, `|` a lane passing through, `/` `\` lanes joining or splitting. */
function ascii(rows: GraphRow[]): string {
  return rows
    .map((r) => {
      const cells: string[] = Array(r.width * 2).fill(' ');
      for (const e of r.edges) {
        if (e.type === 'through') cells[e.col * 2] = '|';
      }
      for (const e of r.edges) {
        if (e.type === 'in' && e.col !== r.col) cells[Math.min(e.col, r.col) * 2 + 1] = e.col > r.col ? '/' : '\\';
        if (e.type === 'out' && e.col !== r.col) cells[Math.min(e.col, r.col) * 2 + 1] = e.col > r.col ? '\\' : '/';
      }
      cells[r.col * 2] = '*';
      return `${cells.join('').trimEnd()} ${r.hash}`;
    })
    .join('\n');
}

const layout = (commits: C[]) => layoutRows(commits, createLaneState());

describe('layoutRows', () => {
  it('keeps a linear history in one column', () => {
    const rows = layout([c('d', 'c'), c('c', 'b'), c('b', 'a'), c('a')]);
    expect(rows.every((r) => r.col === 0 && r.width === 1)).toBe(true);
    expect(ascii(rows)).toMatchInlineSnapshot(`
      "* d
      * c
      * b
      * a"
    `);
  });

  it('handles a simple branch and merge', () => {
    // m merges f (feature) into main; both descend from a
    const rows = layout([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')]);
    expect(ascii(rows)).toMatchInlineSnapshot(`
      "*\\ m
      | * f
      * | b
      */ a"
    `);
  });

  it('frees the column after a merge and reuses it', () => {
    const rows = layout([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')]);
    expect(rows[0]!.width).toBe(2);
    expect(rows[3]!.col).toBe(0);
    expect(rows[3]!.width).toBe(2); // both lanes still converge into `a`
    const after = layout([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a'), c('z')]);
    expect(after[4]!.width).toBe(1);
  });

  it('handles an octopus merge', () => {
    const rows = layout([c('o', 'p1', 'p2', 'p3'), c('p3', 'r'), c('p2', 'r'), c('p1', 'r'), c('r')]);
    expect(rows[0]!.edges.filter((e) => e.type === 'out')).toHaveLength(3);
    expect(rows[0]!.width).toBe(3);
    // all three lanes use distinct colours
    expect(new Set(rows[0]!.edges.filter((e) => e.type === 'out').map((e) => e.color)).size).toBe(3);
    expect(rows[4]!.edges.filter((e) => e.type === 'in')).toHaveLength(3);
  });

  it('handles multiple roots', () => {
    const rows = layout([c('x2', 'x1'), c('y2', 'y1'), c('x1'), c('y1')]);
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0, 1]);
    expect(rows[2]!.edges.filter((e) => e.type === 'out')).toHaveLength(0);
    expect(rows[3]!.width).toBe(2);
  });

  it('returns nothing for an empty history', () => {
    expect(layout([])).toEqual([]);
  });

  it('lays out a detached tip like any other commit', () => {
    // two tips with no common child: HEAD (detached) and main
    const rows = layout([c('h', 'a'), c('m', 'a'), c('a')]);
    expect(rows[0]!.col).toBe(0);
    expect(rows[1]!.col).toBe(1);
    expect(rows[2]!.edges.filter((e) => e.type === 'in').map((e) => e.col).sort()).toEqual([0, 1]);
  });

  it('gives a new colour to each new branch and keeps colour along the first parent', () => {
    const rows = layout([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')]);
    expect(rows[0]!.color).toBe(rows[2]!.color); // main line
    expect(rows[1]!.color).not.toBe(rows[0]!.color); // feature line
  });

  it('gives the same result when paged', () => {
    const all = [c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')];
    const whole = layout(all);
    const state = createLaneState();
    const paged = [...layoutRows(all.slice(0, 2), state), ...layoutRows(all.slice(2), state)];
    expect(paged).toEqual(whole);
  });

  it('is fast enough for 10k commits', () => {
    // synthetic history: a main line with a side branch forked and merged every 10 commits
    const oldestFirst: C[] = [c('m0')];
    let main = 'm0';
    for (let i = 1; i < 10000; i++) {
      const h = `m${i}`;
      if (i % 10 === 0) {
        oldestFirst.push(c(`s${i}`, main));
        oldestFirst.push(c(h, main, `s${i}`));
      } else {
        oldestFirst.push(c(h, main));
      }
      main = h;
    }
    const topo = oldestFirst.reverse();
    const t0 = performance.now();
    const rows = layout(topo);
    const ms = performance.now() - t0;
    expect(rows).toHaveLength(topo.length);
    expect(ms).toBeLessThan(200);
  });
});
