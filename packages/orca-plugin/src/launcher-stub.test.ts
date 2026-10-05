import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STUB_DIR_NAME, STUB_FILE_NAME, stubPath, writeLauncherStub } from './launcher-stub.js';
import activate from './worker.js';

const here = dirname(fileURLToPath(import.meta.url));
let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ogg-stub-'));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

describe('launcher stub', () => {
  it('forwards to the real open.mjs when run with node', async () => {
    const marker = join(home, 'ran.txt');
    const open = join(home, 'real dir', 'open.mjs'); // a path with a space
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(join(home, 'real dir'))})`]);
    writeFileSync(open, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ok');\n`);
    const file = await writeLauncherStub(open, home);
    expect(file).toBe(stubPath(home));
    execFileSync(process.execPath, [file]);
    expect(existsSync(marker)).toBe(true);
  });

  it('is rewritten on every start, so a moved plugin is found again', async () => {
    await writeLauncherStub(join(home, 'old', 'open.mjs'), home);
    await writeLauncherStub(join(home, 'new', 'open.mjs'), home);
    expect(readFileSync(stubPath(home), 'utf8')).toContain('/new/open.mjs');
  });

  it('reports a missing target instead of crashing silently', async () => {
    const file = await writeLauncherStub(join(home, 'missing', 'open.mjs'), home);
    let stderr = '';
    try {
      execFileSync(process.execPath, [file], { stdio: 'pipe' });
    } catch (e) {
      stderr = String((e as { stderr?: Buffer }).stderr);
    }
    expect(stderr).toContain('Git Graph: could not start');
  });

  it('uses the path the panel types (the two must stay in sync)', () => {
    const panel = readFileSync(join(here, '..', 'panels', 'launcher.html'), 'utf8');
    expect(panel).toContain(`'/${STUB_DIR_NAME}/${STUB_FILE_NAME}'`);
  });

  it('is written by the worker when it starts', async () => {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    await activate({ commands: { register: () => undefined }, host: { call: async () => null }, log: () => undefined });
    const t0 = Date.now();
    while (!existsSync(stubPath(home)) && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(stubPath(home))).toBe(true);
  });
});

// Orca resolves a panel's `icon` from a fixed list (right-sidebar activity bar, Orca 1.4.220): the name is lower-cased and
// dashes are dropped, and anything else silently becomes the generic plug icon. A name like "git-graph" does NOT work.
const ORCA_PANEL_ICONS = [
  'activity', 'barchart3', 'bell', 'blocks', 'book', 'bot', 'bug', 'calendar', 'cloud', 'code', 'database', 'filetext', 'flag',
  'folder', 'gauge', 'globe', 'hammer', 'layers', 'lightbulb', 'package', 'plug', 'puzzle', 'rocket', 'star', 'terminal', 'wrench', 'zap',
];

describe('manifest panel icon', () => {
  it('is one of the icons Orca knows, and not the generic plug it falls back to', () => {
    const manifest = JSON.parse(readFileSync(join(here, '..', 'orca-plugin.json'), 'utf8')) as { contributes: { panels: Array<{ icon: string }> } };
    for (const p of manifest.contributes.panels) {
      const key = p.icon.replaceAll('-', '').toLowerCase();
      expect(ORCA_PANEL_ICONS).toContain(key);
      expect(key).not.toBe('plug');
    }
  });
});

describe('manifest panel', () => {
  const manifest = JSON.parse(readFileSync(join(here, '..', 'orca-plugin.json'), 'utf8')) as {
    contributes: { panels: Array<{ id: string; title: string; entry: string }> };
    capabilities: Array<{ kind: string }>;
  };
  it('declares the panel, whose entry file exists, and the terminal:send capability it needs', () => {
    expect(manifest.contributes.panels).toHaveLength(1);
    for (const p of manifest.contributes.panels) expect(existsSync(join(here, '..', p.entry))).toBe(true);
    expect(manifest.capabilities.map((c) => c.kind)).toContain('terminal:send');
  });
});
