import { createHash } from 'node:crypto';
import {
  buildPresets,
  createLaneState,
  isSafeRefName,
  layoutRows,
  LOG_FORMAT,
  mergeChangedFiles,
  parseLog,
  parseNameStatusZ,
  parseNumstatZ,
  parseRefs,
  REF_FORMAT,
  type ChangedFile,
  type Commit,
  type CommitDetail,
  type CompareResponse,
  type DiffFileResponse,
  type DiffFilesResponse,
  type GraphRow,
  type LaneState,
  type LogItem,
  type LogResponse,
  type RefInfo,
  type RepoInfo,
  type SearchResponse,
} from '@orca-git-graph/core';
import { basename, resolve } from 'node:path';
import { git, GitError } from './git.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const COMPARE_LIST_LIMIT = 20_000;
const DIFF_MAX_BYTES = 4 * 1024 * 1024;
const LOG_CHUNK = 1000;

/** Which refs the graph is built from. */
export type LogScope = { kind: 'all' } | { kind: 'types'; types: Array<'local' | 'remote' | 'tag'> } | { kind: 'refs'; refs: string[] };

interface RefsState {
  refs: RefInfo[];
  headHash: string | null;
  branch: string | null;
  rev: string;
  at: number;
}

class LogCache {
  commits: Commit[] = [];
  rows: GraphRow[] = [];
  done = false;
  private state: LaneState = createLaneState();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly repoPath: string,
    private readonly revArgs: string[],
  ) {}

  async ensure(count: number): Promise<void> {
    while (!this.done && this.commits.length < count) {
      this.loading ??= this.loadMore().finally(() => {
        this.loading = null;
      });
      await this.loading;
    }
  }

  private async loadMore(): Promise<void> {
    if (this.revArgs.length === 0) {
      this.done = true;
      return;
    }
    const chunk = this.commits.length === 0 ? LOG_CHUNK : LOG_CHUNK * 4;
    const out = await git(this.repoPath, [
      'log',
      '--topo-order',
      '-z',
      `--format=${LOG_FORMAT}`,
      `--skip=${this.commits.length}`,
      `-n`,
      String(chunk),
      ...this.revArgs,
      '--',
    ]);
    const parsed = parseLog(out);
    this.rows.push(...layoutRows(parsed, this.state));
    this.commits.push(...parsed);
    if (parsed.length < chunk) this.done = true;
  }
}

interface HashList {
  hashes: string[];
  index: Map<string, number>;
}

export class GitRepo {
  readonly name: string;
  private refsState: RefsState | null = null;
  private refsInflight: Promise<RefsState> | null = null;
  private logCaches = new Map<string, { rev: string; cache: LogCache }>();
  private hashLists = new Map<string, { rev: string; list: Promise<HashList> }>();

  constructor(readonly path: string) {
    this.name = basename(resolve(path));
  }

  /** Throws if `path` is not inside a git work tree. */
  static async open(path: string): Promise<GitRepo> {
    try {
      const out = await git(path, ['rev-parse', '--show-toplevel']);
      return new GitRepo(out.trim() || path);
    } catch (e) {
      if (e instanceof GitError) throw new HttpError(422, 'not_a_git_repo', `not a git repository: ${path}`);
      throw e;
    }
  }

  // ---- refs / head -------------------------------------------------------

  async getRefsState(maxAgeMs = 300): Promise<RefsState> {
    if (this.refsState && Date.now() - this.refsState.at < maxAgeMs) return this.refsState;
    this.refsInflight ??= this.readRefsState().finally(() => {
      this.refsInflight = null;
    });
    return this.refsInflight;
  }

  /** Force the next call to re-read refs (after fetch or a watcher event). */
  invalidate(): void {
    this.refsState = null;
  }

  private async readRefsState(): Promise<RefsState> {
    const [refsOut, headOut, branchOut] = await Promise.all([
      git(this.path, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
      git(this.path, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => ''),
      git(this.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    ]);
    const headHash = headOut.trim() || null;
    const branch = branchOut.trim() || null;
    const rev = createHash('sha1').update(refsOut).update('\0').update(headHash ?? '').update('\0').update(branch ?? '').digest('hex').slice(0, 12);
    this.refsState = { refs: parseRefs(refsOut), headHash, branch, rev, at: Date.now() };
    return this.refsState;
  }

  async info(id: string): Promise<RepoInfo> {
    const [state, remotesOut, dirty] = await Promise.all([this.getRefsState(0), git(this.path, ['remote']), this.dirtyCount()]);
    const local = state.refs.filter((r) => r.type === 'local');
    const current = local.find((r) => r.isHead);
    return {
      id,
      name: this.name,
      path: this.path,
      head: { hash: state.headHash, branch: state.branch, detached: state.headHash !== null && state.branch === null },
      refs: state.refs,
      remotes: remotesOut.split('\n').filter(Boolean),
      dirty,
      rev: state.rev,
      presets: buildPresets({
        head: state.branch,
        upstream: current?.upstream,
        branches: local.map((r) => r.name),
        remoteBranches: state.refs.filter((r) => r.type === 'remote').map((r) => r.name),
      }),
    };
  }

  private async dirtyCount(): Promise<{ changed: number; untracked: number }> {
    const out = await git(this.path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).catch(() => '');
    let changed = 0;
    let untracked = 0;
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]!;
      if (e.length < 3) continue;
      if (e.startsWith('??')) untracked++;
      else changed++;
      if (e[0] === 'R' || e[0] === 'C') i++; // the old path follows as its own NUL field
    }
    return { changed, untracked };
  }

