import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Preset, RefInfo } from '@orca-git-graph/core';
import { api, ApiError, initialRepoId, setRepoId } from './api.js';
import { CommitTable, type CommitTableHandle } from './components/CommitTable.js';
import { CompareBar } from './components/CompareBar.js';
import { DetailPane, type DetailTab } from './components/DetailPane.js';
import type { Side } from './components/GraphCell.js';
import { Minimap } from './components/Minimap.js';
import type { Role } from './components/RefBadge.js';
import { Toolbar, type SearchModel } from './components/Toolbar.js';
import { useAsync, useLog, useRepo, useSettings } from './hooks.js';
import { t } from './i18n.js';

/** Stop background-loading the whole history beyond this many commits (the minimap then covers the loaded part). */
const BACKGROUND_LOAD_LIMIT = 30_000;

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function useRepoSelection(): { ready: boolean; picker: Array<{ id: string; name: string; path: string }> | null; choose: (id: string) => void; error: string | null } {
  const [ready, setReady] = useState(initialRepoId !== '');
  const [picker, setPicker] = useState<Array<{ id: string; name: string; path: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (ready) return;
    api.repos().then(
      (r) => {
        if (r.defaultId) {
          setRepoId(r.defaultId);
          setReady(true);
        } else if (r.repos.length > 0) setPicker(r.repos);
        else setError(t.noRepo);
      },
      (e: Error) => setError(e.message),
    );
  }, [ready]);
  return {
    ready,
    picker,
    error,
    choose: (id) => {
      setRepoId(id);
      setReady(true);
    },
  };
}

