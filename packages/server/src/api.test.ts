import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareCommits, type CommitDetail, type CompareResponse, type DiffFileResponse, type DiffFilesResponse, type LogResponse, type RepoInfo, type SearchResponse } from '@orca-git-graph/core';
import { createApp } from './app.js';
import { RepoRegistry } from './registry.js';
import { startServer, type RunningServer } from './server.js';
import { buildFixture, commit, initRepo, sh, tempDir, write, type Fixture } from './testutil.js';

let fx: ReturnType<typeof buildFixture>;
let srv: RunningServer;
let repoId: string;

const url = (path: string, params: Record<string, string> = {}) => {
  const q = new URLSearchParams({ repo: repoId, token: srv.token, ...params });
  return `http://127.0.0.1:${srv.port}${path}?${q}`;
};
const get = async <T>(path: string, params?: Record<string, string>): Promise<T> => {
  const res = await fetch(url(path, params));
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(JSON.stringify(body)), { status: res.status, body });
  return body as T;
};
const status = async (path: string, params?: Record<string, string>) => (await fetch(url(path, params))).status;

beforeAll(async () => {
  fx = buildFixture();
  srv = await startServer({ repos: [fx.dir] });
  repoId = srv.repos[0]!.id;
}, 60_000);

afterAll(async () => {
  await srv.close();
  fx.cleanup();
});

describe('security', () => {
  it('requires a token', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/repo?repo=${repoId}`);
    expect(res.status).toBe(401);
    const bad = await fetch(`http://127.0.0.1:${srv.port}/api/repo?repo=${repoId}&token=nope`);
    expect(bad.status).toBe(401);
  });

  it('accepts the token as a header', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/repo?repo=${repoId}`, { headers: { 'x-orca-git-graph-token': srv.token } });
    expect(res.status).toBe(200);
  });

  it('listens on loopback only', async () => {
    const { networkInterfaces } = await import('node:os');
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && !i.internal && i.family === 'IPv4');
    if (!external) return; // no non-loopback interface to test with
    await expect(fetch(`http://${external.address}:${srv.port}/api/health?token=${srv.token}`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  });

  it('rejects unexpected Host headers', async () => {
    const app = createApp({ token: 't', registry: new RepoRegistry(), allowedHosts: () => ['127.0.0.1:1'], onActivity: () => {}, onSseCount: () => {} });
    const res = await app.request('/api/health?token=t', { headers: { host: 'evil.example:1' } });
    expect(res.status).toBe(403);
    const ok = await app.request('/api/health?token=t', { headers: { host: '127.0.0.1:1' } });
    expect(ok.status).toBe(200);
  });

  it('does not accept arbitrary repo paths or ids', async () => {
    expect(await status('/api/repo', { repo: fx.dir })).toBe(404);
    expect(await status('/api/repo', { repo: '../../etc' })).toBe(404);
  });

  it('rejects ref names that look like options or revision expressions', async () => {
    for (const bad of ['--upload-pack=x', '-h', 'main..feature', 'main@{1}', 'main~1', 'a b']) {
      expect(await status('/api/compare', { a: bad, b: 'main' })).toBe(400);
    }
    expect(await status('/api/compare', { a: 'nope', b: 'main' })).toBe(404);
  });

  it('rejects path traversal in diff paths', async () => {
    expect(await status('/api/diff/file', { a: 'main', b: 'feature', path: '../secret' })).toBe(400);
    expect(await status('/api/diff/file', { a: 'main', b: 'feature', path: 'C:\\x' })).toBe(400);
  });

  it('only fetches on POST', async () => {
    expect(await status('/api/fetch')).toBe(404);
  });
});

describe('/api/repo', () => {
  it('reports head, refs, remotes and presets', async () => {
    const info = await get<RepoInfo>('/api/repo');
    expect(info.head).toMatchObject({ branch: 'main', detached: false, hash: fx.shas.m });
    expect(info.remotes).toEqual(['origin']);
    const names = info.refs.map((r) => `${r.type}:${r.name}`).sort();
    expect(names).toEqual(['local:feature', 'local:main', 'remote:origin/feature', 'remote:origin/main', 'tag:v1', 'tag:v2']);
    // the annotated tag is peeled to the commit
    expect(info.refs.find((r) => r.name === 'v2')!.hash).toBe(fx.shas.c);
    expect(info.refs.find((r) => r.name === 'main')).toMatchObject({ isHead: true, upstream: 'origin/main' });
    expect(info.presets.map((p) => p.id)).toEqual(['head-upstream']);
    expect(info.dirty).toEqual({ changed: 0, untracked: 0 });
  });
});

