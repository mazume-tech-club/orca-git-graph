import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AlreadyRunningError, startServer } from './server.js';
import { HttpError } from './repo.js';

const USAGE = `orca-git-graph server

  --repo <path>        repository to show (repeatable)
  --port <n>           listen port on 127.0.0.1 (default: random)
  --token <t>          fixed token (dev only; random by default)
  --web-dir <dir>      built web UI to serve (default: ../web/dist next to this file, if present)
  --idle-minutes <n>   exit after n idle minutes (default: never; the Orca plugin sets this)
  --orca               also allow worktrees reported by the Orca CLI
  --orca-cli <path>    path to the orca executable
  --lock               publish port/token in the user data dir (used by the Orca plugin)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', multiple: true },
      port: { type: 'string' },
      token: { type: 'string' },
      'web-dir': { type: 'string' },
      'idle-minutes': { type: 'string' },
      orca: { type: 'boolean' },
      'orca-cli': { type: 'string' },
      lock: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const defaultWeb = [join(here, 'web'), join(here, '..', '..', 'web', 'dist')].find((d) => existsSync(join(d, 'index.html')));
  const webDir = values['web-dir'] ? resolve(values['web-dir']) : defaultWeb;
  const idleMin = values['idle-minutes'] ? Number(values['idle-minutes']) : 0;

  let server;
  try {
    server = await startServer({
      repos: values.repo ?? [],
      port: values.port ? Number(values.port) : 0,
      token: values.token,
      webDir,
      idleTimeoutMs: idleMin * 60_000,
      orca: values.orca || values.lock,
      orcaCliSetting: values['orca-cli'],
      writeLockFile: values.lock,
    });
  } catch (e) {
    if (e instanceof AlreadyRunningError) {
      process.stdout.write(`ORCA_GIT_GRAPH_RUNNING ${JSON.stringify({ port: e.lock.port, pid: e.lock.pid })}\n`);
      return;
    }
    if (e instanceof HttpError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  // Machine-readable line for the dev script / launcher, then a human-readable one.
  process.stdout.write(`ORCA_GIT_GRAPH_READY ${JSON.stringify({ port: server.port, token: server.token, repos: server.repos })}\n`);
  for (const r of server.repos) {
    process.stdout.write(`${r.name}: http://127.0.0.1:${server.port}/?repo=${encodeURIComponent(r.id)}&token=${server.token}\n`);
  }

  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await server.closed;
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
