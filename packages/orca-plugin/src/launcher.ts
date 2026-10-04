/**
 * What "Open Git Graph" does, with every side effect injected so it can be tested without Orca.
 *
 *   1. workspace.readContext        → which worktree has focus (displayName / branch / terminals)
 *   2. orca worktree ps / terminal list → exact worktree id + path (remembered, see below)
 *   3. ensure the server is running → port + token (lock file)
 *   4. open (or re-use) a browser tab in that worktree
 *
 * Findings from the spike (Orca 1.4.220):
 *  - command handlers receive NO arguments, even with `context: "worktree"`; the focused worktree can
 *    only be learned from `workspace.readContext`, which has no id, hence the matching in step 2;
 *  - `orca tab create` always opens a new tab, so existing tabs are looked up and re-used;
 *  - `--worktree active|current` resolve from the shell's cwd and fail inside a worker, so explicit `id:` selectors are used.
 *
 * Latency (every `orca` CLI call costs ~0.3 s; measured on Windows):
 *  - every browser-tab command except `tab create` (list / switch / show / current) takes ~8.4 s when the worktree
 *    has NO browser tab open (Orca waits for its browser bridge). So the tab list is only requested when our own
 *    server says a Git Graph page is currently connected for the worktree;
 *  - the server does not depend on the worktree, so it is started while the worktree is being identified;
 *  - the answer of step 2 is remembered (keyed by the focused workspace's terminal ids) and re-validated implicitly.
 */
import {
  createTab,
  listTabs,
  listTerminals,
  listWorktrees,
  matchWorktree,
  navigateTab,
  switchTab,
  type OrcaTab,
  type OrcaTerminal,
  type OrcaWorktree,
  type WorkspaceContext,
} from '@orca-git-graph/platform';

export interface ServerInfo {
  port: number;
  token: string;
}

export interface LauncherDeps {
  readContext: () => Promise<WorkspaceContext | null>;
  notify: (title: string, body?: string) => Promise<void>;
  resolveOrcaCli: () => string | null;
  ensureServer: (orcaCli: string) => Promise<ServerInfo>;
  /** Is a Git Graph page for this worktree connected to the server right now? `null` = unknown. */
  hasOpenTab?: (server: ServerInfo, worktreeId: string) => Promise<boolean | null>;
  orca: {
    listWorktrees: (cli: string) => Promise<OrcaWorktree[]>;
    listTerminals: (cli: string) => Promise<OrcaTerminal[]>;
    listTabs: (cli: string, worktreeId: string) => Promise<OrcaTab[]>;
    createTab: (cli: string, worktreeId: string, url: string) => Promise<string>;
    switchTab: (cli: string, worktreeId: string, pageId: string) => Promise<void>;
    navigateTab: (cli: string, worktreeId: string, pageId: string, url: string) => Promise<void>;
  };
  /** Remembers which worktree a focused-workspace fingerprint resolved to, to skip two CLI calls next time */
  cache?: WorktreeCache;
  log: (message: string) => void;
}

