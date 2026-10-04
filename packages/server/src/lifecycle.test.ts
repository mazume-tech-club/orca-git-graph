import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLock } from '@orca-git-graph/platform';
import { AlreadyRunningError, startServer } from './server.js';
import { commit, initRepo, tempDir, type Fixture } from './testutil.js';

let data: string;
let repo: Fixture;
const saved = process.env.ORCA_GIT_GRAPH_DATA_DIR;

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'ogg-data-'));
  process.env.ORCA_GIT_GRAPH_DATA_DIR = data;
  repo = tempDir('life');
  initRepo(repo.dir);
  commit(repo.dir, 'x');
});
afterEach(() => {
  if (saved === undefined) delete process.env.ORCA_GIT_GRAPH_DATA_DIR;
  else process.env.ORCA_GIT_GRAPH_DATA_DIR = saved;
  rmSync(data, { recursive: true, force: true });
  repo.cleanup();
});

describe('server lifecycle', () => {
  it('publishes port and token in the lock file and removes it on close', async () => {
    const s = await startServer({ repos: [repo.dir], writeLockFile: true });
    const lock = await readLock();
    expect(lock).toMatchObject({ port: s.port, token: s.token, pid: process.pid });
    await s.close();
    expect(await readLock()).toBeNull();
  });

  it('refuses to start a second server while one is alive', async () => {
    const first = await startServer({ repos: [repo.dir], writeLockFile: true });
    await expect(startServer({ repos: [repo.dir], writeLockFile: true })).rejects.toBeInstanceOf(AlreadyRunningError);
    await first.close();
  });

  it('takes over a stale lock', async () => {
    const first = await startServer({ repos: [repo.dir], writeLockFile: true });
    // simulate a crash: server gone but the lock file is left behind
    await first.close();
    const { writeLock } = await import('@orca-git-graph/platform');
    await writeLock({ port: first.port, token: 'stale', pid: 999_999, startedAt: 0, apiVersion: 1 });
    const second = await startServer({ repos: [repo.dir], writeLockFile: true });
    expect((await readLock())?.token).toBe(second.token);
    await second.close();
  });

  it('uses a fresh random token on every start and only listens on loopback', async () => {
    const a = await startServer({ repos: [repo.dir] });
    const b = await startServer({ repos: [repo.dir] });
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(24);
    const res = await fetch(`http://127.0.0.1:${a.port}/api/health?token=${a.token}`);
    expect(res.status).toBe(200);
    await a.close();
    await b.close();
  });

  it('exits by itself after being idle, and activity keeps it alive', async () => {
    const s = await startServer({ repos: [repo.dir], writeLockFile: true, idleTimeoutMs: 1500 });
    let closed = false;
    void s.closed.then(() => (closed = true));
    // keep it busy for longer than the idle timeout
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 600));
      await fetch(`http://127.0.0.1:${s.port}/api/health?token=${s.token}`);
    }
    expect(closed).toBe(false);
    // then leave it alone
    await Promise.race([s.closed, new Promise((r) => setTimeout(r, 6000))]);
    expect(closed).toBe(true);
    expect(await readLock()).toBeNull();
  }, 20_000);

  it('does not exit while a live-update connection is open', async () => {
    const s = await startServer({ repos: [repo.dir], idleTimeoutMs: 1000 });
    const id = s.repos[0]!.id;
    const res = await fetch(`http://127.0.0.1:${s.port}/api/events?repo=${encodeURIComponent(id)}&token=${s.token}`);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 3500));
    const alive = await fetch(`http://127.0.0.1:${s.port}/api/health?token=${s.token}`).then((r) => r.ok, () => false);
    expect(alive).toBe(true);
    await res.body!.cancel();
    await s.close();
  }, 20_000);
});
