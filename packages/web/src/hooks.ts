import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogItem, RepoInfo } from '@orca-git-graph/core';
import { api, ApiError, eventsUrl, type Scope } from './api.js';

// ---- generic async ------------------------------------------------------------------

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/** Run `fn` whenever `deps` change; stale results are dropped. `fn === null` means "nothing to load". */
export function useAsync<T>(fn: (() => Promise<T>) | null, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: fn !== null });
  const gen = useRef(0);
  useEffect(() => {
    const id = ++gen.current;
    if (!fn) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    setState((s) => ({ data: s.data, error: null, loading: true }));
    fn().then(
      (data) => id === gen.current && setState({ data, error: null, loading: false }),
      (error: Error) => id === gen.current && setState({ data: null, error, loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

// ---- persisted settings -------------------------------------------------------------

export interface Settings {
  density: 'compact' | 'normal' | 'relaxed';
  dateMode: 'relative' | 'absolute';
  theme: 'system' | 'light' | 'dark';
  showLocal: boolean;
  showRemote: boolean;
  showTags: boolean;
  diffLayout: 'side-by-side' | 'line-by-line';
  fileSort: 'change' | 'path';
  detailHeight: number;
  showMinimap: boolean;
  diffMode: 'three-dot' | 'two-dot';
}

const DEFAULTS: Settings = {
  density: 'normal',
  dateMode: 'relative',
  theme: 'system',
  showLocal: true,
  showRemote: true,
  showTags: true,
  diffLayout: 'side-by-side',
  fileSort: 'change',
  detailHeight: 320,
  showMinimap: true,
  diffMode: 'three-dot',
};

const STORAGE_KEY = 'orca-git-graph:settings:v1';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* storage unavailable or corrupt: use defaults */
  }
  return DEFAULTS;
}

export function useSettings(): [Settings, <K extends keyof Settings>(key: K, value: Settings[K]) => void] {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const set = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return [settings, set];
}

// ---- repository info + live updates -----------------------------------------------

export interface RepoState {
  info: RepoInfo | null;
  error: ApiError | null;
  /** SSE connection state, for the "connection lost" banner */
  connected: boolean;
  reload: () => Promise<void>;
}

export function useRepo(enabled: boolean): RepoState {
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [connected, setConnected] = useState(true);

  const reload = useCallback(async () => {
    try {
      setInfo(await api.repo());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let stopped = false;
    let wasDisconnected = false;
    // EventSource reconnects by itself after a network drop, but gives up for good on an HTTP error (e.g. the
    // server answered 404 while still starting): reconnect manually with a growing delay in that case.
    const connect = () => {
      es = new EventSource(eventsUrl());
      es.onopen = () => {
        delay = 1000;
        setConnected(true);
        // the server may have restarted (or refs changed) while we were disconnected
        if (wasDisconnected) {
          wasDisconnected = false;
          void reload();
        }
      };
      es.onerror = () => {
        wasDisconnected = true;
        setConnected(false);
        if (es && es.readyState === EventSource.CLOSED && !stopped) {
          es.close();
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 15_000);
        }
      };
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as { type: string };
          if (msg.type === 'refs' || msg.type === 'status') void reload();
        } catch {
          /* ignore malformed event */
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [enabled, reload]);

  return { info, error, connected, reload };
}

// ---- paged log ----------------------------------------------------------------------

const PAGE = 500;

export interface LogState {
  items: LogItem[];
  total: number | null;
  hasMore: boolean;
  loading: boolean;
  error: ApiError | null;
  /** The refs revision the current `items` were loaded for (undefined until the first load finishes) */
  loadedRev: string | undefined;
  loadMore: () => Promise<void>;
  /** Load until `index` exists (or the history ends) */
  ensure: (index: number) => Promise<void>;
}

/**
 * Pages through `/api/log`. When `rev` (the refs signature) changes, the already-loaded range is
 * re-fetched in one go and swapped in at once, so scroll position and selection survive a refresh.
 */
export function useLog(enabled: boolean, rev: string | undefined, scope: Scope, onStale: () => void): LogState {
  const [state, setState] = useState<{ items: LogItem[]; next: number | null; total: number | null; loading: boolean; error: ApiError | null; loadedRev: string | undefined }>({
    loadedRev: undefined,
    items: [],
    next: 0,
    total: null,
    loading: false,
    error: null,
  });
  const ref = useRef(state);
  ref.current = state;
  const generation = useRef(0);
  const inflight = useRef<Promise<void> | null>(null);
  const scopeKey = JSON.stringify(scope);
  const lastScopeKey = useRef(scopeKey);
  const lastRev = useRef<string | undefined>(undefined);
  const staleRef = useRef(onStale);
  staleRef.current = onStale;
  const revRef = useRef(rev);
  revRef.current = rev;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const fetchPage = useCallback(async (cursor: number, limit: number) => {
    return api.log(cursor, limit, revRef.current, scopeRef.current);
  }, []);

  // reset / refresh
  useEffect(() => {
    if (!enabled || !rev) return;
    const myGen = ++generation.current;
    const scopeChanged = lastScopeKey.current !== scopeKey;
    lastScopeKey.current = scopeKey;
    const isRefresh = lastRev.current !== undefined && !scopeChanged;
    lastRev.current = rev;
    const want = isRefresh ? Math.max(PAGE, ref.current.items.length) : PAGE;
    inflight.current = null;
    setState((s) => ({ ...s, loading: true, error: null, ...(isRefresh ? {} : { items: [], next: 0, total: null }) }));
    (async () => {
      const items: LogItem[] = [];
      let next: number | null = 0;
      let total: number | null = null;
      while (next !== null && items.length < want) {
        const page = await fetchPage(next, Math.min(2000, Math.max(PAGE, want - items.length)));
        if (myGen !== generation.current) return;
        items.push(...page.items);
        next = page.nextCursor;
        total = page.total;
      }
      setState({ items, next, total, loading: false, error: null, loadedRev: rev });
    })().catch((e: unknown) => {
      if (myGen !== generation.current) return;
      const err = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      if (err.status === 409) staleRef.current();
      setState((s) => ({ ...s, loading: false, error: err }));
    });
  }, [enabled, rev, scopeKey, fetchPage]);

  const loadMore = useCallback(async () => {
    if (inflight.current) return inflight.current;
    const cur = ref.current;
    // nothing to continue from until the first page has arrived (the reset effect fetches page 0)
    if (cur.next === null || cur.items.length === 0) return;
    const myGen = generation.current;
    const cursor = cur.next;
    const p = (async () => {
      try {
        const page = await fetchPage(cursor, PAGE * 2);
        if (myGen !== generation.current) return;
        // items and the cursor must move together; a response for an outdated cursor is dropped
        setState((s) => (s.items.length === cursor ? { ...s, items: [...s.items, ...page.items], next: page.nextCursor, total: page.total, loading: false } : s));
      } catch (e) {
        if (myGen !== generation.current) return;
        const err = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
        if (err.status === 409) staleRef.current();
        setState((s) => ({ ...s, error: err }));
      }
    })().finally(() => {
      if (inflight.current === p) inflight.current = null;
    });
    inflight.current = p;
    return p;
  }, [fetchPage]);

  const ensure = useCallback(
    async (index: number) => {
      for (let guard = 0; guard < 200; guard++) {
        const cur = ref.current;
        if (cur.items.length > index || cur.next === null) return;
        await loadMore();
        // wait for React to publish the new state before re-checking
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    [loadMore],
  );

  return { items: state.items, total: state.total, hasMore: state.next !== null, loading: state.loading, error: state.error, loadedRev: state.loadedRev, loadMore, ensure };
}
