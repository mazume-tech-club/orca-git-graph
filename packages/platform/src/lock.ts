import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './paths.js';

export interface LockInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
  /** Bumped when the server's API changes incompatibly, so an old server is replaced */
  apiVersion: number;
}

export const API_VERSION = 1;

export function lockPath(): string {
  return join(dataDir(), 'server.lock.json');
}

/**
 * The lock file holds the server token, so it must not be readable by other users.
 * POSIX: dir 0700 / file 0600. Windows: the directory lives under %LOCALAPPDATA%, whose ACL is
 * inherited from the user profile (the user, SYSTEM and Administrators only); `mode` is ignored there.
 */
export async function writeLock(info: LockInfo): Promise<void> {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  await writeFile(lockPath(), JSON.stringify(info), { mode: 0o600 });
}

export async function readLock(): Promise<LockInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath(), 'utf8')) as Partial<LockInfo>;
    if (
      typeof parsed.port === 'number' &&
      typeof parsed.token === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.apiVersion === 'number'
    ) {
      return parsed as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

export async function removeLock(onlyIfPid?: number): Promise<void> {
  if (onlyIfPid !== undefined) {
    const cur = await readLock();
    if (cur && cur.pid !== onlyIfPid) return;
  }
  await rm(lockPath(), { force: true });
}

/** Ask a server from the lock file whether it is alive and compatible. */
export async function isServerAlive(lock: LockInfo, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/health?token=${encodeURIComponent(lock.token)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; apiVersion?: number };
    return body.ok === true && body.apiVersion === API_VERSION;
  } catch {
    return false;
  }
}

/**
 * How many Git Graph pages are connected to the server for this repository id (a page keeps a live-update
 * connection open while it is loaded). `null` when the server could not be asked.
 */
export async function countUiClients(server: { port: number; token: string }, repoId: string, timeoutMs = 800): Promise<number | null> {
  try {
    const q = new URLSearchParams({ repo: repoId, token: server.token });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/clients?${q}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { count?: number };
    return typeof body.count === 'number' ? body.count : null;
  } catch {
    return null;
  }
}
