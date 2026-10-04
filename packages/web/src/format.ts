import { t } from './i18n.js';

export type DateMode = 'relative' | 'absolute';

const pad = (n: number) => String(n).padStart(2, '0');

export function formatAbsolute(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatRelative(ts: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor(nowMs / 1000 - ts));
  if (sec < 45) return t.relNow;
  const min = Math.round(sec / 60);
  if (min < 60) return t.relMinutes(min);
  const hours = Math.round(min / 60);
  if (hours < 24) return t.relHours(hours);
  const days = Math.round(hours / 24);
  if (days < 30) return t.relDays(days);
  const months = Math.round(days / 30);
  if (months < 12) return t.relMonths(months);
  return t.relYears(Math.round(days / 365));
}

export function formatDate(ts: number, mode: DateMode, nowMs: number): string {
  return mode === 'relative' ? formatRelative(ts, nowMs) : formatAbsolute(ts);
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/** Group digits for large counts: 12345 → 12,345 */
export function num(n: number): string {
  return n.toLocaleString('en-US');
}
