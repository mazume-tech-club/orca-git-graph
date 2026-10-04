import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrcaWorktree } from '@orca-git-graph/platform';
import { fileWorktreeCache } from './worktree-cache.js';

const wt = (n: number): OrcaWorktree => ({ id: `r::/w${n}`, repoId: 'r', hostId: 'local', kind: 'git', displayName: `w${n}`, branch: 'main', path: `/w${n}` });
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'ogg-wc-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fileWorktreeCache', () => {
  it('stores, returns and deletes entries across instances', async () => {
    const file = join(dir, 'sub', 'c.json');
    await fileWorktreeCache(file).set('k', wt(1));
    expect(await fileWorktreeCache(file).get('k')).toEqual(wt(1));
    expect(await fileWorktreeCache(file).get('other')).toBeNull();
    await fileWorktreeCache(file).delete('k');
    expect(await fileWorktreeCache(file).get('k')).toBeNull();
  });

  it('survives a corrupt file and keeps only the newest entries', async () => {
    const file = join(dir, 'c.json');
    const c = fileWorktreeCache(file);
    for (let i = 0; i < 60; i++) await c.set(`k${i}`, wt(i));
    const keys = Object.keys(JSON.parse(readFileSync(file, 'utf8')));
    expect(keys).toHaveLength(50);
    expect(keys).toContain('k59');
    expect(keys).not.toContain('k0');
    rmSync(file);
    expect(await c.get('k59')).toBeNull();
  });
});
