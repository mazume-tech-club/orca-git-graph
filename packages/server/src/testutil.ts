import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Test Committer',
  GIT_COMMITTER_EMAIL: 'committer@example.com',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
};

export function sh(cwd: string, args: string[], input?: string): string {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8', input, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

export interface Fixture {
  dir: string;
  cleanup(): void;
}

let counter = 0;
let tick = 1_700_000_000;

export function tempDir(prefix: string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `ogg-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) };
}

export function write(repo: string, rel: string, content: string): void {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function commit(repo: string, message: string, files: Record<string, string> = {}): string {
  for (const [name, content] of Object.entries(files)) write(repo, name, content);
  if (Object.keys(files).length === 0) write(repo, `f${counter++}.txt`, `${message}\n`);
  sh(repo, ['add', '-A']);
  // monotonically increasing dates keep `git log` ordering deterministic
  const date = `${tick++} +0000`;
  const r = spawnSync('git', ['commit', '-q', '-m', message], {
    cwd: repo,
    env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`commit failed: ${r.stderr}`);
  return sh(repo, ['rev-parse', 'HEAD']).trim();
}

export function initRepo(dir: string): void {
  sh(dir, ['init', '-q', '-b', 'main']);
}

/**
 * main:   a - b - c ----- m
 *              \         /
 * feature:      d - e --+
 * plus tag v1 on b, annotated tag v2 on c, and a remote `origin` with main behind by one commit.
 */
export function buildFixture(): Fixture & { origin: string; shas: Record<string, string> } {
  const fx = tempDir('repo');
  const origin = tempDir('origin');
  const dir = join(fx.dir, 'work');
  mkdirSync(dir);
  initRepo(dir);
  const shas: Record<string, string> = {};
  shas.a = commit(dir, 'a: first', { 'README.md': '# hi\n' });
  shas.b = commit(dir, 'b: second\n\nbody line 1\nbody line 2', { 'src/app.txt': 'one\n', 'with space.txt': 'x\n', 'ünï.txt': 'u\n' });
  sh(dir, ['tag', 'v1']);
  sh(dir, ['checkout', '-q', '-b', 'feature']);
  shas.d = commit(dir, 'd: feature work', { 'src/app.txt': 'one\ntwo\n', '-dash.txt': 'd\n' });
  shas.e = commit(dir, 'e: more feature');
  sh(dir, ['checkout', '-q', 'main']);
  shas.c = commit(dir, 'c: main work', { 'main.txt': 'm\n' });
  sh(dir, ['tag', '-a', 'v2', '-m', 'release 2']);
  sh(dir, ['merge', '-q', '--no-ff', '-m', 'm: merge feature', 'feature']);
  shas.m = sh(dir, ['rev-parse', 'HEAD']).trim();

  // origin: a bare clone of main as it was at c (one commit behind the merge)
  sh(origin.dir, ['init', '-q', '--bare', '-b', 'main']);
  sh(dir, ['remote', 'add', 'origin', origin.dir]);
  sh(dir, ['push', '-q', 'origin', 'main:main', 'feature:feature']);
  sh(dir, ['branch', '--set-upstream-to=origin/main', 'main']);
  // advance origin/main by one commit from a second clone
  const other = join(fx.dir, 'other');
  sh(fx.dir, ['clone', '-q', origin.dir, other]);
  shas.o = commit(other, 'o: origin-only commit');
  sh(other, ['push', '-q', 'origin', 'main']);
  sh(dir, ['fetch', '-q', 'origin']);

  return {
    dir,
    origin: origin.dir,
    shas,
    cleanup: () => {
      fx.cleanup();
      origin.cleanup();
    },
  };
}
