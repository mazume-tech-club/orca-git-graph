import { describe, expect, it, vi } from 'vitest';
import type { LockInfo } from '@orca-git-graph/platform';
import { ensureServer, type ServerProcessDeps } from './server-process.js';

const lock = (over: Partial<LockInfo> = {}): LockInfo => ({ port: 5000, token: 'tok', pid: 1, startedAt: 0, apiVersion: 1, ...over });
const opts = { serverEntry: '/p/server.mjs', webDir: '/p/web', orcaCli: '/o/orca', idleMinutes: 30, startTimeoutMs: 1000 };

function deps(over: Partial<ServerProcessDeps> = {}): ServerProcessDeps {
  let t = 0;
  return {
    readLock: async () => null,
    isAlive: async () => true,
    spawnServer: vi.fn(),
    sleep: async (ms) => void (t += ms),
    now: () => t,
    ...over,
  };
}

describe('ensureServer', () => {
  it('re-uses a live server and does not spawn', async () => {
    const d = deps({ readLock: async () => lock() });
    expect(await ensureServer(opts, d)).toEqual({ port: 5000, token: 'tok' });
    expect(d.spawnServer).not.toHaveBeenCalled();
  });

  it('spawns a detached server when there is no lock, then waits for it', async () => {
    let started = false;
    const d = deps({
      readLock: async () => (started ? lock({ port: 6000, token: 'new' }) : null),
      spawnServer: vi.fn(() => void (started = true)),
    });
    expect(await ensureServer(opts, d)).toEqual({ port: 6000, token: 'new' });
    expect(d.spawnServer).toHaveBeenCalledWith(['/p/server.mjs', '--lock', '--idle-minutes', '30', '--web-dir', '/p/web'], { ORCA_CLI: '/o/orca' });
  });

  it('replaces a stale lock (server gone)', async () => {
    let started = false;
    const d = deps({
      readLock: async () => (started ? lock({ port: 7000 }) : lock({ port: 1 })),
      isAlive: async (l) => l.port !== 1,
      spawnServer: vi.fn(() => void (started = true)),
    });
    expect((await ensureServer(opts, d)).port).toBe(7000);
    expect(d.spawnServer).toHaveBeenCalledTimes(1);
  });

  it('gives up after the timeout', async () => {
    const d = deps({ isAlive: async () => false, readLock: async () => lock() });
    await expect(ensureServer(opts, d)).rejects.toThrow('server_start_timeout');
  });
});
