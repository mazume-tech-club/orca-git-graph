import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LogResponse, RepoInfo } from '@orca-git-graph/core';
import { startServer, type RunningServer } from './server.js';
import { buildLargeRepo } from '../../../scripts/make-large-repo.mjs';
import { sh, tempDir, write, type Fixture } from './testutil.js';

let fx: Fixture;
let srv: RunningServer;
let id: string;
const base = () => `http://127.0.0.1:${srv.port}`;
const q = (extra = '') => `repo=${encodeURIComponent(id)}&token=${srv.token}${extra}`;

beforeAll(async () => {
  fx = tempDir('perf');
  buildLargeRepo(fx.dir, 10_000);
  srv = await startServer({ repos: [fx.dir] });
  id = srv.repos[0]!.id;
}, 180_000);

afterAll(async () => {
  await srv.close();
  fx.cleanup();
});

describe('10k commits', () => {
  it('serves the first page well within 2 seconds (cold)', async () => {
    const t0 = performance.now();
    const [info, log] = await Promise.all([
      fetch(`${base()}/api/repo?${q()}`).then((r) => r.json() as Promise<RepoInfo>),
      fetch(`${base()}/api/log?${q('&limit=300')}`).then((r) => r.json() as Promise<LogResponse>),
    ]);
    const ms = performance.now() - t0;
    expect(info.refs.length).toBeGreaterThan(0);
    expect(log.items).toHaveLength(300);
    expect(log.nextCursor).toBe(300);
    console.log(`first page (repo + 300 rows): ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(2000);
  });

  it('pages through the whole history and finishes with a total', async () => {
    let cursor: number | null = 0;
    let n = 0;
    const t0 = performance.now();
    while (cursor !== null) {
      const page = (await (await fetch(`${base()}/api/log?${q(`&limit=2000&cursor=${cursor}`)}`)).json()) as LogResponse;
      n += page.items.length;
      cursor = page.nextCursor;
      if (cursor === null) expect(page.total).toBe(n);
    }
    console.log(`all pages: ${(performance.now() - t0).toFixed(0)} ms`);
    expect(n).toBe(10_000 + 1000);
  });

  it('searches the whole history', async () => {
    const t0 = performance.now();
    const res = (await (await fetch(`${base()}/api/search?${q('&q=commit%205000%3A')}`)).json()) as { indices: number[] };
    console.log(`search: ${(performance.now() - t0).toFixed(0)} ms`);
    expect(res.indices.length).toBeGreaterThanOrEqual(1);
  });
});

describe('auto refresh (SSE)', () => {
  it('emits a refs event when a branch is created, and a status event when files change', async () => {
    const res = await fetch(`${base()}/api/events?${q()}`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const seen: string[] = [];
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        for (const m of dec.decode(value).matchAll(/"type":"(\w+)"/g)) seen.push(m[1]!);
      }
    })();
    const waitFor = async (type: string, ms: number) => {
      const t0 = Date.now();
      while (!seen.includes(type)) {
        if (Date.now() - t0 > ms) throw new Error(`no ${type} event; saw ${seen.join(',')}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await waitFor('ping', 3000);
    await new Promise((r) => setTimeout(r, 500)); // let the watcher finish starting
    sh(fx.dir, ['branch', 'watch-me']);
    await waitFor('refs', 5000);
    write(fx.dir, 'file1.txt', 'edited\n');
    await waitFor('status', 10_000);
    await reader.cancel();
    await pump.catch(() => undefined);
    // the cached state must have been invalidated by the watcher
    const info = (await (await fetch(`${base()}/api/repo?${q()}`)).json()) as RepoInfo;
    expect(info.refs.some((r) => r.name === 'watch-me')).toBe(true);
  });
});
