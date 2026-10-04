import type { CompareResult } from './types.js';

export type ParentMap = ReadonlyMap<string, readonly string[]>;

function reachable(parents: ParentMap, starts: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const s of starts) {
    if (parents.has(s) && !seen.has(s)) {
      seen.add(s);
      stack.push(s);
    }
  }
  while (stack.length > 0) {
    const h = stack.pop()!;
    for (const p of parents.get(h) ?? []) {
      if (!seen.has(p) && parents.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return seen;
}

/**
 * Compare two commits using an in-memory parent map (hash → parents).
 * `onlyA` = reachable from A but not from B (what `git rev-list A ^B` prints);
 * `mergeBases` matches `git merge-base --all A B`.
 * Result lists are ordered by the iteration order of `parents` (pass the log order to get newest-first).
 */
export function compareCommits(parents: ParentMap, a: string, b: string): CompareResult {
  const ra = reachable(parents, [a]);
  const rb = reachable(parents, [b]);
  const common = new Set<string>();
  for (const h of ra) if (rb.has(h)) common.add(h);

  // best common ancestors = common commits that are not a proper ancestor of another common commit
  const covered = new Set<string>();
  for (const h of common) {
    for (const p of parents.get(h) ?? []) covered.add(p);
  }
  const coveredAll = reachable(parents, covered);
  const mergeBases: string[] = [];
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const h of parents.keys()) {
    if (common.has(h)) {
      if (!coveredAll.has(h)) mergeBases.push(h);
    } else if (ra.has(h)) onlyA.push(h);
    else if (rb.has(h)) onlyB.push(h);
  }
  return { mergeBases, onlyA, onlyB, ahead: onlyA.length, behind: onlyB.length };
}
