import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_VERSION, cliEnv, dataDir, identityPath, loadIdentity, saveIdentity, lockPath, matchWorktree, readLock, removeLock, resolveOrcaCli, writeLock, type OrcaTerminal, type OrcaWorktree } from './index.js';

let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ogg-platform-'));
  process.env.ORCA_GIT_GRAPH_DATA_DIR = join(dir, 'data');
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

describe('lock file', () => {
  it('round-trips and is removed', async () => {
    expect(await readLock()).toBeNull();
    await writeLock({ port: 1234, token: 't', pid: 42, startedAt: 1, apiVersion: API_VERSION });
    expect(await readLock()).toMatchObject({ port: 1234, token: 't', pid: 42 });
    await removeLock();
    expect(await readLock()).toBeNull();
  });

  it('only removes its own lock when asked to', async () => {
    await writeLock({ port: 1, token: 't', pid: 42, startedAt: 1, apiVersion: API_VERSION });
    await removeLock(7);
    expect(await readLock()).not.toBeNull();
    await removeLock(42);
    expect(await readLock()).toBeNull();
  });

  it('ignores a corrupt lock file', async () => {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(lockPath(), '{not json');
    expect(await readLock()).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('is private to the user on POSIX', async () => {
    await writeLock({ port: 1, token: 't', pid: 1, startedAt: 1, apiVersion: API_VERSION });
    expect(statSync(lockPath()).mode & 0o077).toBe(0);
    expect(statSync(dataDir()).mode & 0o077).toBe(0);
  });
});

describe('resolveOrcaCli', () => {
  it('prefers the explicit setting, then ORCA_CLI, then PATH', () => {
    const a = join(dir, 'a-orca');
    const b = join(dir, 'b-orca');
    writeFileSync(a, '');
    writeFileSync(b, '');
    delete process.env.ORCA_CLI;
    expect(resolveOrcaCli(a)).toBe(a);
    process.env.ORCA_CLI = b;
    expect(resolveOrcaCli(null)).toBe(b);
    expect(resolveOrcaCli(a)).toBe(a);
    // a setting that does not exist falls through to the next source
    expect(resolveOrcaCli(join(dir, 'missing'))).toBe(b);
  });

  it('finds orca on PATH', () => {
    const exe = join(dir, process.platform === 'win32' ? 'orca.exe' : 'orca');
    writeFileSync(exe, '');
    delete process.env.ORCA_CLI;
    process.env.PATH = dir;
    expect(resolveOrcaCli()).toBe(exe);
  });
});

describe('matchWorktree', () => {
  const wt = (id: string, name: string, branch: string): OrcaWorktree => ({ id, repoId: id.split('::')[0]!, hostId: 'local', kind: 'git', displayName: name, branch, path: id.split('::')[1]! });
  const a = wt('r1::/a', 'app', 'main');
  const b = wt('r2::/b', 'app', 'main');
  const c = wt('r3::/c', 'app', 'feature');
  const term = (handle: string, worktreeId: string): OrcaTerminal => ({ handle, ptyId: `${worktreeId}@@1`, worktreeId });

  it('matches a unique name', () => {
    expect(matchWorktree({ displayName: 'app', branch: 'main', terminals: [] }, [a], [])).toEqual({ kind: 'found', worktree: a });
  });
  it('uses the branch to tell same-named worktrees apart', () => {
    expect(matchWorktree({ displayName: 'app', branch: 'feature', terminals: [] }, [a, c], [])).toEqual({ kind: 'found', worktree: c });
  });
  it('uses terminal ids first (handle or pty id)', () => {
    expect(matchWorktree({ displayName: 'app', branch: 'main', terminals: [{ id: 'term_b' }] }, [a, b], [term('term_a', a.id), term('term_b', b.id)])).toEqual({ kind: 'found', worktree: b });
    expect(matchWorktree({ displayName: 'app', branch: 'main', terminals: [{ id: `${a.id}@@1` }] }, [a, b], [term('term_a', a.id)])).toEqual({ kind: 'found', worktree: a });
  });
  it('reports ambiguity and absence', () => {
    expect(matchWorktree({ displayName: 'app', branch: 'main', terminals: [] }, [a, b], []).kind).toBe('ambiguous');
    expect(matchWorktree({ displayName: 'nope', branch: '', terminals: [] }, [a], []).kind).toBe('none');
  });
  it('falls back to the name when the branch differs (e.g. detached HEAD)', () => {
    expect(matchWorktree({ displayName: 'app', branch: '', terminals: [] }, [a], [])).toEqual({ kind: 'found', worktree: a });
  });
});

describe('cliEnv', () => {
  it('completes the minimal environment a plugin worker gets (Windows)', () => {
    const env = cliEnv({ PATH: 'p', SystemRoot: 'sysroot', ELECTRON_RUN_AS_NODE: '1' }, 'win32', 'home');
    expect(env.USERPROFILE).toBe('home');
    expect(env.APPDATA).toBe(join('home', 'AppData', 'Roaming'));
    expect(env.LOCALAPPDATA).toBe(join('home', 'AppData', 'Local'));
    expect(env.PATH).toBe('p');
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
  it('keeps values that are already set', () => {
    const env = cliEnv({ USERPROFILE: 'X', APPDATA: 'Y', LOCALAPPDATA: 'Z' }, 'win32', 'H');
    expect([env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA]).toEqual(['X', 'Y', 'Z']);
  });
  it('sets HOME on POSIX', () => {
    expect(cliEnv({ PATH: 'p' }, 'linux', '/home/u').HOME).toBe('/home/u');
  });
});

describe('identity', () => {
  it('creates a token once and returns the same one afterwards', async () => {
    const a = await loadIdentity();
    expect(a.token.length).toBeGreaterThanOrEqual(24);
    expect(a.port).toBeNull();
    expect((await loadIdentity()).token).toBe(a.token);
    await saveIdentity({ token: a.token, port: 4321 });
    expect(await loadIdentity()).toEqual({ token: a.token, port: 4321 });
  });
  it('replaces a corrupt file', async () => {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(identityPath(), 'garbage');
    expect((await loadIdentity()).token.length).toBeGreaterThanOrEqual(24);
  });
  it.skipIf(process.platform === 'win32')('is private to the user on POSIX', async () => {
    await loadIdentity();
    expect(statSync(identityPath()).mode & 0o077).toBe(0);
  });
});
