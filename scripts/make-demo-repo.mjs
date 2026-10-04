#!/usr/bin/env node
// Builds a fictional repository ("acme-widgets") with branches, merges, tags and a remote that is
// ahead of / behind the local main. Used for manual checks, e2e tests and README screenshots.
//
//   node scripts/make-demo-repo.mjs <target-dir>
//
// Creates <target-dir> (the working repo) and <target-dir>-origin.git (the bare remote).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const target = resolve(process.argv[2] ?? 'demo-repo');
const origin = `${target}-origin.git`;
const other = `${target}-other`;

const NULL_CFG = process.platform === 'win32' ? 'NUL' : '/dev/null';
let clock = Math.floor(Date.now() / 1000) - 60 * 24 * 3600;
const people = [
  ['Aiko Tanaka', 'aiko@acme.example'],
  ['Ben Carter', 'ben@acme.example'],
  ['Chen Wei', 'chen@acme.example'],
  ['Dana Okafor', 'dana@acme.example'],
];
let who = 0;

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: NULL_CFG, GIT_CONFIG_SYSTEM: NULL_CFG, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tick(cwd) {
  clock += 3 * 3600 + Math.floor(Math.random() * 5 * 3600);
  const [name, email] = people[who++ % people.length];
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: `${clock} +0000`,
    GIT_COMMITTER_DATE: `${clock} +0000`,
  };
}

let n = 0;
function commit(cwd, message, files) {
  for (const [path, content] of Object.entries(files ?? { [`src/file${n % 7}.ts`]: `// ${message}\nexport const v${n} = ${n};\n` })) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  n++;
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message], tick(cwd));
}

function merge(cwd, branch, message) {
  git(cwd, ['merge', '-q', '--no-ff', '-m', message, branch], tick(cwd));
}

rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
rmSync(origin, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
rmSync(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
mkdirSync(target, { recursive: true });
git(target, ['init', '-q', '-b', 'main']);

commit(target, 'Initial commit', { 'README.md': '# acme-widgets\n\nA fictional widget library.\n', 'package.json': '{ "name": "acme-widgets" }\n' });
commit(target, 'Add widget core', { 'src/core.ts': 'export class Widget {}\n' });
commit(target, 'Add build script');
git(target, ['tag', 'v0.1.0']);

git(target, ['checkout', '-q', '-b', 'feature/search']);
commit(target, 'Search: index widgets');
commit(target, 'Search: add query parser');
git(target, ['checkout', '-q', 'main']);
commit(target, 'Fix widget sizing');
commit(target, 'Add CI workflow', { '.github/workflows/ci.yml': 'name: ci\non: push\n' });
merge(target, 'feature/search', 'Merge feature/search');
git(target, ['tag', 'v0.2.0']);

git(target, ['checkout', '-q', '-b', 'feature/login']);
commit(target, 'Login: add form');
git(target, ['checkout', '-q', 'main']);
commit(target, 'Docs: describe widgets', { 'docs/widgets.md': '# Widgets\n' });
git(target, ['checkout', '-q', 'feature/login']);
commit(target, 'Login: validate input');
commit(target, 'Login: remember me');
git(target, ['checkout', '-q', 'main']);
commit(target, 'Refactor widget core');

git(target, ['checkout', '-q', '-b', 'release/1.0']);
commit(target, 'Bump version to 1.0.0-rc.1', { 'package.json': '{ "name": "acme-widgets", "version": "1.0.0-rc.1" }\n' });
git(target, ['checkout', '-q', 'main']);
merge(target, 'feature/login', 'Merge feature/login');
commit(target, 'Improve error messages');
git(target, ['checkout', '-q', 'release/1.0']);
commit(target, 'Release 1.0.0', { 'package.json': '{ "name": "acme-widgets", "version": "1.0.0" }\n' });
git(target, ['tag', '-a', 'v1.0.0', '-m', 'Release 1.0.0'], tick(target));
git(target, ['checkout', '-q', 'main']);
merge(target, 'release/1.0', 'Merge release/1.0');

git(target, ['checkout', '-q', '-b', 'fix/typo']);
commit(target, 'Fix typo in README', { 'README.md': '# acme-widgets\n\nA fictional widget library, now with fewer typos.\n' });
git(target, ['checkout', '-q', 'main']);
for (let i = 0; i < 6; i++) commit(target, ['Tune widget cache', 'Add widget tests', 'Handle empty queries', 'Speed up search', 'Update dependencies', 'Cleanup'][i]);

// remote: push, then let a collaborator add two commits to origin/main
git(dirname(target), ['init', '-q', '--bare', '-b', 'main', origin]);
git(target, ['remote', 'add', 'origin', origin]);
git(target, ['push', '-q', 'origin', 'main', 'feature/search', 'feature/login', 'release/1.0', '--tags']);
git(target, ['branch', '--set-upstream-to=origin/main', 'main']);
git(dirname(target), ['clone', '-q', origin, other]);
commit(other, 'Collaborator: fix flaky test');
commit(other, 'Collaborator: bump CI node version');
git(other, ['push', '-q', 'origin', 'main']);
rmSync(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
git(target, ['fetch', '-q', '--prune']);
// local-only work: main is now 3 ahead / 2 behind origin/main
commit(target, 'Local: add widget themes');
commit(target, 'Local: theme tests');
commit(target, 'Local: docs for themes');

// a little uncommitted state
writeFileSync(join(target, 'src/file0.ts'), '// edited but not committed\n');
writeFileSync(join(target, 'NOTES.txt'), 'scratch\n');

console.log(`demo repo: ${target}\nremote:    ${origin}`);
