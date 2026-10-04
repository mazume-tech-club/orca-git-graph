import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { API_VERSION } from '@orca-git-graph/platform';
import type { ApiErrorBody, FetchResponse } from '@orca-git-graph/core';
import { GitError } from './git.js';
import { HttpError, type LogScope } from './repo.js';
import type { RepoRegistry } from './registry.js';
import { staticHandler } from './static.js';

export interface AppOptions {
  token: string;
  registry: RepoRegistry;
  /** Directory with the built web UI; omitted when the UI is served by Vite in dev */
  webDir?: string;
  /** Host header values accepted (DNS-rebinding defence). Evaluated per request because the port is known only after listen. */
  allowedHosts: () => string[];
  /** Called on every API request / SSE connection change so the server can exit when idle */
  onActivity: () => void;
  onSseCount: (delta: number) => void;
}

function tokenEquals(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function intParam(v: string | undefined, def: number, min: number, max: number): number {
  const n = v === undefined || v === '' ? def : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'bad_param', `invalid number: ${v}`);
  return n;
}

function parseScope(refsParam: string | undefined, typesParam?: string): LogScope {
  if (typesParam !== undefined && typesParam !== '') {
    const types = typesParam.split(',').filter(Boolean);
    if (!types.every((t): t is 'local' | 'remote' | 'tag' => t === 'local' || t === 'remote' || t === 'tag')) {
      throw new HttpError(400, 'bad_param', 'invalid types');
    }
    return { kind: 'types', types };
  }
  if (refsParam === undefined || refsParam === '') return { kind: 'all' };
  const refs = refsParam.split(',').filter(Boolean);
  if (refs.length > 2000) throw new HttpError(400, 'bad_param', 'too many refs');
  return { kind: 'refs', refs };
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  // open UI pages per repository (live-update connections); lets the Orca launcher know whether a tab is already open
  const uiClients = new Map<string, number>();

  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!opts.allowedHosts().includes(host.toLowerCase())) return c.json<ApiErrorBody>({ error: { code: 'bad_host', message: 'unexpected Host header' } }, 403);
    await next();
  });

  app.use('/api/*', async (c, next) => {
    const given = c.req.header('x-orca-git-graph-token') ?? c.req.query('token');
    if (!tokenEquals(given, opts.token)) {
      return c.json<ApiErrorBody>({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    }
    opts.onActivity();
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json<ApiErrorBody>({ error: { code: err.code, message: err.message } }, err.status as 400);
    }
    if (err instanceof GitError) {
      return c.json<ApiErrorBody>({ error: { code: 'git_failed', message: err.message } }, 500);
    }
    console.error(err);
    return c.json<ApiErrorBody>({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  const repoOf = async (repoParam: string | undefined) => {
    const id = repoParam || opts.registry.defaultId();
    if (!id) throw new HttpError(400, 'repo_required', 'repo parameter is required');
    return opts.registry.get(id);
  };

  app.get('/api/health', (c) => c.json({ ok: true, apiVersion: API_VERSION, pid: process.pid }));

  app.get('/api/repos', (c) => c.json({ repos: opts.registry.list(), defaultId: opts.registry.defaultId() }));

  app.get('/api/repo', async (c) => {
    const h = await repoOf(c.req.query('repo'));
    return c.json(await h.repo.info(h.id));
  });

  app.get('/api/log', async (c) => {
    const h = await repoOf(c.req.query('repo'));
    const cursor = intParam(c.req.query('cursor'), 0, 0, 10_000_000);
    const limit = intParam(c.req.query('limit'), 500, 1, 2000);
    return c.json(await h.repo.getLog(parseScope(c.req.query('refs'), c.req.query('types')), cursor, limit, c.req.query('rev')));
  });

  app.get('/api/search', async (c) => {
    const h = await repoOf(c.req.query('repo'));
    return c.json(await h.repo.search(parseScope(c.req.query('refs'), c.req.query('types')), c.req.query('q') ?? '', c.req.query('rev')));
  });

  app.get('/api/commit/:sha', async (c) => {
    const h = await repoOf(c.req.query('repo'));
    return c.json(await h.repo.commitDetail(c.req.param('sha')));
  });

  app.get('/api/compare', async (c) => {
    const h = await repoOf(c.req.query('repo'));
    const a = c.req.query('a');
    const b = c.req.query('b');
    if (!a || !b) throw new HttpError(400, 'bad_param', 'a and b are required');
    return c.json(await h.repo.compare(a, b));
  });

  const modeOf = (v: string | undefined): 'three-dot' | 'two-dot' => {
    if (v === undefined || v === 'three-dot') return 'three-dot';
    if (v === 'two-dot') return 'two-dot';
    throw new HttpError(400, 'bad_param', 'mode must be three-dot or two-dot');
  };

  app.get('/api/diff/files', async (c) => {
    const h = await repoOf(c.req.query('repo'));
    const b = c.req.query('b');
    if (!b) throw new HttpError(400, 'bad_param', 'b is required');
    return c.json(await h.repo.diffFiles(c.req.query('a') ?? null, b, modeOf(c.req.query('mode'))));
  });

  app.get('/api/diff/file', async (c) => {
    const h = await repoOf(c.req.query('repo'));
    const b = c.req.query('b');
    const path = c.req.query('path');
    if (!b || !path) throw new HttpError(400, 'bad_param', 'b and path are required');
    return c.json(await h.repo.diffFile(c.req.query('a') ?? null, b, modeOf(c.req.query('mode')), path, c.req.query('oldPath')));
  });

  app.get('/api/worktree/files', async (c) => {
    const h = await repoOf(c.req.query('repo'));
    return c.json({ files: await h.repo.worktreeFiles() });
  });

  app.get('/api/worktree/diff', async (c) => {
    const h = await repoOf(c.req.query('repo'));
    const path = c.req.query('path');
    if (!path) throw new HttpError(400, 'bad_param', 'path is required');
    return c.json(await h.repo.worktreeDiff(path, c.req.query('oldPath')));
  });

  // The only operation that touches the repository, and only on an explicit UI action (POST).
  app.post('/api/fetch', async (c) => {
    const h = await repoOf(c.req.query('repo'));
    try {
      const output = await h.repo.fetch();
      return c.json<FetchResponse>({ ok: true, output });
    } catch (e) {
      if (e instanceof GitError) return c.json<FetchResponse>({ ok: false, output: e.stderr.trim() || e.message });
      throw e;
    }
  });

  app.get('/api/clients', (c) => c.json({ count: uiClients.get(c.req.query('repo') ?? '') ?? 0 }));

  app.get('/api/events', async (c) => {
    const h = await repoOf(c.req.query('repo'));
    return streamSSE(c, async (stream) => {
      opts.onSseCount(1);
      uiClients.set(h.id, (uiClients.get(h.id) ?? 0) + 1);
      const unsubscribe = h.watcher.subscribe((type) => {
        void stream.writeSSE({ data: JSON.stringify({ type }) }).catch(() => undefined);
      });
      // The connection is released the moment the client goes away (not after the next ping), because the
      // client count tells the Orca launcher whether a tab is still open.
      let open = true;
      let wake: () => void = () => undefined;
      const release = () => {
        if (!open) return;
        open = false;
        unsubscribe();
        uiClients.set(h.id, Math.max(0, (uiClients.get(h.id) ?? 1) - 1));
        opts.onSseCount(-1);
        wake();
      };
      stream.onAbort(release);
      await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) });
      while (open) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 20_000);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        if (!open) break;
        opts.onActivity();
        await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }).catch(release);
      }
      release();
    });
  });

  if (opts.webDir) app.get('*', staticHandler(opts.webDir));

  return app;
}
