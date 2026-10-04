import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangedFile, DiffFileResponse, RefInfo } from '@orca-git-graph/core';
import { api } from '../api.js';
import { formatAbsolute, shortHash } from '../format.js';
import { useAsync, type Settings } from '../hooks.js';
import { t } from '../i18n.js';
import { DiffView } from './DiffView.js';
import { fileKey, FileList, sortFiles } from './FileList.js';
import { CloseIcon } from './Icons.js';
import { groupRefs, RefBadge } from './RefBadge.js';

export interface CompareSpec {
  a: string;
  b: string;
  mode: 'three-dot' | 'two-dot';
}

export type DetailTab = 'commit' | 'compare';

export interface DetailPaneProps {
  /** Commit hash, `'worktree'` for uncommitted changes, or null */
  selected: string | 'worktree' | null;
  compare: CompareSpec | null;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  settings: Settings;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  /** Changes when the working tree changes, to reload the uncommitted file list */
  dirtyKey: string;
  refMap: ReadonlyMap<string, RefInfo>;
  onJump: (hash: string) => void;
  onClose: () => void;
}

export function DetailPane(props: DetailPaneProps) {
  const { selected, compare, settings } = props;
  const showCompare = compare !== null && (props.tab === 'compare' || selected === null);
  const hasCommit = selected !== null;

  return (
    <section className="detail" aria-label="detail" style={{ height: settings.detailHeight }}>
      <Resizer height={settings.detailHeight} onChange={(h) => props.setSetting('detailHeight', h)} />
      <header className="detail-head">
        <div className="tabs" role="tablist">
          {hasCommit && (
            <button type="button" role="tab" aria-selected={!showCompare} className={!showCompare ? 'on' : ''} onClick={() => props.onTab('commit')}>
              {t.commitTab}
            </button>
          )}
          {compare && (
            <button type="button" role="tab" aria-selected={showCompare} className={showCompare ? 'on' : ''} onClick={() => props.onTab('compare')}>
              {t.compareTab}
            </button>
          )}
        </div>
        <span className="spacer" />
        <span className="seg" title="diff layout">
          <button type="button" className={settings.diffLayout === 'side-by-side' ? 'on' : ''} onClick={() => props.setSetting('diffLayout', 'side-by-side')}>
            {t.diffSideBySide}
          </button>
          <button type="button" className={settings.diffLayout === 'line-by-line' ? 'on' : ''} onClick={() => props.setSetting('diffLayout', 'line-by-line')}>
            {t.diffInline}
          </button>
        </span>
        <button type="button" className="icon-btn" onClick={props.onClose} title={t.close} aria-label={t.close}>
          <CloseIcon />
        </button>
      </header>
      {showCompare && compare ? (
        <CompareDetail {...props} compare={compare} />
      ) : selected === 'worktree' ? (
        <WorktreeDetail {...props} />
      ) : selected ? (
        <CommitDetailView {...props} hash={selected} />
      ) : (
        <div className="pane-empty">{t.selectCommit}</div>
      )}
    </section>
  );
}

function Resizer({ height, onChange }: { height: number; onChange: (h: number) => void }) {
  const drag = useRef<{ y: number; h: number } | null>(null);
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="horizontal"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, h: height };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const max = Math.max(200, window.innerHeight - 160);
        onChange(Math.min(max, Math.max(140, drag.current.h + (drag.current.y - e.clientY))));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
    />
  );
}

interface FilesPaneProps {
  files: ChangedFile[] | null;
  error: Error | null;
  settings: Settings;
  setSetting: DetailPaneProps['setSetting'];
  /** Reset the selected file when this changes */
  resetKey: string;
  loadDiff: (f: ChangedFile) => Promise<DiffFileResponse>;
  header?: React.ReactNode;
}

