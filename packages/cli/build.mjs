// Builds the npm package `orca-git-graph` into ./dist (publish with `npm publish` from that directory):
//   server.mjs   the bundled server with a shebang; bins: `orca-git-graph` and `git-graph` (so `git graph` works too)
//   web/         the built UI
//   package.json README.md LICENSE
import { build } from 'esbuild';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, 'dist');
const webDist = join(root, 'packages', 'web', 'dist');
if (!existsSync(join(webDist, 'index.html'))) throw new Error('web UI is not built (packages/web/dist)');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [join(root, 'packages', 'server', 'src', 'cli.ts')],
  outfile: join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'info',
});
await chmod(join(out, 'server.mjs'), 0o755);
await cp(webDist, join(out, 'web'), { recursive: true });
for (const f of ['README.md', 'LICENSE']) if (existsSync(join(root, f))) await cp(join(root, f), join(out, f));
await mkdir(join(out, 'docs', 'images'), { recursive: true });
await cp(join(root, 'docs', 'images', 'demo-compare-en.gif'), join(out, 'docs', 'images', 'demo-compare-en.gif'));

const version = JSON.parse(await readFile(join(here, 'package.json'), 'utf8')).version;
const pkg = {
  name: 'orca-git-graph',
  version,
  description: 'A visual Git commit graph with ahead/behind comparison between any two refs. Works in any browser; also an Orca plugin.',
  license: 'MIT',
  type: 'module',
  bin: { 'orca-git-graph': 'server.mjs', 'git-graph': 'server.mjs' },
  files: ['server.mjs', 'web', 'docs', 'README.md', 'LICENSE'],
  engines: { node: '>=20' },
  repository: { type: 'git', url: 'git+https://github.com/mazume-tech-club/orca-git-graph.git' },
  homepage: 'https://github.com/mazume-tech-club/orca-git-graph#readme',
  bugs: { url: 'https://github.com/mazume-tech-club/orca-git-graph/issues' },
  keywords: ['git', 'git-graph', 'commit-graph', 'visualization', 'branch', 'compare', 'orca', 'orca-plugin'],
};
await writeFile(join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
console.log(`npm package built: ${out}`);
