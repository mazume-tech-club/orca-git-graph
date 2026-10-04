import { memo, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LogItem, RefInfo } from '@orca-git-graph/core';
import { formatAbsolute, formatDate, shortHash, type DateMode } from '../format.js';
import { t } from '../i18n.js';
import { GRAPH_PAD, GraphCell, UncommittedDot, type Side } from './GraphCell.js';
import { groupRefs, RefBadge, type Role } from './RefBadge.js';

export type Density = 'compact' | 'normal' | 'relaxed';

export const ROW_HEIGHT: Record<Density, number> = { compact: 24, normal: 30, relaxed: 38 };
const LANE_WIDTH: Record<Density, number> = { compact: 12, normal: 14, relaxed: 16 };
const MAX_LANES = 18;

export interface CommitTableHandle {
  scrollToIndex: (index: number, align?: 'auto' | 'center' | 'start') => void;
  /** Scroll by whole rows, keeping the sub-row offset (used to hold the view still when rows are inserted above it) */
  scrollByRows: (rows: number) => void;
  /** Visible commit index range (without the uncommitted row) */
  getRange: () => { start: number; end: number };
}

export interface CommitTableProps {
  items: LogItem[];
  hasMore: boolean;
  loadMore: () => void;
  refMap: ReadonlyMap<string, RefInfo>;
  headHash: string | null;
  density: Density;
  dateMode: DateMode;
  selected: string | 'worktree' | null;
  onSelect: (sel: string | 'worktree') => void;
  uncommitted: { changed: number; untracked: number } | null;
  sideOf: (hash: string) => Side | null;
  roleOf: (refName: string) => Role;
  onPickRef: (name: string) => void;
  matchSet: ReadonlySet<number>;
  activeMatch: number | null;
  onRangeChange?: (start: number, end: number) => void;
  tableRef?: Ref<CommitTableHandle>;
}

interface RowProps {
  item: LogItem;
  index: number;
  top: number;
  height: number;
  laneW: number;
  graphW: number;
  graphLanes: number;
  refMap: ReadonlyMap<string, RefInfo>;
  isHead: boolean;
  selected: boolean;
  side: Side | null;
  matched: boolean;
  active: boolean;
  dateMode: DateMode;
  now: number;
  roleOf: (n: string) => Role;
  onPickRef: (n: string) => void;
  onSelect: (hash: string) => void;
}

const Row = memo(function Row(p: RowProps) {
  const { item, side } = p;
  const refs = useMemo(() => item.refs.map((n) => p.refMap.get(n)).filter((r): r is RefInfo => !!r), [item.refs, p.refMap]);
  const badges = useMemo(() => groupRefs(refs), [refs]);
  const c = item.commit;
  return (
    <div
      className={`row${p.selected ? ' selected' : ''}${p.matched ? ' matched' : ''}${p.active ? ' match-active' : ''}`}
      data-side={side ?? undefined}
      data-hash={c.hash}
      role="row"
      aria-selected={p.selected}
      style={{ transform: `translateY(${p.top}px)`, height: p.height }}
      onClick={() => p.onSelect(c.hash)}
    >
      <div className="cell cell-graph" role="gridcell">
        <GraphCell row={item.row} height={p.height} laneW={p.laneW} width={p.graphW} isHead={p.isHead} isMerge={c.parents.length > 1} side={side} />
        {side && side !== 'common' && side !== 'other' && <span className={`side-tag side-tag-${side}`}>{side === 'base' ? '◆' : side}</span>}
      </div>
      <div className="cell cell-desc" role="gridcell">
        {badges.map((b) => (
          <RefBadge key={b.ref.fullName} model={b} role={p.roleOf} onPick={p.onPickRef} />
        ))}
        <span className="subject" title={c.subject}>
          {c.subject}
        </span>
        {c.parents.length > 1 && <span className="merge-mark" title="merge">⑂</span>}
      </div>
      <div className="cell cell-date" role="gridcell" title={formatAbsolute(c.timestamp)}>
        {formatDate(c.timestamp, p.dateMode, p.now)}
      </div>
      <div className="cell cell-author" role="gridcell" title={`${c.authorName} <${c.authorEmail}>`}>
        {c.authorName}
      </div>
      <div className="cell cell-hash mono" role="gridcell" title={c.hash}>
        {shortHash(c.hash)}
      </div>
    </div>
  );
});

