import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './paths.js';

/**
 * Token and port that the Orca-launched server keeps across restarts, so a Git Graph tab that is already open
 * (or restored by Orca) keeps working when the server has to be started again. Standalone runs still use a fresh
 * random token every time.
 *
 * The token is as secret as the lock file, so it is stored the same way: user data dir, mode 0600 (on Windows the
 * directory inherits the user-profile ACL).
 */
export interface Identity {
  token: string;
  /** Port of the previous run, tried first on the next start (`null` before the first run) */
  port: number | null;
}

export function identityPath(): string {
  return join(dataDir(), 'identity.json');
}

export async function loadIdentity(): Promise<Identity> {
  try {
    const v = JSON.parse(await readFile(identityPath(), 'utf8')) as Partial<Identity>;
    if (typeof v.token === 'string' && v.token.length >= 24) {
      return { token: v.token, port: typeof v.port === 'number' ? v.port : null };
    }
  } catch {
    /* missing or corrupt: create a new one */
  }
  const fresh: Identity = { token: randomBytes(24).toString('base64url'), port: null };
  await saveIdentity(fresh);
  return fresh;
}

export async function saveIdentity(identity: Identity): Promise<void> {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const tmp = `${identityPath()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(identity), { mode: 0o600 });
  await rename(tmp, identityPath());
}
