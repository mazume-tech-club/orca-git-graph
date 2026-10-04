import { useState } from 'react';
import type { RefInfo, RepoInfo } from '@orca-git-graph/core';
import type { Settings } from '../hooks.js';
import { t } from '../i18n.js';
import { shortHash } from '../format.js';
import { CompareIcon, DownIcon, FilterIcon, RefreshIcon, SearchIcon, SettingsIcon, UpIcon } from './Icons.js';
import { Popover } from './Popover.js';

export interface SearchModel {
  query: string;
  setQuery: (q: string) => void;
  /** Enter / Shift+Enter in the box: run the search, or step through matches when it is already run */
  enter: (shift: boolean) => void;
  matches: number;
  active: number;
  truncated: boolean;
  searched: boolean;
  next: () => void;
  prev: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export interface ToolbarProps {
  info: RepoInfo;
  search: SearchModel;
  fetchState: 'idle' | 'running' | 'done' | 'failed';
  fetchMessage: string;
  onFetch: () => void;
  compareActive: boolean;
  onToggleCompare: () => void;
  settings: Settings;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  refs: readonly RefInfo[];
  hiddenRefs: ReadonlySet<string>;
  onHiddenRefs: (s: ReadonlySet<string>) => void;
}

function RefFilter({ refs, hidden, onChange }: { refs: readonly RefInfo[]; hidden: ReadonlySet<string>; onChange: (s: ReadonlySet<string>) => void }) {
  const [q, setQ] = useState('');
  const list = refs.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
  const toggle = (full: string, on: boolean) => {
    const next = new Set(hidden);
    if (on) next.delete(full);
    else next.add(full);
    onChange(next);
  };
  return (
    <div className="ref-filter">
      <div className="ref-filter-head">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.filterRefs} aria-label={t.filterRefs} />
        <button type="button" className="link-btn" onClick={() => onChange(new Set())} disabled={hidden.size === 0}>
          {t.showAll}
        </button>
      </div>
      <ul>
        {list.map((r) => (
          <li key={r.fullName}>
            <label className="check">
              <input type="checkbox" checked={!hidden.has(r.fullName)} onChange={(e) => toggle(r.fullName, e.target.checked)} />
              <span className={`ref-type ref-type-${r.type}`}>{r.type === 'local' ? 'L' : r.type === 'remote' ? 'R' : 'T'}</span> {r.name}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

function Radios<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="radio-group" role="radiogroup" aria-label={label}>
      <div className="radio-label">{label}</div>
      <div className="seg">
        {options.map(([v, text]) => (
          <button type="button" key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toolbar({ info, search, fetchState, fetchMessage, onFetch, compareActive, onToggleCompare, settings, setSetting, refs, hiddenRefs, onHiddenRefs }: ToolbarProps) {
  const visibleCount = [settings.showLocal, settings.showRemote, settings.showTags].filter(Boolean).length;
  const filtered = visibleCount < 3 || hiddenRefs.size > 0;
  return (
    <header className="toolbar">
      <div className="repo-title">
        <strong className="repo-name" title={info.path}>
          {info.name}
        </strong>
        <span className="head-label" title={info.head.detached ? t.detached : undefined}>
          {info.head.detached ? `HEAD ${shortHash(info.head.hash ?? '')}` : (info.head.branch ?? '—')}
        </span>
      </div>

      <div className="search">
        <SearchIcon />
        <input
          ref={search.inputRef}
          type="search"
          value={search.query}
          placeholder={t.search}
          aria-label={t.search}
          onChange={(e) => search.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.nativeEvent.isComposing) return; // Enter that confirms an IME conversion
              search.enter(e.shiftKey);
            }
          }}
        />
        {search.searched && (
          <span className="search-count" aria-live="polite">
            {search.matches === 0 ? t.searchNone : t.searchCount(search.active + 1, search.matches, search.truncated)}
          </span>
        )}
        <button type="button" className="icon-btn" onClick={search.prev} disabled={search.matches === 0} aria-label="prev" title="Shift+Enter">
          <UpIcon />
        </button>
        <button type="button" className="icon-btn" onClick={search.next} disabled={search.matches === 0} aria-label="next" title="Enter">
          <DownIcon />
        </button>
      </div>

      <span className="spacer" />

      <button type="button" className={`tool-btn${compareActive ? ' on' : ''}`} onClick={onToggleCompare} aria-pressed={compareActive} title={`${t.compareStart} (c)`}>
        <CompareIcon /> <span className="tool-label">{t.compare}</span>
      </button>

      <Popover label={t.filter} button={<><FilterIcon /> <span className="tool-label">{t.filter}</span>{filtered && <span className="dot-indicator" />}</>} align="right">
        <Check checked={settings.showLocal} onChange={(v) => setSetting('showLocal', v)} label={t.showLocal} disabled={settings.showLocal && visibleCount === 1} />
        <Check checked={settings.showRemote} onChange={(v) => setSetting('showRemote', v)} label={t.showRemote} disabled={settings.showRemote && visibleCount === 1} />
        <Check checked={settings.showTags} onChange={(v) => setSetting('showTags', v)} label={t.showTags} disabled={settings.showTags && visibleCount === 1} />
        <RefFilter refs={refs} hidden={hiddenRefs} onChange={onHiddenRefs} />
      </Popover>

      <Popover label={t.density} button={<SettingsIcon />} align="right">
        <Radios
          label={t.density}
          value={settings.density}
          onChange={(v) => setSetting('density', v)}
          options={[
            ['compact', t.densityCompact],
            ['normal', t.densityNormal],
            ['relaxed', t.densityRelaxed],
          ]}
        />
        <Radios
          label={t.columnDate}
          value={settings.dateMode}
          onChange={(v) => setSetting('dateMode', v)}
          options={[
            ['relative', t.dateRelative],
            ['absolute', t.dateAbsolute],
          ]}
        />
        <Radios
          label={t.theme}
          value={settings.theme}
          onChange={(v) => setSetting('theme', v)}
          options={[
            ['system', t.themeSystem],
            ['light', t.themeLight],
            ['dark', t.themeDark],
          ]}
        />
        <Check checked={settings.showMinimap} onChange={(v) => setSetting('showMinimap', v)} label={t.minimap} />
      </Popover>

      <button type="button" className="tool-btn" onClick={onFetch} disabled={fetchState === 'running'} title={fetchMessage || t.fetch}>
        <RefreshIcon className={fetchState === 'running' ? 'spin' : undefined} />
        <span className="tool-label">{fetchState === 'running' ? t.fetching : t.fetch}</span>
        {fetchState === 'done' && <span className="ok-mark">✓</span>}
        {fetchState === 'failed' && <span className="err-mark">!</span>}
      </button>
    </header>
  );
}
