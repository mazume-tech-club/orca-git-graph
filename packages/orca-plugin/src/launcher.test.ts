import { describe, expect, it, vi } from 'vitest';
import type { OrcaTab, OrcaTerminal, OrcaWorktree, WorkspaceContext } from '@orca-git-graph/platform';
import { buildUrl, cacheKey, findExistingTab, openGitGraph, type LauncherDeps, type WorktreeCache } from './launcher.js';

const wt = (over: Partial<OrcaWorktree> = {}): OrcaWorktree => ({
  id: 'repo1::C:\\work\\app',
  repoId: 'repo1',
  hostId: 'local',
  kind: 'git',
  displayName: 'app',
  branch: 'main',
  path: 'C:\\work\\app',
  ...over,
});

function makeDeps(over: Partial<LauncherDeps> = {}, tabs: OrcaTab[] = []): LauncherDeps & { calls: string[] } {
  const calls: string[] = [];
  const deps: LauncherDeps = {
    readContext: async () => ({ branch: 'main', displayName: 'app', terminals: [] }) as WorkspaceContext,
    notify: vi.fn(async () => undefined),
    resolveOrcaCli: () => 'orca',
    ensureServer: async () => ({ port: 4000, token: 'tok' }),
    orca: {
      listWorktrees: async () => [wt()],
      listTerminals: async () => [] as OrcaTerminal[],
      listTabs: async () => tabs,
      createTab: async (_c, id, url) => (calls.push(`create ${id} ${url}`), 'page-new'),
      switchTab: async (_c, _id, page) => void calls.push(`switch ${page}`),
      navigateTab: async (_c, _id, page, url) => void calls.push(`navigate ${page} ${url}`),
    },
    log: () => undefined,
    ...over,
  };
  return Object.assign(deps, { calls });
}

