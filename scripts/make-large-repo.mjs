#!/usr/bin/env node
// Builds a large synthetic repository quickly with `git fast-import`:
// a main line with a side branch forked and merged every 10 commits.
//
//   node scripts/make-large-repo.mjs <target-dir> [commits=10000]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildLargeRepo(dir, commits = 10_000) {
  mkdirSync(dir, { recursive: true });
  const nullCfg = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env = { ...process.env, GIT_CONFIG_GLOBAL: nullCfg, GIT_CONFIG_SYSTEM: nullCfg };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });

  const out = [];
  let mark = 0;
  const ts = Math.floor(Date.now() / 1000) - commits * 3600;
  const data = (s) => `data ${Buffer.byteLength(s)}\n${s}`;
  const emit = (ref, from, merge, i) => {
    const m = ++mark;
    const who = `Perf ${i % 5} <perf${i % 5}@example.com> ${ts + i * 3600} +0000`;
    out.push(`commit ${ref}`, `mark :${m}`, `author ${who}`, `committer ${who}`, data(`commit ${i}: synthetic message`));
    if (from !== null) out.push(`from :${from}`);
    if (merge !== null) out.push(`merge :${merge}`);
    out.push(`M 100644 inline file${i % 50}.txt`, data(`content ${i}\n`), '');
    return m;
  };
  let tip = null;
  for (let i = 1; i <= commits; i++) {
    if (i % 10 === 0) {
      const side = emit('refs/heads/side', tip, null, i);
      tip = emit('refs/heads/main', tip, side, i);
    } else {
      tip = emit('refs/heads/main', tip, null, i);
    }
  }
  const r = spawnSync('git', ['fast-import', '--quiet'], { cwd: dir, env, input: out.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 29 });
  if (r.status !== 0) throw new Error(r.stderr);
  execFileSync('git', ['checkout', '-q', '-f', 'main'], { cwd: dir, env });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const target = resolve(process.argv[2] ?? 'large-repo');
  buildLargeRepo(target, Number(process.argv[3] ?? 10_000));
  console.log(`large repo: ${target}`);
}
