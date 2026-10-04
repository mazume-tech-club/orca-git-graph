/**
 * The only module that runs the `orca` CLI. Orca's plugin worker may lose the ability to spawn
 * processes (a future `process:exec` capability); keeping every external command here makes the
 * replacement a one-file change.
 *
 * CLI shapes below were verified against Orca 1.4.220 on Windows (see CLAUDE.md).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export class OrcaError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'OrcaError';
  }
}

/** Candidate install locations. Only the win32 path was verified; macOS/Linux are best guesses. */
function defaultInstallPaths(): string[] {
  const home = homedir();
  switch (process.platform) {
    case 'win32':
      return [
        join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'orca', 'resources', 'bin', 'orca.exe'),
      ];
    case 'darwin':
      return [
        '/Applications/Orca.app/Contents/Resources/bin/orca',
        join(home, 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca'),
        '/usr/local/bin/orca',
      ];
    default:
      return ['/opt/Orca/resources/bin/orca', '/usr/local/bin/orca', join(home, '.local', 'bin', 'orca')];
  }
}

function findOnPath(): string | null {
  const names = process.platform === 'win32' ? ['orca.exe'] : ['orca'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = join(dir, n);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Resolution order: explicit setting → ORCA_CLI env → PATH → default install location. */
export function resolveOrcaCli(setting?: string | null): string | null {
  const candidates = [setting, process.env.ORCA_CLI, findOnPath(), ...defaultInstallPaths()];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

interface Envelope<T> {
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string };
}

/**
 * Environment for running the `orca` CLI. A plugin worker is started by Orca with a minimal environment (no
 * USERPROFILE / APPDATA / LOCALAPPDATA on Windows, observed on Orca 1.4.220), and the CLI then cannot locate the
 * running Orca's user-data directory and fails. So the user-profile variables are filled in from the home
 * directory, and ELECTRON_RUN_AS_NODE (set for the worker itself) is not passed on.
 */
export function cliEnv(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  if (platform === 'win32') {
    env.USERPROFILE ??= home;
    env.APPDATA ??= join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA ??= join(home, 'AppData', 'Local');
  } else {
    env.HOME ??= home;
  }
  return env;
}

function exec(cli: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts = { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: cliEnv() };
    execFile(cli, args, opts, (err, stdout, stderr) => {
      // The CLI reports failures as a JSON envelope on stdout even with a non-zero exit code.
      if (stdout.trim().startsWith('{')) return resolve(stdout);
      if (err) return reject(new OrcaError(stderr.trim() || err.message, 'exec_failed'));
      resolve(stdout);
    });
  });
}

export async function runOrca<T>(cli: string, args: string[], timeoutMs = 15000): Promise<T> {
  const out = await exec(cli, [...args, '--json'], timeoutMs);
  let env: Envelope<T>;
  try {
    env = JSON.parse(out) as Envelope<T>;
  } catch {
    throw new OrcaError(`unexpected output from orca: ${out.slice(0, 200)}`, 'bad_output');
  }
  if (!env.ok) throw new OrcaError(env.error?.message ?? 'orca command failed', env.error?.code ?? 'failed');
  return env.result as T;
}

export interface OrcaWorktree {
  /** `<repoId>::<absolutePath>` */
  id: string;
  repoId: string;
  hostId: string;
  kind: string;
  displayName: string;
  branch: string;
  path: string;
}

interface RawWorktree {
  worktreeId: string;
  repoId: string;
  hostId?: string;
  workspaceKind?: string;
  displayName?: string;
  branch?: string;
  path: string;
}

export async function listWorktrees(cli: string): Promise<OrcaWorktree[]> {
  const r = await runOrca<{ worktrees: RawWorktree[] }>(cli, ['worktree', 'ps']);
  return r.worktrees.map((w) => ({
    id: w.worktreeId,
    repoId: w.repoId,
    hostId: w.hostId ?? 'local',
    kind: w.workspaceKind ?? 'git',
    displayName: w.displayName ?? '',
    branch: w.branch ?? '',
    path: w.path,
  }));
}

/**
 * The worktree that contains the shell's current directory (`orca worktree current`).
 * Only meaningful when run from a terminal inside a worktree, NOT from a plugin worker.
 */
export async function currentWorktreeId(cli: string): Promise<string> {
  const r = await runOrca<{ worktree: { id: string } }>(cli, ['worktree', 'current']);
  return r.worktree.id;
}

export interface OrcaTerminal {
  handle: string;
  ptyId: string;
  worktreeId: string;
}

export async function listTerminals(cli: string): Promise<OrcaTerminal[]> {
  const r = await runOrca<{ terminals: OrcaTerminal[] }>(cli, ['terminal', 'list']);
  return r.terminals;
}

export interface OrcaTab {
  browserPageId: string;
  url: string;
  title: string;
  active: boolean;
  /** Set when the page failed to load (e.g. the server it pointed to was not running) */
  loadError?: string | null;
}

// `id:` / `path:` selectors are explicit; `active`/`current` resolve from the shell cwd and fail from a worker.
export async function listTabs(cli: string, worktreeId: string): Promise<OrcaTab[]> {
  const r = await runOrca<{ tabs: OrcaTab[] }>(cli, ['tab', 'list', '--worktree', `id:${worktreeId}`]);
  return r.tabs;
}

export async function createTab(cli: string, worktreeId: string, url: string): Promise<string> {
  const r = await runOrca<{ browserPageId: string }>(cli, ['tab', 'create', '--url', url, '--worktree', `id:${worktreeId}`]);
  return r.browserPageId;
}

export async function switchTab(cli: string, worktreeId: string, pageId: string): Promise<void> {
  await runOrca(cli, ['tab', 'switch', '--page', pageId, '--worktree', `id:${worktreeId}`]);
}

/** Load `url` in an existing tab (used when the old tab belongs to a server that has since restarted). */
export async function navigateTab(cli: string, worktreeId: string, pageId: string, url: string): Promise<void> {
  await runOrca(cli, ['goto', '--url', url, '--page', pageId, '--worktree', `id:${worktreeId}`]);
}

export interface WorkspaceContext {
  branch: string;
  displayName: string;
  terminals: Array<{ id: string }>;
}

export type WorktreeMatch =
  | { kind: 'found'; worktree: OrcaWorktree }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: OrcaWorktree[] };

/**
 * Identify the focused worktree from `workspace.readContext` (displayName/branch/terminal ids).
 * The plugin API passes no worktree to command handlers, so this is the only way to find it.
 * Terminal ids are the most precise signal; displayName+branch is the fallback.
 */
export function matchWorktree(
  ctx: WorkspaceContext,
  worktrees: readonly OrcaWorktree[],
  terminals: readonly OrcaTerminal[],
): WorktreeMatch {
  const termIds = new Set(ctx.terminals.map((t) => t.id));
  if (termIds.size > 0) {
    const ids = new Set(terminals.filter((t) => termIds.has(t.handle) || termIds.has(t.ptyId)).map((t) => t.worktreeId));
    if (ids.size === 1) {
      const wt = worktrees.find((w) => w.id === [...ids][0]);
      if (wt) return { kind: 'found', worktree: wt };
    }
  }
  const byName = worktrees.filter((w) => w.displayName === ctx.displayName && w.branch === ctx.branch);
  const loose = byName.length > 0 ? byName : worktrees.filter((w) => w.displayName === ctx.displayName);
  if (loose.length === 1) return { kind: 'found', worktree: loose[0]! };
  if (loose.length === 0) return { kind: 'none' };
  return { kind: 'ambiguous', candidates: loose };
}
