import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { RepoSummary } from '@orca-git-graph/core';
import type { OrcaWorktree } from '@orca-git-graph/platform';
import { HttpError, GitRepo } from './repo.js';
import { RepoWatcher } from './watcher.js';

export interface RepoHandle {
  id: string;
  repo: GitRepo;
  watcher: RepoWatcher;
}

/** Supplies Orca's worktree list on demand (injected so the server runs without Orca). */
export type WorktreeProvider = () => Promise<OrcaWorktree[]>;

const ORCA_REFRESH_MIN_INTERVAL_MS = 2000;

/**
 * Allow-list of repositories the API may touch. Entries come only from:
 *  - paths given at startup (`--repo`), and
 *  - worktrees reported by `orca worktree ps` (looked up lazily when an unknown id is requested).
 * A client can never name an arbitrary path.
 */
export class RepoRegistry {
  private paths = new Map<string, { path: string }>();
  private handles = new Map<string, RepoHandle>();
  private orcaWorktrees = new Map<string, OrcaWorktree>();
  private lastOrcaRefresh = 0;

  constructor(private readonly provider: WorktreeProvider | null = null) {}

  static idForPath(path: string): string {
    return 'p-' + createHash('sha1').update(resolve(path).toLowerCase()).digest('hex').slice(0, 10);
  }

  /** Register a startup path. */
  addPath(path: string): string {
    const id = RepoRegistry.idForPath(path);
    this.paths.set(id, { path: resolve(path) });
    return id;
  }

  private async refreshOrca(force = false): Promise<void> {
    if (!this.provider) return;
    if (!force && Date.now() - this.lastOrcaRefresh < ORCA_REFRESH_MIN_INTERVAL_MS) return;
    this.lastOrcaRefresh = Date.now();
    try {
      const list = await this.provider();
      this.orcaWorktrees = new Map(list.map((w) => [w.id, w]));
    } catch {
      /* Orca not reachable: keep the previous list */
    }
  }

  async get(id: string): Promise<RepoHandle> {
    const existing = this.handles.get(id);
    if (existing) return existing;

    let path = this.paths.get(id)?.path;
    if (!path) {
      if (!this.orcaWorktrees.has(id)) await this.refreshOrca();
      const wt = this.orcaWorktrees.get(id);
      if (!wt) throw new HttpError(404, 'unknown_repo', 'unknown repository id');
      if (wt.hostId !== 'local') {
        throw new HttpError(422, 'remote_worktree', 'このワークツリーはリモート（SSH など）上にあるため、Git Graph はローカルのワークツリーのみ対応しています。');
      }
      if (wt.kind !== 'git') throw new HttpError(422, 'not_a_git_repo', 'このワークスペースは Git リポジトリではありません。');
      path = wt.path;
    }
    const repo = await GitRepo.open(path);
    const handle: RepoHandle = { id, repo, watcher: new RepoWatcher(repo) };
    this.handles.set(id, handle);
    return handle;
  }

  /** Repositories registered at startup (what a standalone run shows in its picker). */
  list(): RepoSummary[] {
    return [...this.paths.entries()].map(([id, p]) => ({ id, path: p.path, name: p.path.split(/[\\/]/).filter(Boolean).pop() ?? p.path }));
  }

  defaultId(): string | null {
    const ids = [...this.paths.keys()];
    return ids.length === 1 ? ids[0]! : null;
  }
}