function FilesAndDiff({ files, error, settings, setSetting, resetKey, loadDiff, header }: FilesPaneProps) {
  const [selKey, setSelKey] = useState<string | null>(null);
  // select the first file (in display order) whenever the file set changes
  useEffect(() => {
    if (!files || files.length === 0) return setSelKey(null);
    setSelKey(fileKey(sortFiles(files, settings.fileSort)[0]!));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, resetKey]);
  const selected = useMemo(() => files?.find((f) => fileKey(f) === selKey) ?? null, [files, selKey]);

  return (
    <div className="detail-body">
      <aside className="detail-side">
        {header}
        {error ? (
          <div className="pane-empty error">{error.message}</div>
        ) : !files ? (
          <div className="pane-empty">{t.loading}</div>
        ) : files.length === 0 ? (
          <div className="pane-empty">{t.noChanges}</div>
        ) : (
          <FileList files={files} selectedKey={selKey} onSelect={(f) => setSelKey(fileKey(f))} sort={settings.fileSort} onSort={(s) => setSetting('fileSort', s)} />
        )}
      </aside>
      <div className="detail-diff">
        <DiffView load={selected ? () => loadDiff(selected) : null} deps={[selKey, resetKey]} layout={settings.diffLayout} theme={settings.theme} />
      </div>
    </div>
  );
}

function CommitDetailView({ hash, settings, setSetting, refMap, onJump }: DetailPaneProps & { hash: string }) {
  const state = useAsync(() => api.commit(hash), [hash]);
  const d = state.data;
  const [copied, setCopied] = useState(false);
  const badges = useMemo(() => {
    const refs = [...refMap.values()].filter((r) => r.hash === hash);
    return groupRefs(refs);
  }, [refMap, hash]);

  const header = d && (
    <div className="commit-meta">
      <h3 className="commit-subject">{d.commit.subject}</h3>
      <div className="meta-line">
        <code className="mono">{shortHash(d.commit.hash)}</code>
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            navigator.clipboard?.writeText(d.commit.hash).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              },
              () => undefined,
            );
          }}
        >
          {copied ? t.copied : t.copy}
        </button>
        <span className="muted">
          {d.commit.authorName} · {formatAbsolute(d.commit.timestamp)}
        </span>
      </div>
      {d.committerName !== d.commit.authorName && (
        <div className="meta-line muted">
          {t.committer}: {d.committerName}
        </div>
      )}
      {d.commit.parents.length > 0 && (
        <div className="meta-line">
          <span className="muted">{t.parents}:</span>
          {d.commit.parents.map((p) => (
            <button type="button" key={p} className="link-btn mono" onClick={() => onJump(p)}>
              {shortHash(p)}
            </button>
          ))}
        </div>
      )}
      {badges.length > 0 && (
        <div className="meta-line">
          {badges.map((b) => (
            <RefBadge key={b.ref.fullName} model={b} role={() => null} onPick={() => undefined} />
          ))}
        </div>
      )}
      {d.body.trim() !== d.commit.subject && <pre className="commit-body">{d.body.slice(d.commit.subject.length).trim()}</pre>}
    </div>
  );

  return (
    <FilesAndDiff
      files={d?.files ?? null}
      error={state.error}
      settings={settings}
      setSetting={setSetting}
      resetKey={hash}
      loadDiff={(f) => api.diffFile(d!.base, hash, 'two-dot', f.path, f.oldPath)}
      header={header}
    />
  );
}

function WorktreeDetail({ settings, setSetting, dirtyKey }: DetailPaneProps) {
  const state = useAsync(() => api.worktreeFiles(), [dirtyKey]);
  return (
    <FilesAndDiff
      files={state.data?.files ?? null}
      error={state.error}
      settings={settings}
      setSetting={setSetting}
      resetKey="worktree"
      loadDiff={(f) => api.worktreeDiff(f.path, f.oldPath)}
      header={<div className="commit-meta"><h3 className="commit-subject">{t.uncommitted}</h3></div>}
    />
  );
}

function CompareDetail({ compare, settings, setSetting }: DetailPaneProps & { compare: CompareSpec }) {
  const { a, b, mode } = compare;
  const state = useAsync(() => api.diffFiles(a, b, mode), [a, b, mode]);
  return (
    <FilesAndDiff
      files={state.data?.files ?? null}
      error={state.error}
      settings={settings}
      setSetting={setSetting}
      resetKey={`${a}|${b}|${mode}`}
      loadDiff={(f) => api.diffFile(a, b, mode, f.path, f.oldPath)}
      header={
        <div className="commit-meta">
          <h3 className="commit-subject">
            <span className="side-chip side-chip-A">A</span> {a} <span className="muted">{mode === 'three-dot' ? '…' : '↔'}</span> <span className="side-chip side-chip-B">B</span> {b}
          </h3>
          <div className="meta-line muted">{mode === 'three-dot' ? t.threeDot : t.twoDot}</div>
        </div>
      }
    />
  );
}