describe('/api/log', () => {
  it('returns commits with lane rows and refs, topologically ordered', async () => {
    const log = await get<LogResponse>('/api/log', { limit: '100' });
    expect(log.total).toBe(7);
    expect(log.nextCursor).toBeNull();
    const order = log.items.map((i) => i.commit.hash);
    const pos = (h: string) => order.indexOf(h);
    for (const it of log.items) for (const p of it.commit.parents) expect(pos(p)).toBeGreaterThan(pos(it.commit.hash));
    const m = log.items.find((i) => i.commit.hash === fx.shas.m)!;
    expect(m.commit.parents).toHaveLength(2);
    expect(m.refs).toEqual(['refs/heads/main']);
    expect(log.items.find((i) => i.commit.hash === fx.shas.o)!.refs).toEqual(['refs/remotes/origin/main']);
    const b = log.items.find((i) => i.commit.hash === fx.shas.b)!;
    expect(b.commit.subject).toBe('b: second');
    expect(b.refs).toEqual(['refs/tags/v1']);
  });

  it('pages consistently', async () => {
    const full = await get<LogResponse>('/api/log', { limit: '100' });
    const p1 = await get<LogResponse>('/api/log', { limit: '3' });
    expect(p1.nextCursor).toBe(3);
    const p2 = await get<LogResponse>('/api/log', { limit: '3', cursor: String(p1.nextCursor) });
    const p3 = await get<LogResponse>('/api/log', { limit: '3', cursor: String(p2.nextCursor) });
    expect(p3.nextCursor).toBeNull();
    expect([...p1.items, ...p2.items, ...p3.items]).toEqual(full.items);
  });

  it('detects stale revisions', async () => {
    expect(await status('/api/log', { rev: 'deadbeef0000' })).toBe(409);
  });

  it('filters by refs', async () => {
    const log = await get<LogResponse>('/api/log', { refs: 'refs/heads/feature' });
    expect(log.items.map((i) => i.commit.hash)).toEqual([fx.shas.e, fx.shas.d, fx.shas.b, fx.shas.a]);
  });

  it('handles commit messages and file names with odd characters', async () => {
    const d = await get<CommitDetail>(`/api/commit/${fx.shas.b}`);
    expect(d.commit.subject).toBe('b: second');
    expect(d.body).toBe('b: second\n\nbody line 1\nbody line 2');
    expect(d.files.map((f) => f.path).sort()).toEqual(['src/app.txt', 'with space.txt', 'ünï.txt']);
    expect(d.base).toBe(fx.shas.a);
  });
});

describe('/api/search', () => {
  it('finds by message, author, hash prefix and ref name', async () => {
    const log = await get<LogResponse>('/api/log', { limit: '100' });
    const idx = (h: string) => log.items.findIndex((i) => i.commit.hash === h);
    expect((await get<SearchResponse>('/api/search', { q: 'feature work' })).indices).toEqual([idx(fx.shas.d!)]);
    expect((await get<SearchResponse>('/api/search', { q: fx.shas.c!.slice(0, 8) })).indices).toEqual([idx(fx.shas.c!)]);
    expect((await get<SearchResponse>('/api/search', { q: 'v1' })).indices).toEqual([idx(fx.shas.b!)]);
    const byAuthor = await get<SearchResponse>('/api/search', { q: 'Test Author' });
    expect(byAuthor.indices.length).toBeGreaterThanOrEqual(6);
    expect((await get<SearchResponse>('/api/search', { q: 'no-such-thing-xyz' })).indices).toEqual([]);
  });

  it('treats the query as a literal string', async () => {
    expect((await get<SearchResponse>('/api/search', { q: '--all' })).indices).toEqual([]);
    expect((await get<SearchResponse>('/api/search', { q: '.*' })).indices).toEqual([]);
  });
});