  // ---- ref / commit resolution --------------------------------------------

  /** Turn a user-supplied ref / hash into a full commit hash. Never passes raw input to git as an option. */
  async resolveCommit(spec: string): Promise<string> {
    if (!isSafeRefName(spec)) throw new HttpError(400, 'bad_ref', `invalid ref: ${spec}`);
    const state = await this.getRefsState();
    if (spec === 'HEAD') {
      if (!state.headHash) throw new HttpError(404, 'no_head', 'repository has no commits');
      return state.headHash;
    }
    const byFull = state.refs.find((r) => r.fullName === spec);
    const byName =
      state.refs.find((r) => r.name === spec && r.type === 'local') ??
      state.refs.find((r) => r.name === spec && r.type === 'remote') ??
      state.refs.find((r) => r.name === spec && r.type === 'tag');
    const ref = byFull ?? byName;
    if (ref) return ref.hash;
    if (/^[0-9a-fA-F]{4,64}$/.test(spec)) {
      try {
        const out = await git(this.path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${spec}^{commit}`]);
        const h = out.trim();
        if (h) return h;
      } catch {
        /* fall through */
      }
    }
    throw new HttpError(404, 'unknown_ref', `unknown ref: ${spec}`);
  }

  // ---- log ----------------------------------------------------------------

  private async scopeArgs(scope: LogScope): Promise<{ key: string; args: string[] }> {
    const state = await this.getRefsState();
    if (scope.kind === 'all') {
      const args = ['--branches', '--remotes', '--tags'];
      if (state.headHash) args.push('HEAD');
      return { key: 'all', args };
    }
    if (scope.kind === 'types') {
      const flag = { local: '--branches', remote: '--remotes', tag: '--tags' } as const;
      const types = [...new Set(scope.types)].sort();
      // HEAD is always included so the current position stays visible
      const args: string[] = types.map((t) => flag[t]);
      if (state.headHash) args.push('HEAD');
      return { key: `types:${types.join(',')}`, args };
    }
    const known = new Set(state.refs.map((r) => r.fullName));
    const refs = scope.refs.filter((r) => known.has(r));
    for (const r of scope.refs) {
      if (!isSafeRefName(r)) throw new HttpError(400, 'bad_ref', `invalid ref: ${r}`);
    }
    const args = [...refs];
    if (state.headHash && scope.refs.includes('HEAD')) args.push('HEAD');
    return { key: `refs:${[...refs].sort().join(',')}`, args };
  }

  async getLog(scope: LogScope, cursor: number, limit: number, rev?: string): Promise<LogResponse> {
    const state = await this.getRefsState();
    if (rev && rev !== state.rev) throw new HttpError(409, 'stale', 'repository changed; reload');
    const { key, args } = await this.scopeArgs(scope);
    let entry = this.logCaches.get(key);
    if (!entry || entry.rev !== state.rev) {
      entry = { rev: state.rev, cache: new LogCache(this.path, args) };
      this.logCaches.set(key, entry);
    }
    const cache = entry.cache;
    await cache.ensure(cursor + limit + 1);
    const slice = cache.commits.slice(cursor, cursor + limit);
    const byHash = refsByHash(state.refs);
    const items: LogItem[] = slice.map((commit, i) => ({
      commit,
      row: cache.rows[cursor + i]!,
      refs: byHash.get(commit.hash) ?? [],
    }));
    const end = cursor + items.length;
    const hasMore = end < cache.commits.length || !cache.done;
    return { rev: state.rev, items, cursor, nextCursor: hasMore ? end : null, total: cache.done ? cache.commits.length : null };
  }

  private hashList(scopeKey: string, args: string[], rev: string): Promise<HashList> {
    const cached = this.hashLists.get(scopeKey);
    if (cached && cached.rev === rev) return cached.list;
    const list = (async () => {
      const out = args.length === 0 ? '' : await git(this.path, ['log', '--topo-order', '-z', '--format=%H', ...args, '--']);
      const hashes = out.split('\0').map((s) => s.replace(/^\n/, '')).filter(Boolean);
      return { hashes, index: new Map(hashes.map((h, i) => [h, i] as const)) };
    })();
    this.hashLists.set(scopeKey, { rev, list });
    return list;
  }

  async search(scope: LogScope, query: string, rev?: string): Promise<SearchResponse> {
    const state = await this.getRefsState();
    if (rev && rev !== state.rev) throw new HttpError(409, 'stale', 'repository changed; reload');
    const q = query.trim();
    if (q === '') return { rev: state.rev, indices: [], truncated: false };
    if (q.length > 200) throw new HttpError(400, 'bad_query', 'query too long');
    const { key, args } = await this.scopeArgs(scope);
    const list = await this.hashList(key, args, state.rev);
    const hits = new Set<string>();

    if (args.length > 0) {
      // git ANDs `--grep` with `--author`, so run them separately and union the results. Each pattern is a
      // single argv entry (`--grep=<q>`), so it can't act as an option.
      const run = (flag: string) =>
        git(this.path, ['log', '--topo-order', '-z', '--format=%H', '-i', '--fixed-strings', `${flag}=${q}`, ...args, '--']);
      for (const out of await Promise.all([run('--grep'), run('--author')])) {
        for (const h of out.split('\0')) {
          const hash = h.replace(/^\n/, '');
          if (hash) hits.add(hash);
        }
      }
    }
    if (/^[0-9a-fA-F]{4,64}$/.test(q)) {
      const p = q.toLowerCase();
      for (const h of list.hashes) if (h.startsWith(p)) hits.add(h);
    }
    const lower = q.toLowerCase();
    for (const r of state.refs) if (r.name.toLowerCase().includes(lower)) hits.add(r.hash);

    const indices = [...hits].map((h) => list.index.get(h)).filter((i): i is number => i !== undefined).sort((a, b) => a - b);
    const LIMIT = 5000;
    return { rev: state.rev, indices: indices.slice(0, LIMIT), truncated: indices.length > LIMIT };
  }

  // ---- commit / diff ------------------------------------------------------

  async changedFiles(base: string | null, head: string): Promise<ChangedFile[]> {
    const common = base === null ? ['diff-tree', '--root', '-r', '--no-commit-id', '-M', '-z'] : ['diff', '-M', '-z'];
    const tail = base === null ? [head] : [base, head, '--'];
    const [ns, num] = await Promise.all([
      git(this.path, [...common, '--name-status', ...tail]),
      git(this.path, [...common, '--numstat', ...tail]),
    ]);
    return mergeChangedFiles(parseNameStatusZ(ns), parseNumstatZ(num));
  }

  async commitDetail(sha: string): Promise<CommitDetail> {
    const hash = await this.resolveCommit(sha);
    const out = await git(this.path, ['show', '-s', '-z', `--format=${LOG_FORMAT}%x1f%cn%x1f%ct%x1f%B`, hash]);
    const f = out.replace(/\0$/, '').split('\x1f');
    if (f.length < 9) throw new HttpError(404, 'unknown_commit', `unknown commit: ${sha}`);
    const parents = f[1] ? f[1].split(' ') : [];
    const commit: Commit = {
      hash: f[0]!,
      parents,
      authorName: f[2]!,
      authorEmail: f[3]!,
      timestamp: Number(f[4]),
      subject: f[5]!,
    };
    const base = parents[0] ?? null;
    return {
      commit,
      body: f.slice(8).join('\x1f').trimEnd(),
      committerName: f[6]!,
      committerTimestamp: Number(f[7]),
      base,
      files: await this.changedFiles(base, hash),
    };
  }

  async compare(a: string, b: string): Promise<CompareResponse> {
    const [ha, hb] = await Promise.all([this.resolveCommit(a), this.resolveCommit(b)]);
    const [mbOut, countOut, onlyAOut, onlyBOut] = await Promise.all([
      git(this.path, ['merge-base', '--all', ha, hb], { okCodes: [1] }),
      git(this.path, ['rev-list', '--left-right', '--count', `${ha}...${hb}`]),
      git(this.path, ['rev-list', `--max-count=${COMPARE_LIST_LIMIT}`, ha, `^${hb}`]),
      git(this.path, ['rev-list', `--max-count=${COMPARE_LIST_LIMIT}`, hb, `^${ha}`]),
    ]);
    const [ahead, behind] = countOut.trim().split(/\s+/).map(Number) as [number, number];
    const onlyA = onlyAOut.split('\n').filter(Boolean);
    const onlyB = onlyBOut.split('\n').filter(Boolean);
    return {
      a: ha,
      b: hb,
      mergeBases: mbOut.split('\n').filter(Boolean),
      ahead,
      behind,
      onlyA,
      onlyB,
      truncated: ahead > onlyA.length || behind > onlyB.length,
    };
  }

  /**
   * Resolve the diff base for a comparison. three-dot = from the merge-base (what B introduced since
   * the branches diverged); two-dot = A directly against B. Unrelated histories fall back to two-dot.
   */
  private async diffBase(a: string | null, b: string, mode: 'three-dot' | 'two-dot'): Promise<{ base: string | null; head: string }> {
    const head = await this.resolveCommit(b);
    if (a === null || a === '') return { base: null, head };
    const base = await this.resolveCommit(a);
    if (mode === 'two-dot') return { base, head };
    const mb = (await git(this.path, ['merge-base', base, head], { okCodes: [1] })).trim();
    return { base: mb || base, head };
  }

  async diffFiles(a: string | null, b: string, mode: 'three-dot' | 'two-dot'): Promise<DiffFilesResponse> {
    const { base, head } = await this.diffBase(a, b, mode);
    return { base, head, mode, files: await this.changedFiles(base, head) };
  }

  async diffFile(a: string | null, b: string, mode: 'three-dot' | 'two-dot', path: string, oldPath?: string): Promise<DiffFileResponse> {
    const paths = [path, ...(oldPath && oldPath !== path ? [oldPath] : [])];
    for (const p of paths) assertSafePath(p);
    const { base, head } = await this.diffBase(a, b, mode);
    const args =
      base === null
        ? ['diff-tree', '-p', '--root', '-r', '-M', '--no-color', '--no-commit-id', head, '--', ...paths]
        : ['diff', '-M', '--no-color', '--unified=3', base, head, '--', ...paths];
    return this.runDiff(args);
  }

  private async runDiff(args: string[], okCodes?: number[]): Promise<DiffFileResponse> {
    try {
      return { diff: await git(this.path, args, { literalPathspecs: true, maxBuffer: DIFF_MAX_BYTES, okCodes }), truncated: false };
    } catch (e) {
      if (e instanceof GitError && e.overflow) return { diff: '', truncated: true };
      throw e;
    }
  }

  // ---- working tree ------------------------------------------------------

  async worktreeFiles(): Promise<ChangedFile[]> {
    const state = await this.getRefsState();
    const out = await git(this.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const numstat = state.headHash
      ? parseNumstatZ(await git(this.path, ['diff', 'HEAD', '--numstat', '-z', '-M', '--']).catch(() => ''))
      : new Map();
    const files: ChangedFile[] = [];
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]!;
      if (e.length < 4) continue;
      const x = e[0]!;
      const y = e[1]!;
      const path = e.slice(3);
      let oldPath: string | undefined;
      if (x === 'R' || x === 'C') oldPath = parts[++i];
      const letter = x === '?' ? 'A' : y !== ' ' ? y : x;
      const status = 'AMDRCTUX'.includes(letter) ? (letter as ChangedFile['status']) : 'X';
      const n = numstat.get(path);
      files.push({ path, oldPath, status, added: n ? n.added : 0, deleted: n ? n.deleted : 0 });
    }
    return files;
  }

  async worktreeDiff(path: string, oldPath?: string): Promise<DiffFileResponse> {
    assertSafePath(path);
    if (oldPath) assertSafePath(oldPath);
    const tracked = (await git(this.path, ['ls-files', '-z', '--', path], { literalPathspecs: true })).length > 0;
    const state = await this.getRefsState();
    if (!tracked) {
      // untracked: show the whole file as added. `--no-index` exits 1 when files differ.
      return this.runDiff(['diff', '--no-index', '--no-color', '--', '/dev/null', path], [1]);
    }
    const base = state.headHash ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    return this.runDiff(['diff', base, '-M', '--no-color', '--unified=3', '--', path, ...(oldPath ? [oldPath] : [])]);
  }

  // ---- fetch -------------------------------------------------------------

  /** The one operation that changes the repository (refs only); callers must gate it behind an explicit user action. */
  async fetch(): Promise<string> {
    const out = await git(this.path, ['fetch', '--all', '--prune'], { timeoutMs: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    this.invalidate();
    return out;
  }
}

function refsByHash(refs: RefInfo[]): Map<string, string[]> {
  const order = { local: 0, remote: 1, tag: 2 } as const;
  const sorted = [...refs].sort((a, b) => Number(b.isHead) - Number(a.isHead) || order[a.type] - order[b.type] || a.name.localeCompare(b.name));
  const m = new Map<string, string[]>();
  for (const r of sorted) {
    const list = m.get(r.hash);
    if (list) list.push(r.fullName);
    else m.set(r.hash, [r.fullName]);
  }
  return m;
}

function assertSafePath(p: string): void {
  if (p === '' || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes('..')) {
    throw new HttpError(400, 'bad_path', 'invalid path');
  }
}