export interface WorktreeCache {
  get: (key: string) => Promise<OrcaWorktree | null>;
  set: (key: string, wt: OrcaWorktree) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

/**
 * Fingerprint of the focused workspace. Terminal ids are unique per terminal session, so a non-empty list makes
 * the key specific; without terminals there is nothing reliable to key on and the cache is not used.
 */
export function cacheKey(ctx: WorkspaceContext): string | null {
  if (ctx.terminals.length === 0) return null;
  return `${ctx.displayName}|${ctx.branch}|${ctx.terminals.map((t) => t.id).sort().join(',')}`;
}

type FailReason = 'no-cli' | 'no-context' | 'no-match' | 'ambiguous' | 'remote' | 'not-git' | 'server' | 'orca';

export type OpenResult =
  | { ok: true; action: 'created' | 'switched' | 'navigated'; url: string }
  | { ok: false; reason: FailReason; message: string };

export const realOrca: LauncherDeps['orca'] = { listWorktrees, listTerminals, listTabs, createTab, switchTab, navigateTab };

export function buildUrl(port: number, token: string, worktreeId: string): string {
  return `http://127.0.0.1:${port}/?repo=${encodeURIComponent(worktreeId)}&token=${encodeURIComponent(token)}`;
}

/** An existing tab of ours for this worktree: any loopback URL carrying this `repo` id and a token. */
export function findExistingTab(tabs: readonly OrcaTab[], worktreeId: string): OrcaTab | undefined {
  return tabs.find((t) => {
    try {
      const u = new URL(t.url);
      return u.hostname === '127.0.0.1' && u.searchParams.get('repo') === worktreeId && u.searchParams.has('token');
    } catch {
      return false;
    }
  });
}

function makeFail(d: LauncherDeps) {
  return async (reason: FailReason, message: string, body?: string): Promise<OpenResult> => {
    d.log(`open-git-graph failed (${reason}): ${message}${body ? ` — ${body.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`);
    await d.notify(message, body).catch(() => undefined);
    return { ok: false, reason, message };
  };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function openGitGraph(d: LauncherDeps): Promise<OpenResult> {
  const fail = makeFail(d);

  const cli = d.resolveOrcaCli();
  if (!cli) {
    return fail('no-cli', 'Orca CLI が見つかりません / Orca CLI not found', 'ORCA_CLI 環境変数で orca の場所を指定してください。');
  }

  const t0 = Date.now();
  const marks: string[] = [];
  const mark = (name: string) => marks.push(`${name} ${Date.now() - t0}ms`);

  const server = d.ensureServer(cli).then((r) => (mark('server-ready'), r));
  server.catch(() => undefined); // the failure is reported where the result is awaited

  const ctx = await d.readContext();
  mark('context');
  if (!ctx) return fail('no-context', 'フォーカス中のワークツリーがありません / No focused worktree');

  const key = cacheKey(ctx);
  const finish = (r: OpenResult) => {
    mark('done');
    d.log(`open-git-graph: ${r.ok ? r.action : 'failed'} — ${marks.join(', ')}`);
    return r;
  };

  // 1) a remembered worktree: no `worktree ps` / `terminal list`. If Orca rejects it (worktree gone), fall through.
  const remembered = key && d.cache ? await d.cache.get(key).catch(() => null) : null;
  if (remembered) {
    mark('worktree(cached)');
    const r = await openWorktree(d, cli, remembered, { server, quietOrcaFailure: true });
    if (r.ok || r.reason !== 'orca') return finish(r);
    await d.cache?.delete(key!).catch(() => undefined);
    mark('cache-miss');
  }

  // 2) identify the worktree
  let worktrees: OrcaWorktree[];
  let terminals: OrcaTerminal[];
  try {
    [worktrees, terminals] = await Promise.all([d.orca.listWorktrees(cli), d.orca.listTerminals(cli)]);
  } catch (e) {
    return fail('orca', 'Orca CLI の実行に失敗しました / Orca CLI failed', errText(e));
  }
  mark('worktree');

  const match = matchWorktree(ctx, worktrees, terminals);
  if (match.kind === 'none') return fail('no-match', 'ワークツリーを特定できませんでした / Could not identify the worktree', ctx.displayName);
  if (match.kind === 'ambiguous') {
    return fail('ambiguous', '同名のワークツリーが複数あります / Several worktrees share this name', match.candidates.map((c) => c.path).join('\n'));
  }
  if (key) await d.cache?.set(key, match.worktree).catch(() => undefined);
  return finish(await openWorktree(d, cli, match.worktree, { server }));
}

/** Open (or re-use) the Git Graph tab for a known worktree. Shared by the plugin command and the CLI. */
export async function openWorktree(
  d: LauncherDeps,
  cli: string,
  wt: OrcaWorktree,
  pre: { server?: Promise<ServerInfo>; /** report Orca CLI failures as `reason: 'orca'` without notifying (caller retries) */ quietOrcaFailure?: boolean } = {},
): Promise<OpenResult> {
  const fail = makeFail(d);
  if (wt.hostId !== 'local') {
    return fail('remote', 'リモートのワークツリーは未対応です / Remote worktrees are not supported', 'Git Graph はローカルのワークツリーのみ対応しています。');
  }
  if (wt.kind !== 'git') return fail('not-git', 'Git リポジトリではありません / Not a git repository', wt.path);

  let server: ServerInfo;
  try {
    server = await (pre.server ?? d.ensureServer(cli));
  } catch (e) {
    return fail('server', 'Git Graph サーバーを起動できませんでした / Could not start the Git Graph server', errText(e));
  }

  const url = buildUrl(server.port, server.token, wt.id);
  try {
    // Only ask Orca for the tab list when a page is known to be open: with no browser tab, `tab list` takes ~8 s.
    const open = d.hasOpenTab ? await d.hasOpenTab(server, wt.id).catch(() => null) : null;
    if (open !== false) {
      const existing = findExistingTab(await d.orca.listTabs(cli, wt.id), wt.id);
      if (existing) {
        await d.orca.switchTab(cli, wt.id, existing.browserPageId);
        // a tab that shows a load error (its server was gone) is reloaded even though the URL is the same
        if (existing.url === url && !existing.loadError) return { ok: true, action: 'switched', url };
        // the server restarted since this tab was opened: point it at the new port / token
        await d.orca.navigateTab(cli, wt.id, existing.browserPageId, url);
        return { ok: true, action: 'navigated', url };
      }
    }
    await d.orca.createTab(cli, wt.id, url);
    return { ok: true, action: 'created', url };
  } catch (e) {
    if (pre.quietOrcaFailure) return { ok: false, reason: 'orca', message: errText(e) };
    return fail('orca', 'タブを開けませんでした / Could not open the tab', errText(e));
  }
}
