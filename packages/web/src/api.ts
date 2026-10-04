import type {
  ApiErrorBody,
  CommitDetail,
  CompareResponse,
  DiffFileResponse,
  DiffFilesResponse,
  FetchResponse,
  LogResponse,
  RepoInfo,
  RepoSummary,
  SearchResponse,
  WorktreeStatusResponse,
} from '@orca-git-graph/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
export const token = query.get('token') ?? '';
export const initialRepoId = query.get('repo') ?? '';

let repoId = initialRepoId;
export function setRepoId(id: string): void {
  repoId = id;
}
export function getRepoId(): string {
  return repoId;
}

async function request<T>(path: string, params: Record<string, string | undefined> = {}, init?: RequestInit): Promise<T> {
  const q = new URLSearchParams();
  if (repoId) q.set('repo', repoId);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, v);
  let res: Response;
  try {
    // the token goes in a header so it stays out of server logs and the Referer
    res = await fetch(`/api${path}?${q}`, { ...init, headers: { 'x-orca-git-graph-token': token } });
  } catch {
    throw new ApiError(0, 'network', 'network error');
  }
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, body?.error.code ?? 'http', body?.error.message ?? res.statusText);
  }
  return (await res.json()) as T;
}

export type Scope = { types?: string; refs?: string };

export const api = {
  repos: () => request<{ repos: RepoSummary[]; defaultId: string | null }>('/repos'),
  repo: () => request<RepoInfo>('/repo'),
  log: (cursor: number, limit: number, rev: string | undefined, scope: Scope) =>
    request<LogResponse>('/log', { cursor: String(cursor), limit: String(limit), rev, ...scope }),
  search: (q: string, rev: string | undefined, scope: Scope) => request<SearchResponse>('/search', { q, rev, ...scope }),
  commit: (sha: string) => request<CommitDetail>(`/commit/${encodeURIComponent(sha)}`),
  compare: (a: string, b: string) => request<CompareResponse>('/compare', { a, b }),
  diffFiles: (a: string | null, b: string, mode: 'three-dot' | 'two-dot') =>
    request<DiffFilesResponse>('/diff/files', { a: a ?? undefined, b, mode }),
  diffFile: (a: string | null, b: string, mode: 'three-dot' | 'two-dot', path: string, oldPath?: string) =>
    request<DiffFileResponse>('/diff/file', { a: a ?? undefined, b, mode, path, oldPath }),
  worktreeFiles: () => request<WorktreeStatusResponse>('/worktree/files'),
  worktreeDiff: (path: string, oldPath?: string) => request<DiffFileResponse>('/worktree/diff', { path, oldPath }),
  fetchRemote: () => request<FetchResponse>('/fetch', {}, { method: 'POST' }),
};

/** SSE needs the token in the URL (EventSource cannot set headers). */
export function eventsUrl(): string {
  const q = new URLSearchParams({ token });
  if (repoId) q.set('repo', repoId);
  return `/api/events?${q}`;
}
