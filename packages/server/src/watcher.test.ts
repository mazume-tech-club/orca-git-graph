import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitRepo } from './repo.js';
import { RepoWatcher, type WatchEvent } from './watcher.js';
import { commit, sh, tempDir, write, type Fixture } from './testutil.js';

let fx: Fixture;
let main: string;
let linked: string;

beforeEach(() => {
  fx = tempDir('watch');
  main = join(fx.dir, 'main');
  linked = join(fx.dir, 'linked');
  sh(fx.dir, ['init', '-q', '-b', 'main', 'main']);
  commit(main, 'one');
  sh(main, ['worktree', 'add', '-q', '-b', 'wt-branch', linked]);
});
afterEach(() => fx.cleanup());

async function collect(repoPath: string): Promise<{ events: WatchEvent[]; stop: () => void; waitFor: (e: WatchEvent, ms?: number) => Promise<void> }> {
  const watcher = new RepoWatcher(await GitRepo.open(repoPath));
  const events: WatchEvent[] = [];
  const stop = watcher.subscribe((e) => events.push(e));
  await watcher.ready();
  await new Promise((r) => setTimeout(r, 300));
  const waitFor = async (e: WatchEvent, ms = 6000) => {
    const t0 = Date.now();
    while (!events.includes(e)) {
      if (Date.now() - t0 > ms) throw new Error(`no ${e} event within ${ms} ms (saw: ${events.join(',') || 'none'})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { events, stop, waitFor };
}

describe('RepoWatcher', () => {
  it('uses a linked worktree whose .git is a file', async () => {
    const repo = await GitRepo.open(linked);
    expect(repo.path.replace(/\\/g, '/')).toBe(linked.replace(/\\/g, '/'));
    const w = await collect(linked);
    // a branch created from the MAIN checkout lives in the shared refs dir
    sh(main, ['branch', 'created-elsewhere']);
    await w.waitFor('refs');
    w.stop();
  });

  it('notices HEAD changes of the linked worktree itself (per-worktree git dir)', async () => {
    const w = await collect(linked);
    sh(linked, ['checkout', '-q', '-b', 'moved-in-linked']);
    await w.waitFor('refs');
    w.stop();
  });

  it('notices commits made in the linked worktree', async () => {
    const w = await collect(linked);
    commit(linked, 'two');
    await w.waitFor('refs');
    w.stop();
  });

  it('notices packed refs', async () => {
    sh(main, ['branch', 'to-pack']);
    const w = await collect(main);
    sh(main, ['pack-refs', '--all']);
    await w.waitFor('refs');
    w.stop();
  });

  it('notices index changes and working-tree edits (status)', async () => {
    const w = await collect(main);
    write(main, 'new.txt', 'x\n');
    sh(main, ['add', 'new.txt']);
    await w.waitFor('status');
    w.stop();
  });

  it('stops watching when the last listener leaves', async () => {
    const w = await collect(main);
    w.stop();
    const before = w.events.length;
    sh(main, ['branch', 'after-stop']);
    await new Promise((r) => setTimeout(r, 600));
    expect(w.events.length).toBe(before);
  });

  it('invalidates the cached refs when refs change, so the next request sees them', async () => {
    const repo = await GitRepo.open(main);
    const watcher = new RepoWatcher(repo);
    const events: WatchEvent[] = [];
    const stop = watcher.subscribe((e) => events.push(e));
    await watcher.ready();
    await new Promise((r) => setTimeout(r, 300));
    const before = (await repo.getRefsState(60_000)).refs.map((r) => r.name);
    expect(before).not.toContain('late');
    const seen = events.filter((e) => e === 'refs').length;
    sh(main, ['branch', 'late']);
    const t0 = Date.now();
    while (events.filter((e) => e === 'refs').length === seen && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 50));
    // even a long max-age must not return the stale snapshot
    expect((await repo.getRefsState(60_000)).refs.map((r) => r.name)).toContain('late');
    stop();
  });
});
