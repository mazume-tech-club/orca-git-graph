/**
 * Starts (or reuses) the Git Graph HTTP server as a separate, detached process.
 *
 * The plugin worker is stopped by Orca after ~60 s idle, so the server must not live inside it.
 * Spawning processes from a worker is current behaviour, not an API guarantee (Orca may later gate it behind
 * a `process:exec` capability); this file and `@orca-git-graph/platform`'s orca.ts are the only places
 * that spawn anything, so a replacement stays local.
 */
import { spawn } from 'node:child_process';
import { cliEnv, isServerAlive, readLock, type LockInfo } from '@orca-git-graph/platform';

export interface ServerProcessDeps {
  readLock: () => Promise<LockInfo | null>;
  isAlive: (lock: LockInfo) => Promise<boolean>;
  spawnServer: (args: string[], env: Record<string, string>) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface EnsureServerOptions {
  serverEntry: string;
  webDir: string;
  orcaCli: string | null;
  idleMinutes: number;
  startTimeoutMs: number;
}

export const realDeps: ServerProcessDeps = {
  readLock,
  isAlive: (l) => isServerAlive(l),
  spawnServer: (args, env) => {
    // Inside Orca, `process.execPath` is the Orca (Electron) binary: `ELECTRON_RUN_AS_NODE` makes it
    // behave as plain Node, so users do not need Node installed. Verified on Orca 1.4.220 / Windows.
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // the worker's own environment is minimal: complete it so the server (and the orca CLI it runs) can find user data
      env: { ...cliEnv(), ...env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    });
    child.unref();
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export async function ensureServer(opts: EnsureServerOptions, deps: ServerProcessDeps = realDeps): Promise<{ port: number; token: string }> {
  const existing = await deps.readLock();
  if (existing && (await deps.isAlive(existing))) return { port: existing.port, token: existing.token };

  const args = [opts.serverEntry, '--lock', '--idle-minutes', String(opts.idleMinutes), '--web-dir', opts.webDir];
  deps.spawnServer(args, opts.orcaCli ? { ORCA_CLI: opts.orcaCli } : {});

  const deadline = deps.now() + opts.startTimeoutMs;
  while (deps.now() < deadline) {
    await deps.sleep(150);
    const lock = await deps.readLock();
    if (lock && (await deps.isAlive(lock))) return { port: lock.port, token: lock.token };
  }
  throw new Error('server_start_timeout');
}
