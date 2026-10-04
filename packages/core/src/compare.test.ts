import { describe, expect, it } from 'vitest';
import { compareCommits } from './compare.js';

const g = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

describe('compareCommits', () => {
  // a - b - c (main)
  //      \ d - e (feat)
  const graph = g({ e: ['d'], d: ['b'], c: ['b'], b: ['a'], a: [] });

  it('computes ahead/behind and exclusive commits', () => {
    const r = compareCommits(graph, 'e', 'c');
    expect(r.mergeBases).toEqual(['b']);
    expect(r.onlyA.sort()).toEqual(['d', 'e']);
    expect(r.onlyB).toEqual(['c']);
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(1);
  });

  it('returns zero for identical commits', () => {
    const r = compareCommits(graph, 'c', 'c');
    expect(r).toMatchObject({ ahead: 0, behind: 0, mergeBases: ['c'] });
  });

  it('handles an ancestor relationship', () => {
    const r = compareCommits(graph, 'b', 'e');
    expect(r.mergeBases).toEqual(['b']);
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(2);
  });

  it('returns several merge bases for criss-cross merges', () => {
    // x and y each merge the other's parent: criss-cross
    const cc = g({ x: ['p', 'q'], y: ['q', 'p'], p: ['r'], q: ['r'], r: [] });
    expect(compareCommits(cc, 'x', 'y').mergeBases.sort()).toEqual(['p', 'q']);
  });

  it('handles unrelated histories', () => {
    const r = compareCommits(g({ a2: ['a1'], a1: [], b1: [] }), 'a2', 'b1');
    expect(r.mergeBases).toEqual([]);
    expect(r.ahead).toBe(2);
    expect(r.behind).toBe(1);
  });
});