describe('/api/compare', () => {
  it('matches git and the in-memory core implementation', async () => {
    const cmp = await get<CompareResponse>('/api/compare', { a: 'main', b: 'origin/main' });
    expect(cmp.mergeBases).toEqual([fx.shas.m]);
    expect(cmp.ahead).toBe(0);
    expect(cmp.behind).toBe(1);
    expect(cmp.onlyB).toEqual([fx.shas.o]);

    const log = await get<LogResponse>('/api/log', { limit: '100' });
    const parents = new Map(log.items.map((i) => [i.commit.hash, i.commit.parents]));
    for (const [a, b] of [['main', 'feature'], ['feature', 'v1'], ['origin/main', 'v2'], ['main', 'origin/feature']] as const) {
      const server = await get<CompareResponse>('/api/compare', { a, b });
      const mem = compareCommits(parents, server.a, server.b);
      expect(server.mergeBases.sort()).toEqual(mem.mergeBases.sort());
      expect(new Set(server.onlyA)).toEqual(new Set(mem.onlyA));
      expect(new Set(server.onlyB)).toEqual(new Set(mem.onlyB));
      expect([server.ahead, server.behind]).toEqual([mem.ahead, mem.behind]);
    }
  });

  it('compares tags, branches and HEAD', async () => {
    const r = await get<CompareResponse>('/api/compare', { a: 'v1', b: 'HEAD' });
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(4);
  });
});

describe('/api/diff', () => {
  it('lists changed files for three-dot and two-dot comparisons', async () => {
    const three = await get<DiffFilesResponse>('/api/diff/files', { a: 'v2', b: 'feature', mode: 'three-dot' });
    // what feature introduced since the merge-base (b): d + e
    expect(three.base).toBe(fx.shas.b);
    expect(three.files.map((f) => f.path).sort()).toEqual(['-dash.txt', expect.stringMatching(/^f\d+\.txt$/), 'src/app.txt'].sort());
    const two = await get<DiffFilesResponse>('/api/diff/files', { a: 'v2', b: 'feature', mode: 'two-dot' });
    expect(two.files.some((f) => f.path === 'main.txt' && f.status === 'D')).toBe(true);
    const app = three.files.find((f) => f.path === 'src/app.txt')!;
    expect(app).toMatchObject({ status: 'M', added: 1, deleted: 0 });
  });

  it('returns the diff of one file, including names starting with a dash', async () => {
    const d = await get<DiffFileResponse>('/api/diff/file', { a: 'v2', b: 'feature', mode: 'three-dot', path: 'src/app.txt' });
    expect(d.diff).toContain('+two');
    const dash = await get<DiffFileResponse>('/api/diff/file', { a: 'v2', b: 'feature', mode: 'three-dot', path: '-dash.txt' });
    expect(dash.diff).toContain('+d');
    // glob characters are literal
    const glob = await get<DiffFileResponse>('/api/diff/file', { a: 'v2', b: 'feature', mode: 'three-dot', path: '*.txt' });
    expect(glob.diff).toBe('');
  });

  it('diffs a root commit against the empty tree', async () => {
    const d = await get<DiffFilesResponse>('/api/diff/files', { b: fx.shas.a! });
    expect(d.files.map((f) => f.path)).toEqual(['README.md']);
    const f = await get<DiffFileResponse>('/api/diff/file', { b: fx.shas.a!, path: 'README.md' });
    expect(f.diff).toContain('+# hi');
  });
});

describe('working tree', () => {
  it('reports uncommitted and untracked files', async () => {
    write(fx.dir, 'src/app.txt', 'one\ntwo\nthree\n');
    write(fx.dir, 'new file.txt', 'brand new\n');
    try {
      const info = await get<RepoInfo>('/api/repo');
      expect(info.dirty).toEqual({ changed: 1, untracked: 1 });
      const files = (await get<{ files: Array<{ path: string; status: string }> }>('/api/worktree/files')).files;
      expect(files.map((f) => `${f.status}:${f.path}`).sort()).toEqual(['A:new file.txt', 'M:src/app.txt']);
      const tracked = await get<DiffFileResponse>('/api/worktree/diff', { path: 'src/app.txt' });
      expect(tracked.diff).toContain('+three');
      const untracked = await get<DiffFileResponse>('/api/worktree/diff', { path: 'new file.txt' });
      expect(untracked.diff).toContain('+brand new');
    } finally {
      sh(fx.dir, ['checkout', '--', 'src/app.txt']);
      sh(fx.dir, ['clean', '-fdq']);
    }
  });
});

