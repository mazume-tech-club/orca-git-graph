/**
 * Conservative ref-name validation for values that come from the network.
 * Allows what `git check-ref-format` allows for branch/tag names but rejects a leading `-`
 * and anything that could be read as a revision expression (`..`, `@{`, `~`, `^`, `:`, whitespace).
 * 40/64-char hex hashes and abbreviations (>= 4 chars) are accepted by the same rule.
 */
export function isSafeRefName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{') || name.endsWith('.lock')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return true;
}

export interface Preset {
  id: string;
  label: string;
  a: string;
  b: string;
}

/** Build the one-click comparison presets from the available branch names. */
export function buildPresets(input: {
  head: string | null;
  upstream?: string;
  branches: readonly string[];
  remoteBranches: readonly string[];
}): Preset[] {
  const presets: Preset[] = [];
  const add = (p: Preset) => {
    // the same pair can come from two rules (e.g. current branch == main): show it once
    if (!presets.some((x) => x.a === p.a && x.b === p.b)) presets.push(p);
  };
  const mainName = ['main', 'master'].find((n) => input.branches.includes(n));
  const originMain = ['origin/main', 'origin/master'].find((n) => input.remoteBranches.includes(n));
  if (input.head && input.upstream && input.remoteBranches.includes(input.upstream)) {
    add({ id: 'head-upstream', label: `${input.head} ↔ ${input.upstream}`, a: input.head, b: input.upstream });
  }
  if (input.head && mainName && input.head !== mainName) {
    add({ id: 'head-main', label: `${input.head} ↔ ${mainName}`, a: input.head, b: mainName });
  }
  if (mainName && originMain) {
    add({ id: 'main-origin', label: `${mainName} ↔ ${originMain}`, a: mainName, b: originMain });
  }
  return presets;
}
