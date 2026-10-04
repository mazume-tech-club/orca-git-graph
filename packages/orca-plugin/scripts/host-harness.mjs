#!/usr/bin/env node
// Runs the built plugin (dist/) inside Orca's REAL plugin worker host (`plugin-host-entry.js` from the
// installed Orca's app.asar, executed by the Orca binary in ELECTRON_RUN_AS_NODE mode), without loading the
// plugin through the Orca UI. Host calls are answered here; everything else (orca CLI, detached server,
// tabs) is real, so it opens a real tab in the running Orca.
//
//   node packages/orca-plugin/scripts/host-harness.mjs [--plugin <dir>] [--worktree <orca worktree id>] [--keep] [--minimal-env]
//   (--plugin defaults to packages/orca-plugin/dist; point it at a fresh clone of the release tree to test what Orca would install)
//
// Verified against Orca 1.4.220 on Windows. Opt-in manual check, not part of `pnpm test`.
import { execFileSync, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const pluginRoot = args.includes('--plugin') ? resolve(args[args.indexOf('--plugin') + 1]) : resolve(here, '..', 'dist');
const wtArg = args.includes('--worktree') ? args[args.indexOf('--worktree') + 1] : null;
const keep = args.includes('--keep');
// --minimal-env: give the worker only what Orca's real worker gets (no USERPROFILE/APPDATA/LOCALAPPDATA), to reproduce environment bugs
const minimalEnv = args.includes('--minimal-env');

function orcaBinary() {
  const candidates =
    process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'orca', 'Orca.exe')]
      : process.platform === 'darwin'
        ? ['/Applications/Orca.app/Contents/MacOS/Orca']
        : ['/opt/Orca/orca'];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('Orca binary not found; set ORCA_BIN');
  return process.env.ORCA_BIN ?? found;
}

const orcaBin = orcaBinary();
const hostEntry = join(dirname(orcaBin), 'resources', 'app.asar', 'out', 'main', 'plugin-host-entry.js');
const orcaCli = join(dirname(orcaBin), 'resources', 'bin', process.platform === 'win32' ? 'orca.exe' : 'orca');
const cli = (a) => JSON.parse(execFileSync(orcaCli, [...a, '--json'], { encoding: 'utf8' })).result;

// the worktree to pretend is focused
const worktrees = cli(['worktree', 'ps']).worktrees;
const wt = wtArg ? worktrees.find((w) => w.worktreeId === wtArg) : worktrees.find((w) => w.isActive) ?? worktrees[0];
if (!wt) throw new Error('no worktree found');
const terminals = cli(['terminal', 'list']).terminals.filter((t) => t.worktreeId === wt.worktreeId);
const context = { branch: wt.branch ?? '', displayName: wt.displayName, terminals: terminals.slice(0, 3).map((t) => ({ id: t.handle })) };
console.log('pretending focused worktree:', wt.worktreeId, JSON.stringify(context));

const child = fork(hostEntry, [], { execPath: orcaBin, env: minimalEnv ? { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: '1' } : { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
const pending = new Map();
let nextCall = 1;
let readyResolve;
const ready = new Promise((r) => (readyResolve = r));
child.on('message', (m) => {
  switch (m.type) {
    case 'ready':
      console.log('worker ready; commands =', m.commands);
      return readyResolve(m.commands);
    case 'log':
      return console.log(`[worker ${m.level}]`, m.message);
    case 'fatal':
      console.error('worker fatal:', m.error);
      return process.exit(1);
    case 'hostCall': {
      console.log('hostCall', m.method, JSON.stringify(m.params ?? null));
      let value = null;
      if (m.method === 'workspace.readContext') value = context;
      else if (m.method === 'notifications.show') value = { delivered: true };
      return child.send({ type: 'hostResult', callId: m.callId, ok: true, value });
    }
    case 'commandResult':
      return pending.get(m.callId)?.(m);
  }
});

const invoke = () =>
  new Promise((resolveInvoke) => {
    const callId = nextCall++;
    const t0 = performance.now();
    pending.set(callId, (m) => {
      console.log(`  (invoke ${callId} took ${Math.round(performance.now() - t0)} ms)`);
      resolveInvoke(m);
    });
    child.send({ type: 'invokeCommand', callId, commandId: 'open-git-graph' });
  });

const tInit = performance.now();
child.send({ type: 'init', pluginId: 'git-graph', pluginRoot, mainEntry: 'worker.mjs', grantedCapabilities: ['workspace:read', 'notifications:show'] });
await ready;
console.log(`  (worker start + activate took ${Math.round(performance.now() - tInit)} ms)`);

const first = await invoke();
console.log('first invoke ->', JSON.stringify(first));
// give the opened page time to load and connect, like a person who clicks again a moment later
await new Promise((r) => setTimeout(r, 2500));
const second = await invoke();
console.log('second invoke ->', JSON.stringify(second));

let exitCode = 0;
if (!first.ok || !first.value?.ok || first.value.action !== 'created') exitCode = 1;
if (!second.ok || !second.value?.ok || second.value.action !== 'switched') exitCode = 1;

// the server must be a separate process that outlives the worker
child.send({ type: 'shutdown' });
await new Promise((r) => child.once('exit', r));
const lockPath = join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'orca-git-graph', 'server.lock.json');
const lock = existsSync(lockPath) ? JSON.parse((await import('node:fs')).readFileSync(lockPath, 'utf8')) : null;
let survived = false;
if (lock) {
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/health?token=${lock.token}`);
    survived = res.ok;
  } catch {
    survived = false;
  }
}
console.log('server survived worker shutdown:', survived, lock ? `(pid ${lock.pid}, port ${lock.port})` : '');
if (!survived) exitCode = 1;

if (!keep) {
  // clean up what the harness created: our tabs and the server
  for (const t of cli(['tab', 'list', '--worktree', `id:${wt.worktreeId}`]).tabs) {
    if (t.url.includes('repo=') && t.url.includes('token=') && t.url.startsWith('http://127.0.0.1:')) {
      cli(['tab', 'close', '--page', t.browserPageId, '--worktree', `id:${wt.worktreeId}`]);
    }
  }
  if (lock) {
    try {
      process.kill(lock.pid);
    } catch {
      /* already gone */
    }
  }
}
console.log(exitCode === 0 ? 'HARNESS OK' : 'HARNESS FAILED');
process.exit(exitCode);
