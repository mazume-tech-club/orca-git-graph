/**
 * What "Open Git Graph" does, with every side effect injected so it can be tested without Orca.
 *
 *   1. workspace.readContext        → which worktree has focus (displayName / branch / terminals)
 *   2. orca worktree ps / terminal list → exact worktree id + path
 *   3. ensure the server is running → port + token (lock file)
 *   4. open (or re-use) a browser tab in that worktree
 *
 * Findings from the Phase 0 spike (Orca 1.4.220):
 *  - command handlers receive NO arguments, even with `context: "worktree"`; the focused worktree can
 *    only be learned from `workspace.readContext`, which has no id, hence the matching in step 2;
 *  - `orca tab create` always opens a new tab, so existing tabs are looked up and re-used;
 *  - `--worktree active|current` resolve from the shell's cwd and fail inside a worker, so explicit `id:` selectors are used.
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

export interface LauncherDeps {
  readContext: () => Promise<WorkspaceContext | null>;
  notify: (title: string, body?: string) => Promise<void>;
  resolveOrcaCli: () => string | null;
  ensureServer: (orcaCli: string) => Promise<{ port: number; token: string }>;
  orca: {
    listWorktrees: (cli: string) => Promise<OrcaWorktree[]>;
    listTerminals: (cli: string) => Promise<OrcaTerminal[]>;
    listTabs: (cli: string, worktreeId: string) => Promise<OrcaTab[]>;
    createTab: (cli: string, worktreeId: string, url: string) => Promise<string>;
    switchTab: (cli: string, worktreeId: string, pageId: string) => Promise<void>;
    navigateTab: (cli: string, worktreeId: string, pageId: string, url: string) => Promise<void>;
  };
  log: (message: string) => void;
}

export type OpenResult =
  | { ok: true; action: 'created' | 'switched' | 'navigated'; url: string }
  | { ok: false; reason: 'no-cli' | 'no-context' | 'no-match' | 'ambiguous' | 'remote' | 'not-git' | 'server' | 'orca'; message: string };

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

type Failure = Extract<OpenResult, { ok: false }>;

function makeFail(d: LauncherDeps) {
  return async (reason: Failure['reason'], message: string, body?: string): Promise<OpenResult> => {
    d.log(`open-git-graph failed (${reason}): ${message}`);
    await d.notify(message, body).catch(() => undefined);
    return { ok: false, reason, message };
  };
}

export async function openGitGraph(d: LauncherDeps): Promise<OpenResult> {
  const fail = makeFail(d);

  const cli = d.resolveOrcaCli();
  if (!cli) {
    return fail('no-cli', 'Orca CLI が見つかりません / Orca CLI not found', 'ORCA_CLI 環境変数で orca の場所を指定してください。');
  }

  const ctx = await d.readContext();
  if (!ctx) return fail('no-context', 'フォーカス中のワークツリーがありません / No focused worktree');

  let worktrees: OrcaWorktree[];
  let terminals: OrcaTerminal[];
  try {
    [worktrees, terminals] = await Promise.all([d.orca.listWorktrees(cli), d.orca.listTerminals(cli)]);
  } catch (e) {
    return fail('orca', 'Orca CLI の実行に失敗しました / Orca CLI failed', e instanceof Error ? e.message : String(e));
  }

  const match = matchWorktree(ctx, worktrees, terminals);
  if (match.kind === 'none') return fail('no-match', 'ワークツリーを特定できませんでした / Could not identify the worktree', ctx.displayName);
  if (match.kind === 'ambiguous') {
    return fail('ambiguous', '同名のワークツリーが複数あります / Several worktrees share this name', match.candidates.map((c) => c.path).join('\n'));
  }
  return openWorktree(d, cli, match.worktree);
}

/** Open (or re-use) the Git Graph tab for a known worktree. Shared by the plugin command and the CLI. */
export async function openWorktree(d: LauncherDeps, cli: string, wt: OrcaWorktree): Promise<OpenResult> {
  const fail = makeFail(d);
  if (wt.hostId !== 'local') {
    return fail('remote', 'リモートのワークツリーは未対応です / Remote worktrees are not supported', 'Git Graph はローカルのワークツリーのみ対応しています。');
  }
  if (wt.kind !== 'git') return fail('not-git', 'Git リポジトリではありません / Not a git repository', wt.path);

  let server: { port: number; token: string };
  try {
    server = await d.ensureServer(cli);
  } catch (e) {
    return fail('server', 'Git Graph サーバーを起動できませんでした / Could not start the Git Graph server', e instanceof Error ? e.message : String(e));
  }

  const url = buildUrl(server.port, server.token, wt.id);
  try {
    const existing = findExistingTab(await d.orca.listTabs(cli, wt.id), wt.id);
    if (existing) {
      await d.orca.switchTab(cli, wt.id, existing.browserPageId);
      if (existing.url === url) return { ok: true, action: 'switched', url };
      // the server restarted since this tab was opened: point it at the new port / token
      await d.orca.navigateTab(cli, wt.id, existing.browserPageId, url);
      return { ok: true, action: 'navigated', url };
    }
    await d.orca.createTab(cli, wt.id, url);
    return { ok: true, action: 'created', url };
  } catch (e) {
    return fail('orca', 'タブを開けませんでした / Could not open the tab', e instanceof Error ? e.message : String(e));
  }
}
