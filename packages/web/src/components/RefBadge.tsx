import type { RefInfo } from '@orca-git-graph/core';
import { BranchIcon, CheckIcon, CloudIcon, TagIcon } from './Icons.js';

export interface BadgeModel {
  ref: RefInfo;
  /** Remote refs pointing at the same commit as this local branch (shown fused into one badge) */
  remotes: RefInfo[];
}

/**
 * Group the refs of one commit into badges: a local branch absorbs its upstream when both point
 * at the same commit, so "in sync with origin" reads as one badge.
 */
export function groupRefs(refs: RefInfo[]): BadgeModel[] {
  const remotes = refs.filter((r) => r.type === 'remote');
  const used = new Set<RefInfo>();
  const out: BadgeModel[] = [];
  for (const r of refs) {
    if (r.type !== 'local') continue;
    const fused = remotes.filter((x) => x.name === r.upstream || x.name === `${x.remote}/${r.name}`);
    fused.forEach((x) => used.add(x));
    out.push({ ref: r, remotes: fused });
  }
  for (const r of refs) if (r.type === 'remote' && !used.has(r)) out.push({ ref: r, remotes: [] });
  for (const r of refs) if (r.type === 'tag') out.push({ ref: r, remotes: [] });
  return out;
}

export type Role = 'A' | 'B' | null;

export function RefBadge({ model, role, onPick }: { model: BadgeModel; role: (name: string) => Role; onPick: (name: string) => void }) {
  const { ref, remotes } = model;
  const r = role(ref.name) ?? remotes.map((x) => role(x.name)).find(Boolean) ?? null;
  const cls = `badge badge-${ref.type}${ref.isHead ? ' badge-head' : ''}${r ? ` badge-role-${r}` : ''}`;
  const title = [ref.name, ...remotes.map((x) => x.name)].join(' / ');
  return (
    <span className={cls} title={title}>
      <button type="button" className="badge-main" onClick={(e) => { e.stopPropagation(); onPick(ref.name); }}>
        {ref.isHead && <CheckIcon />}
        {ref.type === 'local' && !ref.isHead && <BranchIcon />}
        {ref.type === 'remote' && <CloudIcon />}
        {ref.type === 'tag' && <TagIcon />}
        <span className="badge-name">{ref.name}</span>
        {r && <span className="badge-role">{r}</span>}
      </button>
      {remotes.map((x) => (
        <button type="button" key={x.fullName} className="badge-fused" onClick={(e) => { e.stopPropagation(); onPick(x.name); }} title={x.name}>
          <CloudIcon />
          <span>{x.remote}</span>
        </button>
      ))}
    </span>
  );
}
