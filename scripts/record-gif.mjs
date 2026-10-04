#!/usr/bin/env node
// Records the README demo GIFs (compare mode) from a fictional demo repository.
//
//   node scripts/record-gif.mjs [outDir=docs/images]
//
// Requires `pnpm build` and Playwright's Chromium. Frames are screenshots assembled with gifenc (no ffmpeg needed).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'docs', 'images'));
mkdirSync(out, { recursive: true });

const require = createRequire(join(root, 'package.json'));
const { chromium } = createRequire(join(root, 'packages', 'web', 'package.json'))('@playwright/test');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { PNG } = require('pngjs');

const tmp = mkdtempSync(join(tmpdir(), 'ogg-gif-'));
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

const W = 1000;
const H = 620;
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
try {
  for (const lang of ['en', 'ja']) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'dark', locale: lang === 'ja' ? 'ja-JP' : 'en-US' });
    const page = await ctx.newPage();
    await page.goto(`${base}&lang=${lang}`);
    await page.locator('.row[data-hash]').first().waitFor();
    // shorter detail pane so the graph keeps most of the picture
    await page.evaluate(() => localStorage.setItem('orca-git-graph:settings:v1', JSON.stringify({ detailHeight: 230, showMinimap: true })));
    await page.reload();
    await page.locator('.row[data-hash]').first().waitFor();
    await page.waitForTimeout(500);

    const frames = [];
    const shot = async (holdMs) => frames.push({ png: await page.screenshot(), holdMs });

    await shot(1600); // the whole repository
    await page.keyboard.press('c'); // compare: main vs origin/main
    await page.locator('.compare-sentence').waitFor();
    await page.locator('.detail .d2h-wrapper').waitFor();
    await page.waitForTimeout(500);
    await shot(2800); // ahead / behind, A-only / B-only, merge base
    await page.getByRole('button', { name: 'A↔B' }).click();
    await page.waitForTimeout(500);
    await shot(1500);
    await page.getByRole('button', { name: 'A…B' }).click();
    await page.waitForTimeout(400);
    // compare a tag with a feature branch: pick A and B from the selectors
    await page.locator('.comparebar select').first().selectOption('v0.2.0');
    await page.locator('.comparebar select').nth(1).selectOption('release/1.0');
    await page.locator('.compare-sentence').filter({ hasText: 'v0.2.0' }).waitFor();
    await page.waitForTimeout(700);
    await shot(2800);

    if (process.env.GIF_FRAMES_DIR) frames.forEach((f, i) => writeFileSync(join(process.env.GIF_FRAMES_DIR, `${lang}-${i}.png`), f.png));
    const enc = GIFEncoder();
    for (const f of frames) {
      const png = PNG.sync.read(f.png);
      const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);
      const palette = quantize(rgba, 128);
      enc.writeFrame(applyPalette(rgba, palette), png.width, png.height, { palette, delay: f.holdMs });
    }
    enc.finish();
    const file = join(out, `demo-compare-${lang}.gif`);
    writeFileSync(file, enc.bytes());
    console.log(`${file}  ${(enc.bytes().length / 1024).toFixed(0)} KB, ${frames.length} frames`);
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
