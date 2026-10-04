import { memo } from 'react';
import type { GraphRow, LaneEdge } from '@orca-git-graph/core';

/** Which side of the current comparison a commit belongs to. */
export type Side = 'A' | 'B' | 'base' | 'common' | 'other';

export const PALETTE_SIZE = 8;

/**
 * Colour comes from the palette; the dash pattern changes every time the palette wraps, so two lanes
 * with the same colour are still told apart without relying on colour alone.
 */
function laneStyle(color: number): { stroke: string; dash?: string } {
  const cycle = Math.floor(color / PALETTE_SIZE) % 3;
  return {
    stroke: `var(--lane-${color % PALETTE_SIZE})`,
    dash: cycle === 1 ? '5 3' : cycle === 2 ? '1.5 3' : undefined,
  };
}

export interface GraphCellProps {
  row: GraphRow;
  height: number;
  laneW: number;
  width: number;
  isHead: boolean;
  isMerge: boolean;
  side: Side | null;
}

const PAD = 6;

function edgePath(e: LaneEdge, rowCol: number, laneW: number, h: number): string {
  const x = (c: number) => PAD + c * laneW + laneW / 2;
  const mid = h / 2;
  if (e.type === 'through') return `M${x(e.col)} 0V${h}`;
  if (e.type === 'in') {
    return e.col === rowCol ? `M${x(e.col)} 0V${mid}` : `M${x(e.col)} 0C${x(e.col)} ${h * 0.35} ${x(rowCol)} ${h * 0.15} ${x(rowCol)} ${mid}`;
  }
  return e.col === rowCol ? `M${x(rowCol)} ${mid}V${h}` : `M${x(rowCol)} ${mid}C${x(rowCol)} ${h * 0.85} ${x(e.col)} ${h * 0.65} ${x(e.col)} ${h}`;
}

function GraphCellImpl({ row, height, laneW, width, isHead, isMerge, side }: GraphCellProps) {
  const cx = PAD + row.col * laneW + laneW / 2;
  const cy = height / 2;
  const color = laneStyle(row.color);
  const dim = side === 'common' || side === 'other';
  return (
    <svg className="graph-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={dim ? { opacity: 0.4 } : undefined}>
      {row.edges.map((e, i) => {
        const s = laneStyle(e.color);
        return <path key={i} d={edgePath(e, row.col, laneW, height)} stroke={s.stroke} strokeDasharray={s.dash} strokeWidth={2} fill="none" strokeLinecap="round" />;
      })}
      {isHead && <circle cx={cx} cy={cy} r={8} fill="none" stroke="var(--fg)" strokeWidth={1.5} />}
      <Dot cx={cx} cy={cy} stroke={color.stroke} isMerge={isMerge} side={side} />
    </svg>
  );
}

function Dot({ cx, cy, stroke, isMerge, side }: { cx: number; cy: number; stroke: string; isMerge: boolean; side: Side | null }) {
  // Shapes carry the comparison side so it does not depend on colour: A = circle, B = square, base = diamond.
  if (side === 'A') return <circle cx={cx} cy={cy} r={5.5} fill="var(--side-a)" stroke="var(--bg)" strokeWidth={1.5} />;
  if (side === 'B') return <rect x={cx - 5} y={cy - 5} width={10} height={10} rx={1.5} fill="var(--side-b)" stroke="var(--bg)" strokeWidth={1.5} />;
  if (side === 'base') {
    return <rect x={cx - 5.5} y={cy - 5.5} width={11} height={11} transform={`rotate(45 ${cx} ${cy})`} fill="var(--bg)" stroke="var(--fg)" strokeWidth={2.2} />;
  }
  if (isMerge) return <circle cx={cx} cy={cy} r={4.5} fill="var(--bg)" stroke={stroke} strokeWidth={2.2} />;
  return <circle cx={cx} cy={cy} r={4.5} fill={stroke} stroke="var(--bg)" strokeWidth={1.2} />;
}

export const GraphCell = memo(GraphCellImpl);

export function UncommittedDot({ height, width }: { height: number; width: number }) {
  return (
    <svg className="graph-svg" width={width} height={height} aria-hidden="true">
      <circle cx={PAD + 7} cy={height / 2} r={4.5} fill="none" stroke="var(--fg-muted)" strokeWidth={2} strokeDasharray="2.5 2" />
    </svg>
  );
}

export const GRAPH_PAD = PAD;
