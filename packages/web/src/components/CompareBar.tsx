import type { CompareResponse, Preset, RefInfo } from '@orca-git-graph/core';
import { num, shortHash } from '../format.js';
import { t } from '../i18n.js';
import { CloseIcon, DownIcon, SwapIcon, UpIcon } from './Icons.js';

export interface CompareBarProps {
  refs: readonly RefInfo[];
  presets: readonly Preset[];
  a: string | null;
  b: string | null;
  onA: (v: string | null) => void;
  onB: (v: string | null) => void;
  onSwap: () => void;
  onPreset: (p: Preset) => void;
  onClear: () => void;
  mode: 'three-dot' | 'two-dot';
  onMode: (m: 'three-dot' | 'two-dot') => void;
  result: CompareResponse | null;
  loading: boolean;
  error: Error | null;
  onJump: (hash: string) => void;
}

function RefSelect({ refs, value, onChange, label, side }: { refs: readonly RefInfo[]; value: string | null; onChange: (v: string | null) => void; label: string; side: 'A' | 'B' }) {
  const group = (type: RefInfo['type'], title: string) => {
    const list = refs.filter((r) => r.type === type);
    if (list.length === 0) return null;
    return (
      <optgroup label={title}>
        {list.map((r) => (
          <option key={r.fullName} value={r.name}>
            {r.name}
          </option>
        ))}
      </optgroup>
    );
  };
  return (
    <label className={`ref-select ref-select-${side}`}>
      <span className={`side-chip side-chip-${side}`}>{side}</span>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={label}>
        <option value="">{label}</option>
        <option value="HEAD">HEAD</option>
        {group('local', t.showLocal)}
        {group('remote', t.showRemote)}
        {group('tag', t.showTags)}
      </select>
    </label>
  );
}

export function CompareBar(p: CompareBarProps) {
  const r = p.result;
  return (
    <div className="comparebar">
      <div className="comparebar-controls">
        <RefSelect refs={p.refs} value={p.a} onChange={p.onA} label={t.comparePickA} side="A" />
        <button type="button" className="icon-btn" onClick={p.onSwap} title={t.compareSwap} aria-label={t.compareSwap} disabled={!p.a && !p.b}>
          <SwapIcon />
        </button>
        <RefSelect refs={p.refs} value={p.b} onChange={p.onB} label={t.comparePickB} side="B" />
        <span className="seg" role="group" aria-label="diff mode">
          <button type="button" className={p.mode === 'three-dot' ? 'on' : ''} onClick={() => p.onMode('three-dot')} title={t.threeDot}>
            A…B
          </button>
          <button type="button" className={p.mode === 'two-dot' ? 'on' : ''} onClick={() => p.onMode('two-dot')} title={t.twoDot}>
            A↔B
          </button>
        </span>
        {p.presets.length > 0 && (
          <span className="presets" role="group" aria-label={t.comparePresets}>
            {p.presets.map((preset) => (
              <button type="button" key={preset.id} className="chip-btn" onClick={() => p.onPreset(preset)}>
                {preset.label}
              </button>
            ))}
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="chip-btn" onClick={p.onClear}>
          <CloseIcon /> {t.compareClear}
        </button>
      </div>

      {!p.a || !p.b ? (
        <div className="compare-hint">{t.compareHint}</div>
      ) : p.error ? (
        <div className="compare-hint error">{p.error.message}</div>
      ) : r ? (
        <div className="compare-summary" aria-live="polite">
          <div className="compare-sentence">{t.aheadBehind(p.a, p.b, r.ahead, r.behind)}</div>
          <div className="compare-numbers">
            <span className="big big-ahead" title={t.ahead}>
              <UpIcon width={18} height={18} />
              {num(r.ahead)}
            </span>
            <span className="big big-behind" title={t.behind}>
              <DownIcon width={18} height={18} />
              {num(r.behind)}
            </span>
          </div>
          <div className="legend">
            <span><i className="lg lg-A" /> {t.onlyInA}</span>
            <span><i className="lg lg-B" /> {t.onlyInB}</span>
            <span><i className="lg lg-base" /> {t.mergeBase}</span>
            <span><i className="lg lg-common" /> {t.commonHistory}</span>
          </div>
          <div className="compare-base">
            {r.mergeBases.length === 0 ? (
              <span className="muted">{t.unrelated}</span>
            ) : (
              <>
                <span className="muted">{t.mergeBase}:</span>
                {r.mergeBases.map((h) => (
                  <button type="button" key={h} className="link-btn mono" onClick={() => p.onJump(h)}>
                    {shortHash(h)}
                  </button>
                ))}
              </>
            )}
            {r.truncated && <span className="muted"> · {t.truncated}</span>}
          </div>
        </div>
      ) : (
        <div className="compare-hint">{p.loading ? t.loading : ''}</div>
      )}
    </div>
  );
}
