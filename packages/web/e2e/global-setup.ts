import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Start the real server (built UI + a generated demo repo and a 10k-commit repo) for the e2e tests. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(join(root, 'packages', 'web', 'dist', 'index.html'))) {
    throw new Error('web UI is not built: run `pnpm build` first');
  }
  const dir = mkdtempSync(join(tmpdir(), 'ogg-e2e-'));
  const demo = join(dir, 'acme-widgets');
  const large = join(dir, 'large');
  const live = join(dir, 'live');
  execFileSync('node', [join(root, 'scripts', 'make-demo-repo.mjs'), demo], { stdio: 'inherit' });
  execFileSync('node', [join(root, 'scripts', 'make-demo-repo.mjs'), live], { stdio: 'inherit' });
  execFileSync('node', [join(root, 'scripts', 'make-large-repo.mjs'), large, '10000'], { stdio: 'inherit' });

  const tsx = join(root, 'packages', 'server', 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  const child: ChildProcess = spawn(
    tsx,
    [join(root, 'packages', 'server', 'src', 'cli.ts'), '--repo', demo, '--repo', live, '--repo', large, '--web-dir', join(root, 'packages', 'web', 'dist')],
    { stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' },
  );
  const ready = await new Promise<{ port: number; token: string; repos: Array<{ id: string; name: string }> }>((resolveReady, reject) => {
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /ORCA_GIT_GRAPH_READY (.*)\n/.exec(buf);
      if (m) resolveReady(JSON.parse(m[1]!));
    });
    child.once('exit', (c) => reject(new Error(`server exited early (${c})`)));
    setTimeout(() => reject(new Error('server did not start')), 30_000);
  });
  const url = (name: string) => {
    const r = ready.repos.find((x) => x.name === name)!;
    return `http://127.0.0.1:${ready.port}/?repo=${encodeURIComponent(r.id)}&token=${ready.token}&lang=ja`;
  };
  process.env.OGG_DEMO_URL = url('acme-widgets');
  process.env.OGG_LARGE_URL = url('large');
  process.env.OGG_LIVE_URL = url('live');
  process.env.OGG_LIVE_PATH = live;
  process.env.OGG_LIVE_ORIGIN = `${live}-origin.git`;
  process.env.OGG_BASE = `http://127.0.0.1:${ready.port}`;
  process.env.OGG_TOKEN = ready.token;

  return async () => {
    if (process.platform === 'win32' && child.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    } else child.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  };
}
