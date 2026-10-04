export interface Commit {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Unix seconds (author date) */
  timestamp: number;
  subject: string;
}

export type RefType = 'local' | 'remote' | 'tag';

export interface RefInfo {
  /** Display name: `main`, `origin/main`, `v1.0` */
  name: string;
  /** Full ref name: `refs/heads/main` */
  fullName: string;
  type: RefType;
  /** Commit hash this ref points to (annotated tags are peeled) */
  hash: string;
  /** Remote name for remote refs */
  remote?: string;
  /** Upstream short name for local branches, e.g. `origin/main` */
  upstream?: string;
  /** `true` when this local branch is checked out in the current worktree */
  isHead: boolean;
}

export interface LaneEdge {
  /**
   * through: vertical line passing the row at `col`
   * in: line from the top of the row at `col` to the commit dot
   * out: line from the commit dot to the bottom of the row at `col`
   */
  type: 'through' | 'in' | 'out';
  col: number;
  /** Index into the colour palette (unbounded; the UI takes it modulo palette size) */
  color: number;
}

export interface GraphRow {
  hash: string;
  col: number;
  color: number;
  edges: LaneEdge[];
  /** Number of columns this row needs (max column + 1) */
  width: number;
}

export interface CompareResult {
  mergeBases: string[];
  onlyA: string[];
  onlyB: string[];
  ahead: number;
  behind: number;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  /** `null` for binary files */
  added: number | null;
  deleted: number | null;
}
