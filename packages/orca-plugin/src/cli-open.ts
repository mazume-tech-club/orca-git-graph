/**
 * `node open.mjs` — open Git Graph for the worktree of the current directory, from a terminal inside Orca.
 *
 * Why this exists: Orca's plugin API has no way to put a button in the UI and plugin shortcuts do not fire while a
 * terminal has focus. Orca's "Quick Commands" menu (saved terminal commands) can run this with one click instead.
 * Unlike the plugin worker, a shell has a working directory, so `orca worktree current` identifies the worktree
 * exactly (no name/terminal matching).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentWorktreeId, listWorktrees, resolveOrcaCli } from '@orca-git-graph/platform';
import { openWorktree, realOrca } from './launcher.js';
import { ensureServer } from './server-process.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<number> {
  const cli = resolveOrcaCli();
  if (!cli) {
    console.error('Orca CLI not found. Set the ORCA_CLI environment variable to the path of the orca executable.');
    return 1;
  }
  const id = await currentWorktreeId(cli).catch(() => null);
  if (!id) {
    console.error('This directory is not inside an Orca worktree.');
    return 1;
  }
  const wt = (await listWorktrees(cli)).find((w) => w.id === id);
  if (!wt) {
    console.error(`Orca does not list the worktree ${id}.`);
    return 1;
  }

  const result = await openWorktree(
    {
      readContext: async () => null,
      // there is no desktop notification here: errors go to the terminal
      notify: async (title, body) => {
        console.error(body ? `${title}\n${body}` : title);
      },
      resolveOrcaCli: () => cli,
      ensureServer: (orcaCli) =>
        ensureServer({ serverEntry: join(here, 'server.mjs'), webDir: join(here, 'web'), orcaCli, idleMinutes: 30, startTimeoutMs: 15_000 }),
      orca: realOrca,
      log: () => undefined,
    },
    cli,
    wt,
  );
  if (result.ok) console.log(`Git Graph: ${result.action} (${wt.displayName})`);
  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