describe('fetch', () => {
  it('fetches and prunes on POST and refreshes refs', async () => {
    const before = await get<RepoInfo>('/api/repo');
    // advance origin through a second clone, then fetch via the API
    const other = tempDir('other');
    try {
      sh(other.dir, ['clone', '-q', fx.origin, 'c']);
      const c = `${other.dir}/c`;
      commit(c, 'p: pushed later');
      sh(c, ['push', '-q', 'origin', 'main']);
      const res = await fetch(url('/api/fetch'), { method: 'POST' });
      expect(await res.json()).toMatchObject({ ok: true });
      const after = await get<RepoInfo>('/api/repo');
      expect(after.rev).not.toBe(before.rev);
      expect(after.refs.find((r) => r.name === 'origin/main')!.hash).not.toBe(before.refs.find((r) => r.name === 'origin/main')!.hash);
    } finally {
      other.cleanup();
    }
  });
});

describe('edge-case repositories', () => {
  it('handles an empty repository', async () => {
    const t = tempDir('empty');
    initRepo(t.dir);
    const s = await startServer({ repos: [t.dir] });
    try {
      const q = `repo=${s.repos[0]!.id}&token=${s.token}`;
      const info = (await (await fetch(`http://127.0.0.1:${s.port}/api/repo?${q}`)).json()) as RepoInfo;
      // an unborn branch still has a name
      expect(info.head).toEqual({ hash: null, branch: 'main', detached: false });
      expect(info.refs).toEqual([]);
      const log = (await (await fetch(`http://127.0.0.1:${s.port}/api/log?${q}`)).json()) as LogResponse;
      expect(log).toMatchObject({ items: [], nextCursor: null, total: 0 });
    } finally {
      await s.close();
      t.cleanup();
    }
  });

  it('handles a detached HEAD', async () => {
    const t = tempDir('detached');
    initRepo(t.dir);
    const a = commit(t.dir, 'one');
    commit(t.dir, 'two');
    sh(t.dir, ['checkout', '-q', '--detach', a]);
    const s = await startServer({ repos: [t.dir] });
    try {
      const q = `repo=${s.repos[0]!.id}&token=${s.token}`;
      const info = (await (await fetch(`http://127.0.0.1:${s.port}/api/repo?${q}`)).json()) as RepoInfo;
      expect(info.head).toEqual({ hash: a, branch: null, detached: true });
      const log = (await (await fetch(`http://127.0.0.1:${s.port}/api/log?${q}`)).json()) as LogResponse;
      expect(log.total).toBe(2);
    } finally {
      await s.close();
      t.cleanup();
    }
  });

  it('reports a non-repository path clearly', async () => {
    const t = tempDir('plain');
    await expect(startServer({ repos: [t.dir] })).rejects.toMatchObject({ code: 'not_a_git_repo' });
    t.cleanup();
  });
});

describe('orca worktrees', () => {
  let t: Fixture;
  it('serves allowed worktrees, and explains remote / non-git ones', async () => {
    t = tempDir('orca');
    initRepo(t.dir);
    commit(t.dir, 'x');
    const wt = (over: object) => ({ id: 'r1::' + t.dir, repoId: 'r1', hostId: 'local', kind: 'git', displayName: 'x', branch: 'main', path: t.dir, ...over });
    const s = await startServer({
      repos: [],
      worktreeProvider: async () => [wt({}), wt({ id: 'r2::remote', hostId: 'ssh-1' }), wt({ id: 'r3::folder', kind: 'folder' })],
    });
    try {
      const base = `http://127.0.0.1:${s.port}/api/repo?token=${s.token}&repo=`;
      expect((await fetch(base + encodeURIComponent('r1::' + t.dir))).status).toBe(200);
      const remote = await fetch(base + encodeURIComponent('r2::remote'));
      expect(remote.status).toBe(422);
      expect(await remote.json()).toMatchObject({ error: { code: 'remote_worktree' } });
      const folder = await fetch(base + encodeURIComponent('r3::folder'));
      expect(folder.status).toBe(422);
      expect((await fetch(base + encodeURIComponent('r9::unknown'))).status).toBe(404);
    } finally {
      await s.close();
      t.cleanup();
    }
  });
});
