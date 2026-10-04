import { describe, expect, it } from 'vitest';
import { setLang } from './i18n.js';
import { formatAbsolute, formatRelative, shortHash } from './format.js';

describe('format', () => {
  it('formats relative dates in Japanese and English', () => {
    const now = 1_700_000_000_000;
    setLang('ja');
    expect(formatRelative(now / 1000 - 10, now)).toBe('たった今');
    expect(formatRelative(now / 1000 - 5 * 60, now)).toBe('5 分前');
    expect(formatRelative(now / 1000 - 3 * 3600, now)).toBe('3 時間前');
    expect(formatRelative(now / 1000 - 2 * 86400, now)).toBe('2 日前');
    expect(formatRelative(now / 1000 - 90 * 86400, now)).toBe('3 か月前');
    setLang('en');
    expect(formatRelative(now / 1000 - 3 * 3600, now)).toBe('3h ago');
    expect(formatRelative(now / 1000 - 800 * 86400, now)).toBe('2y ago');
  });

  it('formats absolute dates in local time', () => {
    expect(formatAbsolute(0)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('shortens hashes', () => {
    expect(shortHash('0123456789abcdef')).toBe('0123456');
  });
});
