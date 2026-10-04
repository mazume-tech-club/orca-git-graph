#!/usr/bin/env node
// Standalone dev run (no Orca needed):  pnpm dev -- --repo C:\path\to\repo [--repo ...]
// Starts the API server and the Vite dev server (hot reload) and prints the URL to open.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const bin = (pkg, name) => join(root, 'packages', pkg, 'node_modules', '.bin', win ? `${name}.cmd` : name);

const args = process.argv.slice(2).filter((a) => a !== '--');
const repos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1]) repos.push(args[++i]);
  else if (args[i] === '-h' || args[i] === '--help') {
    console.log('usage: pnpm dev -- --repo <path> [--repo <path> ...]');
    process.exit(0);
  }
}
if (repos.length === 0) repos.push(process.cwd());

const token = randomBytes(12).toString('base64url');
const children = [];
const killAll = () => {
  for (const c of children) {
    if (!c.pid) continue;
    try {
      if (win) execFileSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill();
    } catch {
      /* already gone */
    }
  }
};
process.on('SIGINT', () => {
  killAll();
  process.exit(0);
});
process.on('exit', killAll);

const server = spawn(bin('server', 'tsx'), [join(root, 'packages', 'server', 'src', 'cli.ts'), ...repos.flatMap((r) => ['--repo', r]), '--token', token], {
  stdio: ['ignore', 'pipe', 'inherit'],
  shell: win,
});
children.push(server);

const ready = await new Promise((res, rej) => {
  let buf = '';
  server.stdout.on('data', (d) => {
    buf += d.toString();
    const m = /ORCA_GIT_GRAPH_READY (.*)\n/.exec(buf);
    if (m) res(JSON.parse(m[1]));
  });
  server.once('exit', (c) => rej(new Error(`server exited (${c})`)));
});

const vite = spawn(bin('web', 'vite'), ['--strictPort', '--port', '5173'], {
  cwd: join(root, 'packages', 'web'),
  env: { ...process.env, ORCA_GIT_GRAPH_PORT: String(ready.port) },
  stdio: ['ignore', 'inherit', 'inherit'],
  shell: win,
});
children.push(vite);
vite.once('exit', (c) => {
  killAll();
  process.exit(c ?? 0);
});

console.log('');
for (const r of ready.repos) {
  console.log(`  ${r.name}: http://127.0.0.1:5173/?repo=${encodeURIComponent(r.id)}&token=${token}`);
}
console.log(`  (API on 127.0.0.1:${ready.port}; Ctrl+C to stop)\n`);
