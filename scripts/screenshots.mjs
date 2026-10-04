#!/usr/bin/env node
// Generates the README screenshots from a fictional demo repository (never a real one).
//
//   node scripts/screenshots.mjs [outDir=docs/images]
//
// Requires the web UI to be built (`pnpm build`) and Playwright's Chromium (`pnpm --filter @orca-git-graph/web exec playwright install chromium`).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'docs', 'images'));
mkdirSync(out, { recursive: true });

const require = createRequire(join(root, 'packages', 'web', 'package.json'));
const { chromium } = require('@playwright/test');

const tmp = mkdtempSync(join(tmpdir(), 'ogg-shots-'));
const demo = join(tmp, 'acme-widgets');
execFileSync('node', [join(root, 'scripts', 'make-demo-repo.mjs'), demo], { stdio: 'inherit' });

const win = process.platform === 'win32';
const tsx = join(root, 'packages', 'server', 'node_modules', '.bin', win ? 'tsx.cmd' : 'tsx');
const server = spawn(tsx, [join(root, 'packages', 'server', 'src', 'cli.ts'), '--repo', demo, '--web-dir', join(root, 'packages', 'web', 'dist')], {
  stdio: ['ignore', 'pipe', 'inherit'],
  shell: win,
});
const ready = await new Promise((res, rej) => {
  let buf = '';
  server.stdout.on('data', (d) => {
    buf += d.toString();
    const m = /ORCA_GIT_GRAPH_READY (.*)\n/.exec(buf);
    if (m) res(JSON.parse(m[1]));
  });
  server.once('exit', (c) => rej(new Error(`server exited (${c})`)));
});
const base = `http://127.0.0.1:${ready.port}/?repo=${encodeURIComponent(ready.repos[0].id)}&token=${ready.token}`;

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
try {
  for (const [lang, scheme] of [['en', 'light'], ['en', 'dark'], ['ja', 'dark']]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme, deviceScaleFactor: 1, locale: lang === 'ja' ? 'ja-JP' : 'en-US' });
    const page = await ctx.newPage();
    await page.goto(`${base}&lang=${lang}`);
    await page.locator('.row[data-hash]').first().waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, `graph-${lang}-${scheme}.png`) });

    await page.locator('.row', { hasText: 'Merge feature/login' }).first().click();
    await page.locator('.detail .d2h-wrapper').waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `commit-${lang}-${scheme}.png`) });
    await page.keyboard.press('Escape');

    await page.keyboard.press('c');
    await page.locator('.compare-sentence').waitFor();
    await page.locator('.detail .d2h-wrapper').waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, `compare-${lang}-${scheme}.png`) });
    await ctx.close();
  }
} finally {
  await browser.close();
  if (win && server.pid) {
    try {
      execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
  } else server.kill();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(`screenshots written to ${out}`);
