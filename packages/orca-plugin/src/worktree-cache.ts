import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dataDir, type OrcaWorktree } from '@orca-git-graph/platform';
import type { WorktreeCache } from './launcher.js';

const MAX_ENTRIES = 50;

/**
 * Small JSON file in the user data dir (private to the user, like the lock file). The plugin worker is stopped
 * by Orca after ~60 s idle, so the cache has to live on disk to help the next invocation.
 */
export function fileWorktreeCache(file = join(dataDir(), 'worktree-cache.json')): WorktreeCache {
  const read = async (): Promise<Record<string, OrcaWorktree>> => {
    try {
      const v = JSON.parse(await readFile(file, 'utf8')) as unknown;
      return v && typeof v === 'object' ? (v as Record<string, OrcaWorktree>) : {};
    } catch {
      return {};
    }
  };
  const write = async (data: Record<string, OrcaWorktree>) => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await rename(tmp, file);
  };
  return {
    get: async (key) => (await read())[key] ?? null,
    set: async (key, wt) => {
      const data = await read();
      delete data[key];
      data[key] = wt;
      const keys = Object.keys(data);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete data[k];
      await write(data);
    },
    delete: async (key) => {
      const data = await read();
      if (key in data) {
        delete data[key];
        await write(data);
      }
    },
  };
}
