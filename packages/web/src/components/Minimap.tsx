import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogItem } from '@orca-git-graph/core';
import type { Side } from './GraphCell.js';
import { t } from '../i18n.js';

export interface MinimapProps {
  items: LogItem[];
  total: number | null;
  sideOf: (hash: string) => Side | null;
  range: { start: number; end: number };
  onSeek: (index: number) => void;
  compareActive: boolean;
}

const W = 18;
// priority when several commits fall in the same pixel row
const PRIORITY: Record<string, number> = { base: 5, A: 4, B: 4, ref: 3, common: 1, other: 0 };

/**
 * A strip showing the whole history: where the commits of the comparison are (A = left half,
 * B = right half, so the side is readable without colour), where refs sit, and the visible window.
 */
export function Minimap({ items, total, sideOf, range, onSeek, compareActive }: MinimapProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [h, setH] = useState(300);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(Math.max(40, Math.floor(el.clientHeight))));
    ro.observe(el);
    setH(Math.max(40, Math.floor(el.clientHeight)));
    return () => ro.disconnect();
  }, []);

  const n = Math.max(total ?? items.length, items.length, 1);

  // bucket per pixel row: best marker kind
  const buckets = useMemo(() => {
    const out: Array<string | null> = new Array(h).fill(null);
    items.forEach((it, i) => {
      const y = Math.min(h - 1, Math.floor((i / n) * h));
      const side = compareActive ? sideOf(it.commit.hash) : null;
      const kind = side && side !== 'common' && side !== 'other' ? side : it.refs.length > 0 ? 'ref' : side ?? null;
      if (!kind) return;
      const cur = out[y];
      if (!cur || (PRIORITY[kind] ?? 0) > (PRIORITY[cur] ?? 0)) out[y] = kind;
    });
    return out;
  }, [items, n, h, sideOf, compareActive]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = h * dpr;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, h);
    const css = getComputedStyle(c);
    const col = (name: string) => css.getPropertyValue(name).trim() || '#888';
    const a = col('--side-a');
    const b = col('--side-b');
    const fg = col('--fg');
    const muted = col('--fg-muted');
    // track
    g.fillStyle = col('--bg-alt');
    g.fillRect(0, 0, W, h);
    buckets.forEach((kind, y) => {
      if (!kind) return;
      if (kind === 'A') {
        g.fillStyle = a;
        g.fillRect(1, y, W / 2 - 1, 2);
      } else if (kind === 'B') {
        g.fillStyle = b;
        g.fillRect(W / 2, y, W / 2 - 1, 2);
      } else if (kind === 'base') {
        g.fillStyle = fg;
        g.fillRect(0, y - 1, W, 3);
      } else if (kind === 'ref') {
        g.fillStyle = muted;
        g.fillRect(W / 2 - 2, y, 4, 2);
      } else if (kind === 'common') {
        g.fillStyle = muted;
        g.globalAlpha = 0.35;
        g.fillRect(W / 2 - 1, y, 2, 1);
        g.globalAlpha = 1;
      }
    });
    // viewport window
    const y0 = (range.start / n) * h;
    const y1 = Math.max(y0 + 4, ((range.end + 1) / n) * h);
    g.strokeStyle = fg;
    g.lineWidth = 1.5;
    g.strokeRect(0.75, y0, W - 1.5, y1 - y0);
  }, [buckets, h, range, n]);

  const seek = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = Math.floor(((e.clientY - rect.top) / rect.height) * n);
    onSeek(Math.max(0, Math.min(n - 1, idx)));
  };

  return (
    <div className="minimap" ref={wrap} title={t.minimap}>
      <canvas
        ref={canvas}
        style={{ width: W, height: h }}
        role="img"
        aria-label={t.minimap}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seek(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seek(e);
        }}
      />
    </div>
  );
}
