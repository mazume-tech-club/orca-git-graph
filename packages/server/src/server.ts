import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { RepoSummary } from '@orca-git-graph/core';
import {
  API_VERSION,
  isServerAlive,
  listWorktrees,
  loadIdentity,
  readLock,
  removeLock,
  resolveOrcaCli,
  saveIdentity,
  writeLock,
  type LockInfo,
} from '@orca-git-graph/platform';
import { createApp } from './app.js';
import { RepoRegistry, type WorktreeProvider } from './registry.js';

/** Loopback only. Never `0.0.0.0` / `::`: the API can read every registered repository. */
export const HOST = '127.0.0.1';

export interface ServerOptions {
  /** Repositories to allow (`--repo`) */
  repos: string[];
  /** 0 = pick a free port */
  port?: number;
  /** Fixed token (dev only); random per start otherwise */
  token?: string;
  webDir?: string;
  /** Exit after this many ms without requests (0 = never) */
  idleTimeoutMs?: number;
  /** Also allow the worktrees Orca reports via `orca worktree ps` */
  orca?: boolean;
  orcaCliSetting?: string | null;
  /** Publish port/token in the user's data dir so the Orca plugin can find this server */
  writeLockFile?: boolean;
  /** For tests */
  worktreeProvider?: WorktreeProvider;
}

export interface RunningServer {
  port: number;
  token: string;
  repos: RepoSummary[];
  close(): Promise<void>;
  /** Resolves when the server stopped by itself (idle) or via close() */
  closed: Promise<void>;
}

export class AlreadyRunningError extends Error {
  constructor(readonly lock: LockInfo) {
    super(`a server is already running on port ${lock.port}`);
  }
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  if (opts.writeLockFile) {
    const existing = await readLock();
    if (existing && (await isServerAlive(existing))) throw new AlreadyRunningError(existing);
  }

  // Launched by the Orca plugin (lock mode): keep token and port across restarts so an open tab stays valid.
  // Standalone runs get a fresh random token every time.
  const identity = opts.writeLockFile && !opts.token ? await loadIdentity() : null;
  const token = opts.token ?? identity?.token ?? randomBytes(24).toString('base64url');
  const preferredPort = opts.port || identity?.port || 0; // 0 / unset = no explicit choice
  let provider: WorktreeProvider | null = opts.worktreeProvider ?? null;
  if (!provider && opts.orca) {
    const cli = resolveOrcaCli(opts.orcaCliSetting);
    if (cli) provider = () => listWorktrees(cli);
  }
  const registry = new RepoRegistry(provider);
  for (const r of opts.repos) registry.addPath(r);
  // fail fast on a bad --repo (also resolves symlinks / subdirectories to the toplevel)
  for (const r of registry.list()) await registry.get(r.id);

  let port = 0;
  let lastActivity = Date.now();
  let sseClients = 0;
  const app = createApp({
    token,
    registry,
    webDir: opts.webDir,
    allowedHosts: () => [`127.0.0.1:${port}`, `localhost:${port}`],
    onActivity: () => {
      lastActivity = Date.now();
    },
    onSseCount: (d) => {
      sseClients += d;
      lastActivity = Date.now();
    },
  });

  const listen = (wanted: number) =>
    new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: wanted, hostname: HOST }, () => resolve(s));
      s.once('error', reject);
    });
  let server: ReturnType<typeof serve>;
  try {
    server = await listen(preferredPort);
  } catch (e) {
    // the remembered port is taken by something else: any free port will do (open tabs then need a new URL)
    if (preferredPort === 0 || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    server = await listen(0);
  }
  port = (server.address() as AddressInfo).port;
  if (identity) await saveIdentity({ token: identity.token, port }).catch(() => undefined);

  if (opts.writeLockFile) {
    await writeLock({ port, token, pid: process.pid, startedAt: Date.now(), apiVersion: API_VERSION });
  }

  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  let closing = false;
  let idleTimer: NodeJS.Timeout | undefined;

  const close = async () => {
    if (closing) return closed;
    closing = true;
    clearInterval(idleTimer);
    if (opts.writeLockFile) await removeLock(process.pid);
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    resolveClosed();
    return closed;
  };

  if (opts.idleTimeoutMs && opts.idleTimeoutMs > 0) {
    const timeout = opts.idleTimeoutMs;
    idleTimer = setInterval(() => {
      if (sseClients <= 0 && Date.now() - lastActivity > timeout) void close();
    }, Math.min(30_000, Math.max(1000, timeout / 4)));
    idleTimer.unref();
  }

  return { port, token, repos: registry.list(), close, closed };
}
