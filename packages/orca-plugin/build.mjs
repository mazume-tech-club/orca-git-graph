// Assembles the installable plugin into ./dist :
//   orca-plugin.json  worker.mjs  open.mjs  server.mjs  web/  panels/  (README, LICENSE)
// Orca installs a plugin by shallow-cloning a Git ref and using the tree as-is (no build step), so this
// directory is what gets published (see scripts/release.mjs).
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(here, 'dist');
const webDist = join(root, 'packages', 'web', 'dist');

if (!existsSync(join(webDist, 'index.html'))) {
  throw new Error('web UI is not built (packages/web/dist). Run `pnpm --filter @orca-git-graph/web build` first.');
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: { worker: join(here, 'src', 'worker.ts'), open: join(here, 'src', 'cli-open.ts'), server: join(root, 'packages', 'server', 'src', 'cli.ts') },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'info',
});

await cp(webDist, join(out, 'web'), { recursive: true });
// sidebar panel(s) declared in contributes.panels
await cp(join(here, 'panels'), join(out, 'panels'), { recursive: true });

const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(here, 'orca-plugin.json'), 'utf8'));
manifest.version = pkg.version;
await writeFile(join(out, 'orca-plugin.json'), JSON.stringify(manifest, null, 2) + '\n');

for (const f of ['README.md', 'README.ja.md', 'LICENSE']) {
  if (existsSync(join(root, f))) await cp(join(root, f), join(out, f));
}
// the README in the release branch shows the demo GIFs
for (const f of ['demo-compare-en.gif', 'demo-compare-ja.gif']) {
  if (existsSync(join(root, 'docs', 'images', f))) await cp(join(root, 'docs', 'images', f), join(out, 'docs', 'images', f));
}
console.log(`plugin built: ${out}`);
