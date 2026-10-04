import type { ChangedFile, Commit, FileStatus, RefInfo } from './types.js';

/** Field separator inside one record. Records themselves are NUL-terminated (`git log -z`). */
const FS = '\x1f';

/** Use with `git log -z --format=LOG_FORMAT`. */
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f');

export function parseLog(output: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of output.split('\0')) {
    // `git log -z` may emit a leading newline for the record after the first one
    const rec = record.replace(/^\n/, '');
    if (rec === '') continue;
    const f = rec.split(FS);
    if (f.length < 6) continue;
    commits.push({
      hash: f[0]!,
      parents: f[1] ? f[1].split(' ') : [],
      authorName: f[2]!,
      authorEmail: f[3]!,
      timestamp: Number(f[4]),
      subject: f.slice(5).join(FS),
    });
  }
  return commits;
}

/** Use with `git for-each-ref --format=REF_FORMAT refs/heads refs/remotes refs/tags`. Records are newline-separated. */
export const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  '%(upstream:short)',
  '%(HEAD)',
].join('%00');

export function parseRefs(output: string): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const [fullName, objectName, peeled, upstream, head] = line.split('\0');
    if (!fullName || !objectName) continue;
    const hash = peeled || objectName;
    if (fullName.startsWith('refs/heads/')) {
      refs.push({
        name: fullName.slice('refs/heads/'.length),
        fullName,
        type: 'local',
        hash,
        upstream: upstream || undefined,
        isHead: head === '*',
      });
    } else if (fullName.startsWith('refs/remotes/')) {
      const short = fullName.slice('refs/remotes/'.length);
      // `origin/HEAD` is a symbolic ref that only duplicates another branch
      if (short.endsWith('/HEAD')) continue;
      const slash = short.indexOf('/');
      refs.push({
        name: short,
        fullName,
        type: 'remote',
        hash,
        remote: slash > 0 ? short.slice(0, slash) : short,
        isHead: false,
      });
    } else if (fullName.startsWith('refs/tags/')) {
      refs.push({
        name: fullName.slice('refs/tags/'.length),
        fullName,
        type: 'tag',
        hash,
        isHead: false,
      });
    }
  }
  return refs;
}

/** Output of `git rev-list --left-right --count A...B` → `[left, right]` = commits only in A, only in B. */
export function parseLeftRightCount(output: string): [number, number] {
  const m = output.trim().split(/\s+/);
  return [Number(m[0] ?? 0) || 0, Number(m[1] ?? 0) || 0];
}

/** Output of `git diff --numstat -z` → map keyed by (new) path. */
export function parseNumstatZ(
  output: string,
): Map<string, { added: number | null; deleted: number | null; oldPath?: string }> {
  const out = new Map<string, { added: number | null; deleted: number | null; oldPath?: string }>();
  const parts = output.split('\0');
  let i = 0;
  while (i < parts.length) {
    const head = parts[i++]!;
    if (head === '') continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    const added = m[1] === '-' ? null : Number(m[1]);
    const deleted = m[2] === '-' ? null : Number(m[2]);
    if (m[3] === '') {
      // rename/copy: the next two NUL fields are old and new path
      const oldPath = parts[i++] ?? '';
      const path = parts[i++] ?? '';
      out.set(path, { added, deleted, oldPath });
    } else {
      out.set(m[3]!, { added, deleted });
    }
  }
  return out;
}

const STATUS_LETTERS = new Set(['A', 'M', 'D', 'R', 'C', 'T', 'U', 'X']);

/** Output of `git diff --name-status -z`. */
export function parseNameStatusZ(output: string): Array<{ status: FileStatus; path: string; oldPath?: string }> {
  const result: Array<{ status: FileStatus; path: string; oldPath?: string }> = [];
  const parts = output.split('\0');
  let i = 0;
  while (i < parts.length) {
    const code = parts[i++]!;
    if (code === '') continue;
    const letter = code[0]!;
    const status = (STATUS_LETTERS.has(letter) ? letter : 'X') as FileStatus;
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i++] ?? '';
      const path = parts[i++] ?? '';
      result.push({ status, path, oldPath });
    } else {
      result.push({ status, path: parts[i++] ?? '' });
    }
  }
  return result;
}

export function mergeChangedFiles(
  nameStatus: ReturnType<typeof parseNameStatusZ>,
  numstat: ReturnType<typeof parseNumstatZ>,
): ChangedFile[] {
  return nameStatus.map((e) => {
    const n = numstat.get(e.path);
    return {
      path: e.path,
      oldPath: e.oldPath,
      status: e.status,
      added: n ? n.added : 0,
      deleted: n ? n.deleted : 0,
    };
  });
}
