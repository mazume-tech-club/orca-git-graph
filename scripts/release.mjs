#!/usr/bin/env node
// Builds the plugin and turns packages/orca-plugin/dist into a standalone Git repository (default: ./release).
//
// Orca installs a plugin from "Git URL" by shallow-cloning a ref and using the tree as-is, with no build step,
// so the ref it points at must contain orca-plugin.json + worker.mjs + server.mjs + web/ at its root.
// That is a different tree from this source repository, so it is published on its own branch/tag.
//
//   node scripts/release.mjs                          build, create ./release (one commit, tag v<version>)
//   node scripts/release.mjs --remote <git-url> --push   also force-push branch `plugin-dist` and the tag
//
// Nothing is pushed unless --push is given.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const out = resolve(opt('--out', join(root, 'release')));
const branch = opt('--branch', 'plugin-dist');
const remote = opt('--remote', null);
const push = args.includes('--push');
const skipBuild = args.includes('--skip-build');

if (push && !remote) throw new Error('--push needs --remote <git-url>');

if (!skipBuild) {
  console.log('> pnpm build');
  execFileSync('pnpm', ['build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}

const dist = join(root, 'packages', 'orca-plugin', 'dist');
for (const f of ['orca-plugin.json', 'worker.mjs', 'server.mjs', join('web', 'index.html')]) {
  if (!existsSync(join(dist, f))) throw new Error(`missing ${f} in ${dist}; run pnpm build`);
}
const manifest = JSON.parse(await readFile(join(dist, 'orca-plugin.json'), 'utf8'));
const tag = opt('--tag', `v${manifest.version}`);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(dist, out, { recursive: true });
// never let a user's `core.autocrlf` rewrite the shipped files when Orca clones this tree
await writeFile(join(out, '.gitattributes'), '* -text\n');

const env = { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'release', GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'release@localhost', GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'release', GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'release@localhost' };
const git = (...a) => execFileSync('git', a, { cwd: out, env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
git('init', '-q', '-b', branch);
git('add', '-A');
git('commit', '-q', '-m', `Release ${manifest.id} ${manifest.version}`);
git('tag', '-f', tag);
console.log(`\nrelease tree: ${out}\n  branch ${branch}, tag ${tag}, ${git('rev-parse', '--short', 'HEAD').trim()}`);

if (push) {
  git('push', '--force', remote, `${branch}:${branch}`);
  git('push', '--force', remote, tag);
  console.log(`pushed ${branch} and ${tag} to ${remote}`);
} else {
  console.log(`
To publish:
  node scripts/release.mjs --remote <your-github-url> --push --skip-build
Then in Orca: Settings → Plugins → Install from Git URL
  URL: <your-github-url>   Ref: ${tag}   (or ${branch} to follow the latest)
`);
}
