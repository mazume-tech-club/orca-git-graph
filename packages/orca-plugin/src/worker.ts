/**
 * Plugin worker entry (runs in Orca's plugin worker process; bundled to `worker.mjs`).
 * It only launches; the HTTP server lives in its own process (see server-process.ts).
 *
 * EXPERIMENTAL API: Orca's plugin API v0 may change. What this relies on:
 *   - `export default async function activate(ctx)` with `ctx.commands.register`, `ctx.host.call`, `ctx.log`
 *   - host methods `workspace.readContext` (capability `workspace:read`) and `notifications.show` (`notifications:show`)
 *   - the worker may spawn processes (not guaranteed; see server-process.ts)
 * Checked against Orca 1.4.220 (src/shared/plugins/*).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countUiClients, resolveOrcaCli, type WorkspaceContext } from '@orca-git-graph/platform';
import { openGitGraph, realOrca } from './launcher.js';
import { ensureServer } from './server-process.js';
import { writeLauncherStub } from './launcher-stub.js';
import { fileWorktreeCache } from './worktree-cache.js';

interface PluginContext {
  commands: { register(id: string, handler: (args?: unknown) => unknown): void };
  host: { call(method: string, params?: unknown): Promise<unknown> };
  log(message: string): void;
}

const here = dirname(fileURLToPath(import.meta.url));

export default async function activate(ctx: PluginContext): Promise<void> {
  // lets the sidebar panel start the graph without knowing where this plugin is installed (see launcher-stub.ts)
  // (only from the built plugin: when run from source there is no open.mjs next to this file, and a stub pointing
  // at a path that does not exist would break the button)
  const openFile = join(here, 'open.mjs');
  if (existsSync(openFile)) void writeLauncherStub(openFile).catch((e: unknown) => ctx.log(`could not write the launcher stub: ${String(e)}`));

  ctx.commands.register('open-git-graph', async () => {
    const result = await openGitGraph({
      readContext: async () => (await ctx.host.call('workspace.readContext')) as WorkspaceContext | null,
      notify: async (title, body) => {
        await ctx.host.call('notifications.show', body ? { title, body: body.slice(0, 1000) } : { title });
      },
      resolveOrcaCli: () => resolveOrcaCli(),
      ensureServer: (orcaCli) =>
        ensureServer({
          serverEntry: join(here, 'server.mjs'),
          webDir: join(here, 'web'),
          orcaCli,
          idleMinutes: 30,
          startTimeoutMs: 15_000,
        }),
      hasOpenTab: async (server, id) => {
        const n = await countUiClients(server, id);
        return n === null ? null : n > 0;
      },
      orca: realOrca,
      cache: fileWorktreeCache(),
      log: (m) => ctx.log(m),
    });
    return result;
  });
}
