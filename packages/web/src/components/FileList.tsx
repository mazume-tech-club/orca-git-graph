import { useMemo } from 'react';
import type { ChangedFile } from '@orca-git-graph/core';
import { num } from '../format.js';
import { t } from '../i18n.js';

const STATUS_LABEL: Record<string, () => string> = {
  A: () => t.statusAdded,
  M: () => t.statusModified,
  D: () => t.statusDeleted,
  R: () => t.statusRenamed,
};

export type FileSort = 'change' | 'path';

export function fileKey(f: ChangedFile): string {
  return `${f.oldPath ?? ''}\0${f.path}`;
}

export function sortFiles(files: readonly ChangedFile[], sort: FileSort): ChangedFile[] {
  const size = (f: ChangedFile) => (f.added ?? 0) + (f.deleted ?? 0);
  const copy = [...files];
  if (sort === 'path') copy.sort((a, b) => a.path.localeCompare(b.path));
  else copy.sort((a, b) => size(b) - size(a) || a.path.localeCompare(b.path));
  return copy;
}

export interface FileListProps {
  files: readonly ChangedFile[];
  selectedKey: string | null;
  onSelect: (f: ChangedFile) => void;
  sort: FileSort;
  onSort: (s: FileSort) => void;
}

/** File list with a bar per file: green = added lines, red = deleted lines, length = share of the largest change. */
export function FileList({ files, selectedKey, onSelect, sort, onSort }: FileListProps) {
  const sorted = useMemo(() => sortFiles(files, sort), [files, sort]);
  const max = useMemo(() => Math.max(1, ...files.map((f) => (f.added ?? 0) + (f.deleted ?? 0))), [files]);
  const totals = useMemo(
    () => files.reduce((acc, f) => ({ a: acc.a + (f.added ?? 0), d: acc.d + (f.deleted ?? 0) }), { a: 0, d: 0 }),
    [files],
  );
  return (
    <div className="filelist">
      <div className="filelist-head">
        <span>
          {t.changedFiles(files.length)} <span className="added">+{num(totals.a)}</span> <span className="deleted">−{num(totals.d)}</span>
        </span>
        <span className="seg">
          <button type="button" className={sort === 'change' ? 'on' : ''} onClick={() => onSort('change')}>
            {t.sortByChange}
          </button>
          <button type="button" className={sort === 'path' ? 'on' : ''} onClick={() => onSort('path')}>
            {t.sortByPath}
          </button>
        </span>
      </div>
      <ul role="listbox" aria-label={t.files}>
        {sorted.map((f) => {
          const size = (f.added ?? 0) + (f.deleted ?? 0);
          const pct = f.added === null ? 8 : Math.max(size === 0 ? 0 : 3, (size / max) * 100);
          const addPct = size === 0 ? 0 : ((f.added ?? 0) / size) * 100;
          const key = fileKey(f);
          const slash = f.path.lastIndexOf('/');
          return (
            <li key={key} role="option" aria-selected={key === selectedKey} className={key === selectedKey ? 'selected' : ''} onClick={() => onSelect(f)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
              <span className={`status status-${f.status}`} title={STATUS_LABEL[f.status]?.() ?? f.status}>
                {f.status}
              </span>
              <span className="path">
                <span className="dir">{slash >= 0 ? f.path.slice(0, slash + 1) : ''}</span>
                <span className="name">{slash >= 0 ? f.path.slice(slash + 1) : f.path}</span>
              </span>
              <span className="bar" aria-hidden="true">
                <span className="bar-fill" style={{ width: `${pct}%` }}>
                  <span className="bar-add" style={{ width: f.added === null ? '100%' : `${addPct}%` }} />
                </span>
              </span>
              <span className="counts">
                {f.added === null ? (
                  <span className="muted">bin</span>
                ) : (
                  <>
                    <span className="added">+{num(f.added)}</span> <span className="deleted">−{num(f.deleted ?? 0)}</span>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
