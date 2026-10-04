import { describe, expect, it } from 'vitest';
import {
  mergeChangedFiles,
  parseLeftRightCount,
  parseLog,
  parseNameStatusZ,
  parseNumstatZ,
  parseRefs,
} from './parse.js';
import { buildPresets, isSafeRefName } from './refs.js';

describe('parseLog', () => {
  it('parses NUL-terminated records with multi-line-safe fields', () => {
    const out =
      ['h1', 'p1 p2', 'Alice', 'a@x', '100', 'fix: a b'].join('\x1f') +
      '\0\n' +
      ['h2', '', 'Bob Smith', 'b@x', '50', 'root'].join('\x1f') +
      '\0';
    expect(parseLog(out)).toEqual([
      { hash: 'h1', parents: ['p1', 'p2'], authorName: 'Alice', authorEmail: 'a@x', timestamp: 100, subject: 'fix: a b' },
      { hash: 'h2', parents: [], authorName: 'Bob Smith', authorEmail: 'b@x', timestamp: 50, subject: 'root' },
    ]);
  });

  it('returns [] for empty output (empty repository)', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('parseRefs', () => {
  const line = (...f: string[]) => f.join('\0');
  it('classifies refs and peels annotated tags', () => {
    const out = [
      line('refs/heads/main', 'aaa', '', 'origin/main', '*'),
      line('refs/heads/feat/x', 'bbb', '', '', ' '),
      line('refs/remotes/origin/main', 'ccc', '', '', ' '),
      line('refs/remotes/origin/HEAD', 'ccc', '', '', ' '),
      line('refs/tags/v1', 'ttt', 'ddd', '', ' '),
      line('refs/tags/light', 'eee', '', '', ' '),
    ].join('\n');
    const refs = parseRefs(out);
    expect(refs.map((r) => [r.type, r.name, r.hash])).toEqual([
      ['local', 'main', 'aaa'],
      ['local', 'feat/x', 'bbb'],
      ['remote', 'origin/main', 'ccc'],
      ['tag', 'v1', 'ddd'],
      ['tag', 'light', 'eee'],
    ]);
    expect(refs[0]).toMatchObject({ isHead: true, upstream: 'origin/main' });
    expect(refs[2]).toMatchObject({ remote: 'origin' });
  });
});

describe('diff parsers', () => {
  it('parses left-right counts', () => {
    expect(parseLeftRightCount('3\t2\n')).toEqual([3, 2]);
  });

  it('parses numstat -z including renames and binaries', () => {
    const out = ['1\t2\ta b.txt', '-\t-\timg.png', '5\t0\t', 'old.txt', 'new.txt', ''].join('\0');
    const m = parseNumstatZ(out);
    expect(m.get('a b.txt')).toEqual({ added: 1, deleted: 2 });
    expect(m.get('img.png')).toEqual({ added: null, deleted: null });
    expect(m.get('new.txt')).toEqual({ added: 5, deleted: 0, oldPath: 'old.txt' });
  });

  it('merges name-status and numstat', () => {
    const ns = parseNameStatusZ('M\0a.txt\0R100\0old.txt\0new.txt\0D\0gone.txt\0');
    expect(ns).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'R', path: 'new.txt', oldPath: 'old.txt' },
      { status: 'D', path: 'gone.txt' },
    ]);
    const files = mergeChangedFiles(ns, parseNumstatZ('1\t1\ta.txt\0'));
    expect(files[0]).toMatchObject({ path: 'a.txt', added: 1, deleted: 1 });
    expect(files[2]).toMatchObject({ path: 'gone.txt', added: 0, deleted: 0 });
  });
});

describe('isSafeRefName', () => {
  it.each(['main', 'feat/x-1', 'origin/main', 'v1.0.0', 'abcdef1234'])('accepts %s', (n) => {
    expect(isSafeRefName(n)).toBe(true);
  });
  it.each(['', '-x', '--upload-pack=x', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'x@{1}', 'a\\b', 'a/', 'a.lock'])(
    'rejects %j',
    (n) => {
      expect(isSafeRefName(n)).toBe(false);
    },
  );
});

describe('buildPresets', () => {
  it('builds presets from the available refs', () => {
    const p = buildPresets({
      head: 'feat',
      upstream: 'origin/feat',
      branches: ['main', 'feat'],
      remoteBranches: ['origin/main', 'origin/feat'],
    });
    expect(p.map((x) => x.id)).toEqual(['head-upstream', 'head-main', 'main-origin']);
  });
  it('does not list the same pair twice', () => {
    const p = buildPresets({ head: 'main', upstream: 'origin/main', branches: ['main'], remoteBranches: ['origin/main'] });
    expect(p.map((x) => x.id)).toEqual(['head-upstream']);
  });
  it('omits unavailable presets', () => {
    expect(buildPresets({ head: null, branches: [], remoteBranches: [] })).toEqual([]);
  });
});
