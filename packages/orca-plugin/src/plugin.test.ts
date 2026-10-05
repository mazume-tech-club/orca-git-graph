import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import activate from './worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '..', 'orca-plugin.json'), 'utf8')) as {
  manifestVersion: number;
  pluginApi: number;
  id: string;
  publisher: string;
  version: string;
  main: string;
  engines: { orca: string };
  contributes: { commands: Array<{ id: string }>; keybindings: Array<{ command: string; key: string }> };
  capabilities: Array<{ kind: string }>;
};

// The capability kinds and id rules below mirror Orca 1.4.x's manifest validation (src/shared/plugins/*).
const CAPABILITY_KINDS = ['workspace:read', 'terminal:send', 'notifications:show', 'storage', 'secrets', 'events:subscribe', 'settings:own'];
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('orca-plugin.json', () => {
  it('follows the v0 manifest rules', () => {
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.pluginApi).toBe(1);
    expect(manifest.id).toMatch(ID_RE);
    expect(manifest.publisher).toMatch(ID_RE);
    expect(manifest.publisher).not.toBe('stablyai'); // reserved
    expect(manifest.id.startsWith('orca-')).toBe(false); // reserved prefix
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.engines.orca).toMatch(/^>=\d+\.\d+\.\d+$/);
    expect(manifest.main).toBe('worker.mjs');
  });

  it('asks only for the capabilities it uses', () => {
    expect(manifest.capabilities.map((c) => c.kind).sort()).toEqual(['notifications:show', 'terminal:send', 'workspace:read']);
    for (const c of manifest.capabilities) expect(CAPABILITY_KINDS).toContain(c.kind);
  });

  it('binds keybindings to declared commands', () => {
    const ids = manifest.contributes.commands.map((c) => c.id);
    for (const kb of manifest.contributes.keybindings) expect(ids).toContain(kb.command);
  });
});

describe('worker', () => {
  it('registers every command the manifest declares (an unregistered one makes Orca fail to start the plugin)', async () => {
    const registered: string[] = [];
    await activate({
      commands: { register: (id) => void registered.push(id) },
      host: { call: async () => null },
      log: () => undefined,
    });
    expect(registered.sort()).toEqual(manifest.contributes.commands.map((c) => c.id).sort());
  });
});
