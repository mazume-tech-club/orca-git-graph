import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
    readonly overflow = false,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  /** Exit codes treated as success (e.g. `git diff --no-index` returns 1 when files differ) */
  okCodes?: number[];
  /** Treat pathspecs literally (no glob magic) */
  literalPathspecs?: boolean;
  env?: Record<string, string>;
}

/**
 * The only place that spawns `git`. Always `execFile` with an argument array: no shell, no string
 * concatenation. Callers must pass validated refs / resolved hashes only.
 */
export function git(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<string> {
  const globalArgs = ['-C', cwd, '-c', 'core.quotepath=off', '-c', 'color.ui=never'];
  if (opts.literalPathspecs) globalArgs.push('--literal-pathspecs');
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...globalArgs, ...args],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024,
        env: {
          ...process.env,
          // read-only tool: never take the index lock or prompt for credentials
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          ...opts.env,
        },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const code = typeof err.code === 'number' ? err.code : null;
        if (code !== null && opts.okCodes?.includes(code)) return resolve(stdout);
        const overflow = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        reject(new GitError(`git ${args[0] ?? ''} failed: ${stderr.trim() || err.message}`, stderr, code, overflow));
      },
    );
  });
}
