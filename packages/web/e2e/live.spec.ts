import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'E2E',
  GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'E2E',
  GIT_COMMITTER_EMAIL: 'e2e@example.com',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
const row = (page: Page, text: string) => page.locator('.row', { hasText: text }).first();

// These tests change the "live" repository; run them one after another (workers: 1) and never touch the demo repo.
test.describe.configure({ mode: 'serial' });

test.describe('live updates', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(process.env.OGG_LIVE_URL!);
    await expect(page.locator('.row[data-hash]').first()).toBeVisible();
  });

  test('new commits and branches appear without reloading; selection and comparison survive', async ({ page }) => {
    const live = process.env.OGG_LIVE_PATH!;
    await row(page, 'Local: theme tests').click();
    await page.keyboard.press('c'); // compare mode with the first preset
    await expect(page.locator('.compare-sentence')).toBeVisible();

    git(live, 'commit', '--allow-empty', '-m', 'E2E: freshly committed');
    git(live, 'branch', 'e2e-new-branch');

    await expect(row(page, 'E2E: freshly committed')).toBeVisible({ timeout: 15_000 });
    await expect(row(page, 'E2E: freshly committed').locator('.badge-head')).toContainText('main');
    await expect(page.locator('.badge', { hasText: 'e2e-new-branch' })).toBeVisible();
    // the comparison and the selection are still there; the comparison picked up the new commit (4 ahead now)
    await expect(page.locator('.comparebar')).toBeVisible();
    await expect(page.locator('.big-ahead')).toHaveText('4');
    await expect(page.locator('.row.selected')).toContainText('Local: theme tests');
  });

  test('keeps the scroll position when refs change', async ({ page }) => {
    const live = process.env.OGG_LIVE_PATH!;
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.locator('.tbody').evaluate((el) => (el.scrollTop = 400));
    await page.waitForTimeout(300);
    const probe = () =>
      page.evaluate(() => {
        const tb = document.querySelector('.tbody')!.getBoundingClientRect();
        const r = [...document.querySelectorAll<HTMLElement>('.row[data-hash]')].find((e) => e.getBoundingClientRect().top >= tb.top)!;
        return { hash: r.dataset.hash!, top: Math.round(r.getBoundingClientRect().top - tb.top) };
      });
    const before = await probe();
    const listHeight = () => page.evaluate(() => document.querySelector<HTMLElement>('.tbody > div')!.offsetHeight);
    const h0 = await listHeight();

    git(live, 'commit', '--allow-empty', '-m', 'E2E: scroll anchor 1');
    git(live, 'commit', '--allow-empty', '-m', 'E2E: scroll anchor 2');
    // wait for the refresh to land: two more rows
    await expect.poll(listHeight, { timeout: 15_000 }).toBeGreaterThanOrEqual(h0 + 2 * 30);
    await page.waitForTimeout(800);
    // the very same commit must still be on screen, at (about) the same place
    const topOf = (hash: string) =>
      page.evaluate((h) => {
        const tb = document.querySelector('.tbody')!.getBoundingClientRect();
        const r = document.querySelector<HTMLElement>(`.row[data-hash="${h}"]`);
        return r ? Math.round(r.getBoundingClientRect().top - tb.top) : null;
      }, hash);
    await expect.poll(() => topOf(before.hash)).not.toBeNull();
    const after = (await topOf(before.hash))!;
    expect(Math.abs(after - before.top)).toBeLessThanOrEqual(5);
  });

  test('Fetch brings in commits that were pushed to the remote', async ({ page }) => {
    const origin = process.env.OGG_LIVE_ORIGIN!;
    const tmp = mkdtempSync(join(tmpdir(), 'ogg-e2e-push-'));
    try {
      git(tmp, 'clone', '-q', origin, 'c');
      const c = join(tmp, 'c');
      git(c, 'commit', '--allow-empty', '-m', 'E2E: pushed by someone else');
      git(c, 'push', '-q', 'origin', 'main');
      await expect(page.locator('.row', { hasText: 'pushed by someone else' })).toHaveCount(0);
      await page.getByRole('button', { name: /Fetch/ }).click();
      await expect(row(page, 'E2E: pushed by someone else')).toBeVisible({ timeout: 20_000 });
      await expect(row(page, 'E2E: pushed by someone else').locator('.badge-remote')).toContainText('origin/main');
      await expect(page.locator('.ok-mark')).toBeVisible();
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  test('a single ref can be hidden from the graph', async ({ page }) => {
    await expect(row(page, 'Collaborator: bump CI node version')).toBeVisible();
    await page.getByRole('button', { name: '表示' }).click();
    await page.getByPlaceholder('ref を絞り込み').fill('origin/main');
    await page.locator('.ref-filter label', { hasText: 'origin/main' }).getByRole('checkbox').uncheck();
    await expect(page.locator('.row', { hasText: 'Collaborator: bump CI node version' })).toHaveCount(0);
    // other refs are still shown
    await expect(row(page, 'Search: add query parser')).toBeVisible();
    await page.getByRole('button', { name: 'すべて表示' }).click();
    await expect(row(page, 'Collaborator: bump CI node version')).toBeVisible();
  });
});