export function CommitTable(props: CommitTableProps) {
  const { items, density } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowH = ROW_HEIGHT[density];
  const laneW = LANE_WIDTH[density];
  const offset = props.uncommitted ? 1 : 0;
  const count = items.length + offset + (props.hasMore ? 1 : 0);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const graphLanes = useMemo(() => {
    let max = 1;
    for (const it of items) if (it.row.width > max) max = it.row.width;
    return Math.min(max, MAX_LANES);
  }, [items]);
  const graphW = graphLanes * laneW + GRAPH_PAD * 2;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 14,
  });
  // row height changes with density: re-measure
  useEffect(() => {
    virtualizer.measure();
  }, [rowH, virtualizer]);

  useImperativeHandle(
    props.tableRef,
    () => ({
      scrollToIndex: (i, align = 'auto') => virtualizer.scrollToIndex(i + offset, { align }),
      scrollByRows: (rows) => {
        if (scrollRef.current) scrollRef.current.scrollTop += rows * rowH;
      },
      getRange: () => {
        const r = virtualizer.range;
        return { start: Math.max(0, (r?.startIndex ?? 0) - offset), end: Math.max(0, (r?.endIndex ?? 0) - offset) };
      },
    }),
    [virtualizer, offset, rowH],
  );

  const vItems = virtualizer.getVirtualItems();
  // the range that is actually on screen (`vItems` also contains the overscan rows)
  const first = virtualizer.range?.startIndex ?? 0;
  const last = virtualizer.range?.endIndex ?? 0;
  const { loadMore, hasMore, onRangeChange } = props;
  useEffect(() => {
    onRangeChange?.(Math.max(0, first - offset), Math.max(0, last - offset));
    if (hasMore && last >= count - 40) loadMore();
  }, [first, last, count, hasMore, loadMore, onRangeChange, offset]);

  return (
    <div className="table" role="grid" aria-rowcount={count} style={{ ['--graph-w' as string]: `${graphW}px`, ['--row-h' as string]: `${rowH}px` }}>
      <div className="thead" role="row">
        <div className="th th-graph">{t.columnGraph}</div>
        <div className="th">{t.columnDescription}</div>
        <div className="th th-date">{t.columnDate}</div>
        <div className="th th-author">{t.columnAuthor}</div>
        <div className="th th-hash">{t.columnCommit}</div>
      </div>
      <div className="tbody" ref={scrollRef} tabIndex={0}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {vItems.map((v) => {
            if (props.uncommitted && v.index === 0) {
              const u = props.uncommitted;
              return (
                <div
                  key="uncommitted"
                  className={`row row-uncommitted${props.selected === 'worktree' ? ' selected' : ''}`}
                  role="row"
                  style={{ transform: `translateY(${v.start}px)`, height: rowH }}
                  onClick={() => props.onSelect('worktree')}
                >
                  <div className="cell cell-graph">
                    <UncommittedDot height={rowH} width={graphW} />
                  </div>
                  <div className="cell cell-desc">
                    <span className="subject uncommitted-label">{t.uncommitted}</span>
                    <span className="muted">{t.uncommittedCount(u.changed + u.untracked, u.untracked)}</span>
                  </div>
                  <div className="cell cell-date" />
                  <div className="cell cell-author" />
                  <div className="cell cell-hash" />
                </div>
              );
            }
            const idx = v.index - offset;
            const item = items[idx];
            if (!item) {
              return (
                <div key={`loading-${v.index}`} className="row row-loading" style={{ transform: `translateY(${v.start}px)`, height: rowH }}>
                  <div className="cell cell-desc muted">{t.loading}</div>
                </div>
              );
            }
            return (
              <Row
                key={item.commit.hash}
                item={item}
                index={idx}
                top={v.start}
                height={rowH}
                laneW={laneW}
                graphW={graphW}
                graphLanes={graphLanes}
                refMap={props.refMap}
                isHead={item.commit.hash === props.headHash}
                selected={props.selected === item.commit.hash}
                side={props.sideOf(item.commit.hash)}
                matched={props.matchSet.has(idx)}
                active={props.activeMatch === idx}
                dateMode={props.dateMode}
                now={now}
                roleOf={props.roleOf}
                onPickRef={props.onPickRef}
                onSelect={props.onSelect}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
