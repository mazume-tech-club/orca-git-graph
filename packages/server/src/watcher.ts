import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { git } from './git.js';
import type { GitRepo } from './repo.js';

export type WatchEvent = 'refs' | 'status';
type Listener = (event: WatchEvent) => void;

const DEBOUNCE_MS = 150;
const STATUS_POLL_MS = 4000;

/**
 * Watches `.git/HEAD`, `.git/packed-refs`, `.git/refs/**` and the index. For a linked worktree `.git`
 * is a file, so the real directories are resolved with `rev-parse` (HEAD/index live in the per-worktree
 * git dir, refs in the common dir). Plain edits to tracked files do not touch the index, so the
 * "uncommitted changes" state is also polled while somebody is listening.
 */
export class RepoWatcher {
  private listeners = new Set<Listener>();
  private watchers: FSWatcher[] = [];
  private timers = new Map<WatchEvent, NodeJS.Timeout>();
  private poll: NodeJS.Timeout | null = null;
  private lastStatus = '';
  private starting: Promise<void> | null = null;

  constructor(private readonly repo: GitRepo) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.starting = this.start();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private emit(event: WatchEvent): void {
    clearTimeout(this.timers.get(event));
    this.timers.set(
      event,
      setTimeout(() => {
        this.timers.delete(event);
        if (event === 'refs') this.repo.invalidate();
        for (const l of this.listeners) l(event);
      }, DEBOUNCE_MS),
    );
  }

  private async start(): Promise<void> {
    try {
      const [gitDirOut, commonOut] = await Promise.all([
        git(this.repo.path, ['rev-parse', '--absolute-git-dir']),
        git(this.repo.path, ['rev-parse', '--git-common-dir']),
      ]);
      const gitDir = gitDirOut.trim();
      const commonDir = resolve(this.repo.path, commonOut.trim());
      if (this.listeners.size === 0) return;

      const add = (dir: string, recursive: boolean, filter: (name: string) => WatchEvent | null) => {
        try {
          const w = watch(dir, { recursive, persistent: false }, (_t, name) => {
            const ev = filter(String(name ?? '').replace(/\\/g, '/'));
            if (ev) this.emit(ev);
          });
          w.on('error', () => undefined);
          this.watchers.push(w);
        } catch {
          /* directory missing or recursive watching unsupported: polling below still covers status */
        }
      };
      const refsFile = (n: string): WatchEvent | null => (n === 'HEAD' || n === 'packed-refs' ? 'refs' : null);
      add(gitDir, false, (n) => (n === 'index' ? 'status' : refsFile(n)));
      if (commonDir !== gitDir) add(commonDir, false, refsFile);
      add(resolve(commonDir, 'refs'), true, (n) => (n.endsWith('.lock') ? null : 'refs'));
    } catch {
      /* not a repo anymore */
    }

    this.lastStatus = await this.statusSignature();
    this.poll = setInterval(() => {
      void this.statusSignature().then((sig) => {
        if (sig !== this.lastStatus) {
          this.lastStatus = sig;
          this.emit('status');
        }
      });
    }, STATUS_POLL_MS);
    this.poll.unref();
  }

  private async statusSignature(): Promise<string> {
    try {
      return await git(this.repo.path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    } catch {
      return '';
    }
  }

  private stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /** For tests */
  async ready(): Promise<void> {
    await this.starting;
  }
}
