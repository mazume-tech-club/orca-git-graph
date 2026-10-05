import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * The sidebar launcher panel (packages/orca-plugin/panels/launcher.html), run inside a stand-in for Orca's panel host:
 * a sandboxed iframe (opaque origin) with Orca's real panel CSP, answering the `orca-panel-action` postMessage protocol
 * (Orca 1.4.220: plugin-panel-bridge.js / plugin-panel-shell.js).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const panelHtml = readFileSync(join(root, 'packages', 'orca-plugin', 'panels', 'launcher.html'), 'utf8');

const PANEL_CSP =
  "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

// the texts asserted below are the English ones (the Japanese ones are checked in one dedicated test)
test.use({ locale: 'en-US' });

interface Call {
  action: string;
  params: unknown;
}

async function mountPanel(page: Page, opts: { terminals: Array<{ id: string }> | null; sendText?: 'ok' | 'fail' | 'rejected' }) {
  await page.setContent('<!doctype html><body style="margin:0"><iframe id="panel" sandbox="allow-scripts" style="width:300px;height:420px;border:0"></iframe></body>');
  await page.evaluate(
    ({ html, csp, ctx, sendText }) => {
      const w = window as unknown as { __calls: Call[] };
      w.__calls = [];
      const frame = document.getElementById('panel') as HTMLIFrameElement;
      window.addEventListener('message', (e) => {
        if (e.source !== frame.contentWindow || !e.data || e.data.type !== 'orca-panel-action') return;
        const { requestId, action, params } = e.data as { requestId: string; action: string; params: unknown };
        w.__calls.push({ action, params });
        let reply: Record<string, unknown>;
        if (action === 'workspace.readContext') reply = { ok: true, value: ctx === null ? null : { branch: 'main', displayName: 'demo', terminals: ctx } };
        else if (action === 'terminal.sendText') {
          reply = sendText === 'fail' ? { ok: false, errorCode: 'action_failed', error: 'terminal is outside the active worktree' } : { ok: true, value: { accepted: sendText !== 'rejected' } };
        } else reply = { ok: false, errorCode: 'invalid_request', error: 'not a panel-callable action' };
        frame.contentWindow!.postMessage({ type: 'orca-panel-action-result', requestId, ...reply }, '*');
      });
      // what Orca's shell prepends: the CSP meta first, so it applies before any plugin content
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${html}`;
    },
    { html: panelHtml, csp: PANEL_CSP, ctx: opts.terminals, sendText: opts.sendText ?? 'ok' },
  );
  const frame = page.frameLocator('#panel');
  await expect(frame.locator('#open')).toBeVisible();
  const calls = () => page.evaluate(() => (window as unknown as { __calls: Call[] }).__calls);
  return { frame, calls };
}

test.describe('launcher panel', () => {
  test('lists terminals but never picks one for the user, even when there is only one', async ({ page }) => {
    const { frame, calls } = await mountPanel(page, { terminals: [{ id: 'term_a' }] });
    await expect(frame.locator('#terminal option')).toHaveCount(2); // placeholder + one terminal
    await expect(frame.locator('#terminal')).toHaveValue('');
    await expect(frame.locator('#open')).toBeDisabled();
    await expect(frame.locator('#warn')).toContainText('Claude Code');
    expect((await calls()).filter((c) => c.action === 'terminal.sendText')).toHaveLength(0);
  });

  test('sends the command to the chosen terminal only, with Enter', async ({ page }) => {
    const { frame, calls } = await mountPanel(page, { terminals: [{ id: 'term_a' }, { id: 'term_b' }] });
    await frame.locator('#terminal').selectOption('term_b');
    await expect(frame.locator('#open')).toBeEnabled();
    await frame.locator('#open').click();
    await expect(frame.locator('#status')).toContainText('Sent');
    const sends = (await calls()).filter((c) => c.action === 'terminal.sendText');
    expect(sends).toHaveLength(1);
    const p = sends[0]!.params as { terminalId: string; text: string; enter: boolean };
    expect(p.terminalId).toBe('term_b');
    expect(p.enter).toBe(true);
    expect(p.text).toContain('.orca-git-graph/launch.mjs');
    expect(p.text.length).toBeLessThan(4096); // PANEL_ACTION_TEXT_MAX_LENGTH
  });

  test('uses only the three actions a panel may call', async ({ page }) => {
    const { frame, calls } = await mountPanel(page, { terminals: [{ id: 'term_a' }] });
    await frame.locator('#terminal').selectOption('term_a');
    await frame.locator('#open').click();
    await expect(frame.locator('#status')).toContainText('Sent');
    for (const c of await calls()) expect(['workspace.readContext', 'terminal.sendText', 'notifications.show']).toContain(c.action);
  });

  test('shows host errors instead of failing silently', async ({ page }) => {
    const { frame } = await mountPanel(page, { terminals: [{ id: 'term_a' }], sendText: 'fail' });
    await frame.locator('#terminal').selectOption('term_a');
    await frame.locator('#open').click();
    await expect(frame.locator('#status')).toContainText('terminal is outside the active worktree');
    await expect(frame.locator('#status')).toHaveClass(/error/);
    await expect(frame.locator('#open')).toBeEnabled(); // can retry
  });

  test('reports a rejected send', async ({ page }) => {
    const { frame } = await mountPanel(page, { terminals: [{ id: 'term_a' }], sendText: 'rejected' });
    await frame.locator('#terminal').selectOption('term_a');
    await frame.locator('#open').click();
    await expect(frame.locator('#status')).toContainText('not accepted');
  });

  test('explains when there is no terminal or no focused worktree', async ({ page }) => {
    const none = await mountPanel(page, { terminals: [] });
    await expect(none.frame.locator('#terminal option').first()).toContainText('no terminals');
    await expect(none.frame.locator('#open')).toBeDisabled();
    const noWorktree = await mountPanel(page, { terminals: null });
    await expect(noWorktree.frame.locator('#status')).toContainText('No worktree');
  });

  test('is shown in Japanese for a Japanese browser', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'ja-JP' });
    const page = await ctx.newPage();
    const { frame } = await mountPanel(page, { terminals: [{ id: 'term_a' }] });
    await expect(frame.locator('#open')).toHaveText('Git Graph を開く');
    await ctx.close();
  });

  test('works under the panel CSP: no network access at all', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    const { frame } = await mountPanel(page, { terminals: [{ id: 'term_a' }] });
    await frame.locator('#terminal').selectOption('term_a');
    await frame.locator('#open').click();
    await expect(frame.locator('#status')).toContainText('Sent');
    expect(requests.filter((u) => /^https?:/.test(u))).toEqual([]);
  });
});

test.describe('the command the panel types', () => {
  /** Captures the exact text the panel would type into a terminal. */
  async function typedCommand(page: Page): Promise<string> {
    const { frame, calls } = await mountPanel(page, { terminals: [{ id: 'term_a' }] });
    await frame.locator('#terminal').selectOption('term_a');
    await frame.locator('#open').click();
    await expect(frame.locator('#status')).toContainText('Sent');
    const send = (await calls()).find((c) => c.action === 'terminal.sendText')!;
    return (send.params as { text: string }).text;
  }

  /** A fake home with the stub the plugin worker writes, pointing at a script that leaves a marker file. */
  function fakeHome(): { home: string; marker: string; cleanup: () => void } {
    const home = mkdtempSync(join(tmpdir(), 'ogg-home-'));
    const marker = join(home, 'started.txt');
    const open = join(home, 'open.mjs');
    writeFileSync(open, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ok');\n`);
    mkdirSync(join(home, '.orca-git-graph'));
    // exactly what packages/orca-plugin/src/launcher-stub.ts writes
    const url = `file:///${open.replace(/\\/g, '/').replace(/^\//, '')}`;
    writeFileSync(
      join(home, '.orca-git-graph', 'launch.mjs'),
      `import(${JSON.stringify(url)}).catch((e) => { console.error('Git Graph: could not start - ' + e.message); process.exitCode = 1; });\n`,
    );
    return { home, marker, cleanup: () => rmSync(home, { recursive: true, force: true, maxRetries: 5 }) };
  }

  const shells: Array<{ name: string; run: (cmd: string, env: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync> }> = [
    { name: 'sh', run: (cmd, env) => spawnSync('sh', ['-c', cmd], { env, encoding: 'utf8' }) },
  ];
  if (process.platform === 'win32') {
    shells.push(
      { name: 'PowerShell', run: (cmd, env) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { env, encoding: 'utf8' }) },
      // cmd.exe: pass the line verbatim, as a person typing it would
      { name: 'cmd.exe', run: (cmd, env) => spawnSync('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true }) },
    );
  }

  for (const sh of shells) {
    test(`starts the launcher when typed into ${sh.name}`, async ({ page }) => {
      test.skip(sh.name === 'sh' && process.platform === 'win32' && !existsSync('C:\\Program Files\\Git\\usr\\bin\\sh.exe') && !whichSh(), 'no sh on this machine');
      const cmd = await typedCommand(page);
      const h = fakeHome();
      try {
        const env = { ...process.env, HOME: h.home, USERPROFILE: h.home };
        const r = sh.run(cmd, env);
        expect(r.status, `${sh.name}: ${r.stderr}${r.stdout}`).toBe(0);
        expect(existsSync(h.marker)).toBe(true);
      } finally {
        h.cleanup();
      }
    });
  }

  test('tells the user what to do when the launcher file does not exist yet', async ({ page }) => {
    const cmd = await typedCommand(page);
    const home = mkdtempSync(join(tmpdir(), 'ogg-emptyhome-'));
    try {
      const r = spawnSync('sh', ['-c', cmd], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
      expect(r.stdout + r.stderr).toContain('run Open Git Graph from the command palette once');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function whichSh(): boolean {
  try {
    execFileSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