export function App() {
  const [settings, setSetting] = useSettings();
  const sel = useRepoSelection();
  const repo = useRepo(sel.ready);
  const { info } = repo;

  // theme
  useEffect(() => {
    const el = document.documentElement;
    if (settings.theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    if (info) document.title = `${info.name} — ${t.appTitle}`;
  }, [info?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- log ---------------------------------------------------------------------------
  const [hiddenRefs, setHiddenRefs] = useState<ReadonlySet<string>>(new Set());
  const scope = useMemo(() => {
    const types = [settings.showLocal && 'local', settings.showRemote && 'remote', settings.showTags && 'tag'].filter(Boolean) as string[];
    if (hiddenRefs.size > 0 && info) {
      // explicit ref list; HEAD is always kept so the current position stays visible
      const visible = info.refs.filter((r) => types.includes(r.type) && !hiddenRefs.has(r.fullName)).map((r) => r.fullName);
      const refs = [...visible, 'HEAD'].join(',');
      if (refs.length < 6000) return { refs };
    }
    return types.length === 3 || types.length === 0 ? {} : { types: types.join(',') };
  }, [settings.showLocal, settings.showRemote, settings.showTags, hiddenRefs, info?.refs]); // eslint-disable-line react-hooks/exhaustive-deps
  const log = useLog(!!info, info?.rev, scope, repo.reload);
  const { items } = log;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const refMap = useMemo(() => new Map<string, RefInfo>((info?.refs ?? []).map((r) => [r.fullName, r])), [info?.refs]);

  // load the rest of the history in the background (minimap, search jumps)
  useEffect(() => {
    if (!log.hasMore || log.loading || items.length >= BACKGROUND_LOAD_LIMIT || items.length === 0) return;
    const id = setTimeout(() => void log.loadMore(), 200);
    return () => clearTimeout(id);
  }, [log.hasMore, log.loading, items.length, log.loadMore]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- selection / table ---------------------------------------------------------------
  const [selected, setSelected] = useState<string | 'worktree' | null>(null);
  const [tab, setTab] = useState<DetailTab>('commit');
  const [detailHidden, setDetailHidden] = useState(false);
  const table = useRef<CommitTableHandle>(null);
  const [range, setRange] = useState({ start: 0, end: 0 });
  // Scroll anchoring: when refs change, new commits appear at the top and push everything down. Remember
  // the first visible commit while the user scrolls, and put it back in view after a refresh.
  const anchor = useRef<{ hash: string; start: number } | null>(null);
  const anchoredRev = useRef<string | undefined>(undefined);
  const revRef = useRef<string | undefined>(undefined);
  revRef.current = info?.rev;
  const onRange = useCallback((start: number, end: number) => {
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
    // while a refresh is pending (rev changed, log not swapped yet) the items under `start` are not the ones the user saw
    if (anchoredRev.current === revRef.current) {
      const h = itemsRef.current[start]?.commit.hash;
      if (h) anchor.current = { hash: h, start };
    }
  }, []);

  const select = useCallback((s: string | 'worktree') => {
    setSelected(s);
    setTab('commit');
    setDetailHidden(false);
  }, []);

  // runs once the items for a new refs revision have replaced the old ones
  useEffect(() => {
    if (log.loadedRev === undefined) return;
    if (anchoredRev.current === undefined) {
      anchoredRev.current = log.loadedRev;
      return;
    }
    if (log.loadedRev === anchoredRev.current) return;
    anchoredRev.current = log.loadedRev;
    const a = anchor.current;
    if (!a || a.start === 0) return; // at the top: stay at the top, new commits simply appear
    const idx = itemsRef.current.findIndex((i) => i.commit.hash === a.hash);
    if (idx >= 0 && idx !== a.start) requestAnimationFrame(() => table.current?.scrollByRows(idx - a.start));
  }, [log.loadedRev]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToIndex = useCallback(async (idx: number, align: 'auto' | 'center' = 'center') => {
    await log.ensure(idx);
    await nextFrame();
    await nextFrame();
    table.current?.scrollToIndex(idx, align);
  }, [log.ensure]); // eslint-disable-line react-hooks/exhaustive-deps

  const jumpToHash = useCallback(
    async (hash: string) => {
      let idx = itemsRef.current.findIndex((i) => i.commit.hash === hash);
      if (idx < 0 && info) {
        try {
          const r = await api.search(hash.slice(0, 12), info.rev, scope);
          idx = r.indices[0] ?? -1;
        } catch {
          return;
        }
        if (idx >= 0) await log.ensure(idx);
        idx = itemsRef.current.findIndex((i) => i.commit.hash === hash);
      }
      if (idx < 0) return;
      select(hash);
      await scrollToIndex(idx);
    },
    [info, scope, log.ensure, scrollToIndex, select], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const move = useCallback(
    (delta: number) => {
      const cur = itemsRef.current;
      if (cur.length === 0) return;
      const at = selected && selected !== 'worktree' ? cur.findIndex((i) => i.commit.hash === selected) : -1;
      const next = Math.max(0, Math.min(cur.length - 1, at + delta));
      const h = cur[next]?.commit.hash;
      if (h) {
        select(h);
        table.current?.scrollToIndex(next, 'auto');
      }
    },
    [selected, select],
  );

  // ---- compare -------------------------------------------------------------------------
  const [compareOn, setCompareOn] = useState(false);
  const [cmpA, setCmpA] = useState<string | null>(null);
  const [cmpB, setCmpB] = useState<string | null>(null);
  const compareSpec = compareOn && cmpA && cmpB ? { a: cmpA, b: cmpB, mode: settings.diffMode } : null;
  const cmp = useAsync(compareSpec ? () => api.compare(cmpA!, cmpB!) : null, [cmpA, cmpB, compareOn, info?.rev]);
  const sets = useMemo(() => {
    const d = cmp.data;
    if (!d) return null;
    return { a: new Set(d.onlyA), b: new Set(d.onlyB), base: new Set(d.mergeBases) };
  }, [cmp.data]);
  const sideOf = useCallback(
    (hash: string): Side | null => {
      if (!sets) return null;
      if (sets.base.has(hash)) return 'base';
      if (sets.a.has(hash)) return 'A';
      if (sets.b.has(hash)) return 'B';
      return 'common';
    },
    [sets],
  );
  // when a comparison result arrives, bring its commits into view
  useEffect(() => {
    if (!sets) return;
    const idx = itemsRef.current.findIndex((i) => sets.a.has(i.commit.hash) || sets.b.has(i.commit.hash) || sets.base.has(i.commit.hash));
    if (idx < 0) return;
    const id = requestAnimationFrame(() => (idx <= 1 ? table.current?.scrollByRows(-1_000_000) : table.current?.scrollToIndex(idx - 1, 'start')));
    return () => cancelAnimationFrame(id);
  }, [sets]);
  const roleOf = useCallback((name: string): Role => (compareOn ? (name === cmpA ? 'A' : name === cmpB ? 'B' : null) : null), [compareOn, cmpA, cmpB]);

  const applyPreset = useCallback((p: Preset) => {
    setCompareOn(true);
    setCmpA(p.a);
    setCmpB(p.b);
    setTab('compare');
    setDetailHidden(false);
  }, []);

  const toggleCompare = useCallback(() => {
    if (compareOn) {
      setCompareOn(false);
      setCmpA(null);
      setCmpB(null);
      setTab('commit');
      return;
    }
    setCompareOn(true);
    const first = info?.presets[0];
    if (first) applyPreset(first);
    else {
      setCmpA(info?.head.branch ?? 'HEAD');
      setCmpB(null);
    }
  }, [compareOn, info, applyPreset]);

  const pickRef = useCallback(
    (name: string) => {
      if (!compareOn) {
        setCompareOn(true);
        setCmpA(name);
        setCmpB(null);
      } else if (!cmpA) setCmpA(name);
      else if (!cmpB) {
        setCmpB(name);
        setTab('compare');
        setDetailHidden(false);
      } else {
        setCmpA(name);
        setCmpB(null);
      }
    },
    [compareOn, cmpA, cmpB],
  );

  // ---- search --------------------------------------------------------------------------
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; indices: number[]; truncated: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const matchSet = useMemo(() => new Set(found?.indices ?? []), [found]);

  const gotoMatch = useCallback(
    async (i: number, indices: number[]) => {
      const idx = indices[i];
      if (idx === undefined) return;
      setActive(i);
      await log.ensure(idx);
      const h = itemsRef.current[idx]?.commit.hash;
      if (h) select(h);
      await scrollToIndex(idx);
    },
    [log.ensure, scrollToIndex, select], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // `text` is the input's current value: the `query` state can lag one render behind a fast "type, Enter"
  const runSearch = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || !info) return setFound(null);
    try {
      const r = await api.search(q, info.rev, scope);
      setFound({ q, indices: r.indices, truncated: r.truncated });
      if (r.indices.length > 0) await gotoMatch(0, r.indices);
    } catch {
      setFound({ q, indices: [], truncated: false });
    }
  }, [info, scope, gotoMatch]);

  const stepMatch = useCallback(
    (dir: 1 | -1) => {
      if (!found || found.indices.length === 0) return;
      void gotoMatch((active + dir + found.indices.length) % found.indices.length, found.indices);
    },
    [found, active, gotoMatch],
  );

  // stale results after the refs changed
  useEffect(() => setFound(null), [info?.rev, scope]);
  useEffect(() => {
    if (query.trim() === '') setFound(null);
  }, [query]);

  const searchModel: SearchModel = {
    query,
    setQuery,
    enter: (shift, text) => (found && found.q === text.trim() ? stepMatch(shift ? -1 : 1) : void runSearch(text)),
    matches: found?.indices.length ?? 0,
    active,
    truncated: found?.truncated ?? false,
    searched: found !== null,
    next: () => stepMatch(1),
    prev: () => stepMatch(-1),
    inputRef: searchInput,
  };

  // ---- fetch ---------------------------------------------------------------------------
  const [fetchState, setFetchState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [fetchMessage, setFetchMessage] = useState('');
  const onFetch = useCallback(async () => {
    setFetchState('running');
    try {
      const r = await api.fetchRemote();
      setFetchState(r.ok ? 'done' : 'failed');
      setFetchMessage(r.ok ? t.fetchDone : `${t.fetchFailed}: ${r.output}`);
      await repo.reload();
    } catch (e) {
      setFetchState('failed');
      setFetchMessage(`${t.fetchFailed}: ${(e as Error).message}`);
    }
    setTimeout(() => setFetchState((s) => (s === 'running' ? s : 'idle')), 6000);
  }, [repo]);

  // ---- keyboard ------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === 'Escape') {
        if (typing) (el as HTMLElement).blur();
        if (found) setFound(null);
        else if (compareOn) toggleCompare();
        else setSelected(null);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowDown':
        case 'j':
          e.preventDefault();
          return move(1);
        case 'ArrowUp':
        case 'k':
          e.preventDefault();
          return move(-1);
        case 'Home':
          e.preventDefault();
          return move(-1_000_000);
        case 'Enter':
          return setDetailHidden((h) => !h);
        case '/':
          e.preventDefault();
          return searchInput.current?.focus();
        case 'n':
          return stepMatch(1);
        case 'N':
          return stepMatch(-1);
        case 'c':
          return toggleCompare();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, stepMatch, toggleCompare, found, compareOn]);

  // opening the detail pane shrinks the table: keep the selected row visible
  const detailOpen = !detailHidden && (selected !== null || compareSpec !== null);
  useEffect(() => {
    if (!detailOpen || !selected || selected === 'worktree') return;
    const idx = itemsRef.current.findIndex((i) => i.commit.hash === selected);
    if (idx < 0) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => table.current?.scrollToIndex(idx, 'auto')));
    return () => cancelAnimationFrame(id);
  }, [detailOpen, selected, settings.detailHeight]);

  // ---- render --------------------------------------------------------------------------
  if (sel.picker) {
    return (
      <div className="center-message">
        <h2>{t.pickRepo}</h2>
        <ul className="repo-picker">
          {sel.picker.map((r) => (
            <li key={r.id}>
              <button type="button" className="chip-btn" onClick={() => sel.choose(r.id)}>
                {r.name} <span className="muted">{r.path}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (sel.error) return <div className="center-message error">{sel.error}</div>;
  if (repo.error && !info) return <ErrorScreen error={repo.error} retry={repo.reload} />;
  if (!info) return <div className="center-message">{t.loading}</div>;

  const showDetail = !detailHidden && (selected !== null || compareSpec !== null);
  const noCommits = info.head.hash === null && items.length === 0 && !log.loading;

  return (
    <div className="app">
      {!repo.connected && (
        <div className="banner error" role="alert">
          {t.connectionLost} <button type="button" className="chip-btn" onClick={() => void repo.reload()}>{t.retry}</button>
        </div>
      )}
      <Toolbar
        info={info}
        search={searchModel}
        fetchState={fetchState}
        fetchMessage={fetchMessage}
        onFetch={onFetch}
        compareActive={compareOn}
        onToggleCompare={toggleCompare}
        settings={settings}
        setSetting={setSetting}
        refs={info.refs}
        hiddenRefs={hiddenRefs}
        onHiddenRefs={setHiddenRefs}
      />
      {compareOn && (
        <CompareBar
          refs={info.refs}
          presets={info.presets}
          a={cmpA}
          b={cmpB}
          onA={setCmpA}
          onB={(v) => {
            setCmpB(v);
            if (v) setTab('compare');
          }}
          onSwap={() => {
            setCmpA(cmpB);
            setCmpB(cmpA);
          }}
          onPreset={applyPreset}
          onClear={toggleCompare}
          mode={settings.diffMode}
          onMode={(m) => setSetting('diffMode', m)}
          result={cmp.data}
          loading={cmp.loading}
          error={cmp.error}
          onJump={(h) => void jumpToHash(h)}
        />
      )}
      <main className="main">
        {noCommits ? (
          <div className="center-message">{t.emptyRepo}</div>
        ) : (
          <>
            <CommitTable
              tableRef={table}
              items={items}
              hasMore={log.hasMore}
              loadMore={() => void log.loadMore()}
              refMap={refMap}
              headHash={info.head.hash}
              density={settings.density}
              dateMode={settings.dateMode}
              selected={selected}
              onSelect={select}
              uncommitted={info.dirty.changed + info.dirty.untracked > 0 ? info.dirty : null}
              sideOf={sideOf}
              roleOf={roleOf}
              onPickRef={pickRef}
              matchSet={matchSet}
              activeMatch={found && found.indices.length > 0 ? (found.indices[active] ?? null) : null}
              onRangeChange={onRange}
            />
            {settings.showMinimap && (
              <Minimap items={items} total={log.total} sideOf={sideOf} range={range} compareActive={compareSpec !== null} onSeek={(i) => void scrollToIndex(i, 'auto')} />
            )}
          </>
        )}
        {log.error && log.error.status !== 409 && <div className="banner error floating">{log.error.message}</div>}
      </main>
      {showDetail && (
        <DetailPane
          selected={selected}
          compare={compareSpec}
          tab={tab}
          onTab={setTab}
          settings={settings}
          setSetting={setSetting}
          dirtyKey={`${info.dirty.changed}:${info.dirty.untracked}:${info.rev}`}
          refMap={refMap}
          onJump={(h) => void jumpToHash(h)}
          onClose={() => {
            setDetailHidden(true);
          }}
        />
      )}
      <footer className="statusbar">{t.shortcuts}</footer>
    </div>
  );
}

function ErrorScreen({ error, retry }: { error: ApiError; retry: () => Promise<void> }) {
  const message =
    error.code === 'remote_worktree' ? t.remoteWorktree : error.status === 0 || error.status === 401 ? t.connectionLost : error.message;
  return (
    <div className="center-message error">
      <p>{message}</p>
      {error.status !== 422 && (
        <button type="button" className="chip-btn" onClick={() => void retry()}>
          {t.retry}
        </button>
      )}
    </div>
  );
}