describe('openGitGraph', () => {
  it('creates a tab for the focused worktree', async () => {
    const d = makeDeps();
    const r = await openGitGraph(d);
    expect(r).toMatchObject({ ok: true, action: 'created' });
    expect(d.calls).toEqual([`create repo1::C:\\work\\app ${buildUrl(4000, 'tok', 'repo1::C:\\work\\app')}`]);
  });

  it('puts the worktree id and token in the URL, escaped', () => {
    const url = buildUrl(1234, 'a+b/c', 'r::C:\\x y');
    const u = new URL(url);
    expect(u.host).toBe('127.0.0.1:1234');
    expect(u.searchParams.get('repo')).toBe('r::C:\\x y');
    expect(u.searchParams.get('token')).toBe('a+b/c');
  });

  it('re-uses the existing tab when the URL is unchanged', async () => {
    const url = buildUrl(4000, 'tok', wt().id);
    const d = makeDeps({}, [{ browserPageId: 'p1', url, title: 'x', active: false }]);
    expect(await openGitGraph(d)).toMatchObject({ ok: true, action: 'switched' });
    expect(d.calls).toEqual(['switch p1']);
  });

  it('points an old tab at the new server after a restart', async () => {
    const old = buildUrl(3999, 'old', wt().id);
    const d = makeDeps({}, [{ browserPageId: 'p1', url: old, title: 'x', active: false }]);
    expect(await openGitGraph(d)).toMatchObject({ ok: true, action: 'navigated' });
    expect(d.calls).toEqual(['switch p1', `navigate p1 ${buildUrl(4000, 'tok', wt().id)}`]);
  });

  it('ignores tabs that are not ours', async () => {
    const d = makeDeps({}, [
      { browserPageId: 'x1', url: 'https://example.com/?repo=' + encodeURIComponent(wt().id) + '&token=1', title: '', active: false },
      { browserPageId: 'x2', url: 'http://127.0.0.1:3000/?repo=other', title: '', active: false },
    ]);
    expect(await openGitGraph(d)).toMatchObject({ ok: true, action: 'created' });
  });

  it.each([
    ['no CLI', { resolveOrcaCli: () => null }, 'no-cli'],
    ['no focused worktree', { readContext: async () => null }, 'no-context'],
    ['server failure', { ensureServer: async () => Promise.reject(new Error('boom')) }, 'server'],
  ] as const)('reports %s with a notification', async (_n, over, reason) => {
    const d = makeDeps(over as Partial<LauncherDeps>);
    const r = await openGitGraph(d);
    expect(r).toMatchObject({ ok: false, reason });
    expect(d.notify).toHaveBeenCalledTimes(1);
  });

  it('explains remote worktrees', async () => {
    const d = makeDeps({ orca: { ...makeDeps().orca, listWorktrees: async () => [wt({ hostId: 'ssh-1' })] } });
    expect(await openGitGraph(d)).toMatchObject({ ok: false, reason: 'remote' });
  });

  it('rejects non-git workspaces', async () => {
    const d = makeDeps({ orca: { ...makeDeps().orca, listWorktrees: async () => [wt({ kind: 'folder' })] } });
    expect(await openGitGraph(d)).toMatchObject({ ok: false, reason: 'not-git' });
  });

  it('reports an unknown worktree', async () => {
    const d = makeDeps({ orca: { ...makeDeps().orca, listWorktrees: async () => [] } });
    expect(await openGitGraph(d)).toMatchObject({ ok: false, reason: 'no-match' });
  });

  it('reports ambiguous worktrees instead of guessing', async () => {
    const d = makeDeps({ orca: { ...makeDeps().orca, listWorktrees: async () => [wt(), wt({ id: 'repo2::D:\\other\\app', repoId: 'repo2', path: 'D:\\other\\app' })] } });
    expect(await openGitGraph(d)).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('disambiguates by terminal id when names collide', async () => {
    const a = wt();
    const b = wt({ id: 'repo2::D:\\other\\app', repoId: 'repo2', path: 'D:\\other\\app' });
    const d = makeDeps({
      readContext: async () => ({ branch: 'main', displayName: 'app', terminals: [{ id: 'term_b' }] }),
      orca: { ...makeDeps().orca, listWorktrees: async () => [a, b], listTerminals: async () => [{ handle: 'term_b', ptyId: 'pty', worktreeId: b.id }] },
    });
    expect(await openGitGraph(d)).toMatchObject({ ok: true, action: 'created', url: buildUrl(4000, 'tok', b.id) });
  });

  it('reports Orca CLI failures', async () => {
    const d = makeDeps({ orca: { ...makeDeps().orca, listWorktrees: async () => Promise.reject(new Error('selector_not_found')) } });
    expect(await openGitGraph(d)).toMatchObject({ ok: false, reason: 'orca' });
  });
});

describe('findExistingTab', () => {
  it('requires loopback host, matching repo and a token', () => {
    const tab = (url: string): OrcaTab => ({ browserPageId: 'p', url, title: '', active: false });
    expect(findExistingTab([tab('http://127.0.0.1:1/?repo=a&token=t')], 'a')).toBeDefined();
    expect(findExistingTab([tab('http://127.0.0.1:1/?repo=a')], 'a')).toBeUndefined();
    expect(findExistingTab([tab('http://localhost:1/?repo=a&token=t')], 'a')).toBeUndefined();
    expect(findExistingTab([tab('not a url')], 'a')).toBeUndefined();
  });
});

describe('latency optimisations', () => {
  const ctx: WorkspaceContext = { branch: 'main', displayName: 'app', terminals: [{ id: 't1' }] };
  const memCache = (): WorktreeCache & { store: Map<string, OrcaWorktree> } => {
    const store = new Map<string, OrcaWorktree>();
    return { store, get: async (k) => store.get(k) ?? null, set: async (k, w) => void store.set(k, w), delete: async (k) => void store.delete(k) };
  };

  it('starts the server before the worktree is known', async () => {
    const order: string[] = [];
    const d = makeDeps({
      ensureServer: async () => (order.push('server'), { port: 4000, token: 'tok' }),
      readContext: async () => (order.push('context'), ctx),
    });
    await openGitGraph(d);
    expect(order).toEqual(['server', 'context']);
  });

  it('remembers the resolved worktree and skips worktree ps / terminal list next time', async () => {
    const cache = memCache();
    let slowCalls = 0;
    const base = makeDeps();
    const mk = () =>
      makeDeps({
        readContext: async () => ctx,
        cache,
        orca: {
          ...base.orca,
          listWorktrees: async () => (slowCalls++, [wt()]),
          listTerminals: async () => (slowCalls++, [{ handle: 't1', ptyId: 'p', worktreeId: wt().id }]),
        },
      });
    expect(await openGitGraph(mk())).toMatchObject({ ok: true });
    expect(slowCalls).toBe(2);
    expect(cache.store.get(cacheKey(ctx)!)).toMatchObject({ id: wt().id });
    expect(await openGitGraph(mk())).toMatchObject({ ok: true, action: 'created' });
    expect(slowCalls).toBe(2); // not called again
  });

  it('falls back to a full lookup when the remembered worktree is gone', async () => {
    const cache = memCache();
    cache.store.set(cacheKey(ctx)!, wt({ id: 'repo1::C:\gone' }));
    const base = makeDeps();
    const d = makeDeps({
      readContext: async () => ctx,
      cache,
      orca: {
        ...base.orca,
        listTabs: async (_c, id) => (id.endsWith('gone') ? Promise.reject(new Error('selector_not_found')) : []),
        listTerminals: async () => [{ handle: 't1', ptyId: 'p', worktreeId: wt().id }],
      },
    });
    expect(await openGitGraph(d)).toMatchObject({ ok: true, action: 'created' });
    expect(cache.store.get(cacheKey(ctx)!)).toMatchObject({ id: wt().id }); // corrected
  });

  it('does not use the cache without terminal ids (nothing specific to key on)', () => {
    expect(cacheKey({ branch: 'main', displayName: 'app', terminals: [] })).toBeNull();
  });
});

describe('avoiding the slow tab list', () => {
  // with no browser tab open every `orca tab list` takes ~8 s; the launcher must not ask when the server says nothing is open
  const listing = (tabs: OrcaTab[] = []) => {
    const calls = { list: 0 };
    const base = makeDeps();
    return { calls, orca: { ...base.orca, listTabs: async () => (calls.list++, tabs) } };
  };

  it('creates the tab directly when no page is connected', async () => {
    const l = listing();
    const d = makeDeps({ hasOpenTab: async () => false, orca: l.orca });
    expect(await openGitGraph(d)).toMatchObject({ ok: true, action: 'created' });
    expect(l.calls.list).toBe(0);
  });

  it('looks for the existing tab when a page is connected', async () => {
    const url = buildUrl(4000, 'tok', wt().id);
    const l = listing([{ browserPageId: 'p1', url, title: '', active: false }]);
    const d = makeDeps({ hasOpenTab: async () => true, orca: l.orca });
    expect(await openGitGraph(d)).toMatchObject({ ok: true, action: 'switched' });
    expect(l.calls.list).toBe(1);
  });

  it('falls back to the tab list when the server cannot say', async () => {
    const l = listing();
    const d = makeDeps({ hasOpenTab: async () => null, orca: l.orca });
    await openGitGraph(d);
    expect(l.calls.list).toBe(1);
  });
});
