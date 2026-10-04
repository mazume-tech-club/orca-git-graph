import type { ChangedFile, Commit, GraphRow, RefInfo } from './types.js';
import type { Preset } from './refs.js';

export interface RepoSummary {
  id: string;
  name: string;
  path: string;
}

export interface RepoInfo extends RepoSummary {
  head: {
    hash: string | null;
    /** `null` when detached or the repository has no commits */
    branch: string | null;
    detached: boolean;
  };
  refs: RefInfo[];
  remotes: string[];
  /** Uncommitted state of the working tree */
  dirty: { changed: number; untracked: number };
  /** Changes whenever refs or HEAD change; pass back to /api/log to detect staleness */
  rev: string;
  presets: Preset[];
}

export interface LogItem {
  commit: Commit;
  row: GraphRow;
  /** Full ref names pointing at this commit */
  refs: string[];
}

export interface LogResponse {
  rev: string;
  items: LogItem[];
  cursor: number;
  nextCursor: number | null;
  /** Known only once the whole history has been read */
  total: number | null;
}

export interface CommitDetail {
  commit: Commit;
  body: string;
  committerName: string;
  committerTimestamp: number;
  /** First parent (the diff base), or `null` for a root commit */
  base: string | null;
  files: ChangedFile[];
}

export interface CompareResponse {
  a: string;
  b: string;
  mergeBases: string[];
  ahead: number;
  behind: number;
  onlyA: string[];
  onlyB: string[];
  /** `true` when onlyA/onlyB were cut off (counts stay exact) */
  truncated: boolean;
}

export interface DiffFilesResponse {
  base: string | null;
  head: string;
  mode: 'three-dot' | 'two-dot';
  files: ChangedFile[];
}

export interface DiffFileResponse {
  diff: string;
  truncated: boolean;
}

export interface SearchResponse {
  rev: string;
  indices: number[];
  truncated: boolean;
}

export interface FetchResponse {
  ok: boolean;
  output: string;
}

export interface WorktreeStatusResponse {
  files: ChangedFile[];
}

export type ServerEvent = { type: 'refs' } | { type: 'status' } | { type: 'ping' };

export interface ApiErrorBody {
  error: { code: string; message: string };
}
