import { expect, test, type Page } from '@playwright/test';

const demo = () => process.env.OGG_DEMO_URL!;
const row = (page: Page, text: string) => page.locator('.row', { hasText: text }).first();

test.describe('graph view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(demo());
    await expect(page.locator('.row[data-hash]').first()).toBeVisible();
  });

  test('shows commits, ref badges, tags and the uncommitted row', async ({ page }) => {
    await expect(page.locator('.row-uncommitted')).toContainText('未コミットの変更');
    await expect(row(page, 'Local: docs for themes').locator('.badge-local.badge-head')).toContainText('main');
    await expect(row(page, 'Collaborator: bump CI node version').locator('.badge-remote')).toContainText('origin/main');
    await expect(row(page, 'Release 1.0.0').locator('.badge-tag')).toContainText('v1.0.0');
    // local branch and its remote on the same commit are fused into one badge
    await expect(row(page, 'Release 1.0.0').locator('.badge-local .badge-fused')).toContainText('origin');
    await expect(page).toHaveTitle(/acme-widgets/);
  });

  test('draws the lane graph with merge commits', async ({ page }) => {
    const merge = row(page, 'Merge feature/login');
    // a merge commit is a hollow dot with lanes drawn through the row (vertical lines have no width, so count paths)
    await expect(merge.locator('svg.graph-svg circle').first()).toBeVisible();
    expect(await merge.locator('svg.graph-svg path').count()).toBeGreaterThan(1);
    await expect(merge.locator('.merge-mark')).toBeVisible();
  });

  test('selecting a commit shows its files and diff', async ({ page }) => {
    await row(page, 'Merge feature/login').click();
    const detail = page.locator('.detail');
    await expect(detail).toContainText('Merge feature/login');
    await expect(detail.locator('.filelist li').first()).toBeVisible();
    await expect(detail.locator('.d2h-wrapper')).toBeVisible();
    // the selected row stays visible above the pane
    await expect(row(page, 'Merge feature/login')).toBeInViewport();
    // clicking another file switches the diff
    const second = detail.locator('.filelist li').nth(1);
    const name = await second.locator('.name').innerText();
    await second.click();
    await expect(second).toHaveClass(/selected/);
    expect(name.length).toBeGreaterThan(0);
  });

  test('uncommitted changes show their diff', async ({ page }) => {
    await page.locator('.row-uncommitted').click();
    const detail = page.locator('.detail');
    await expect(detail.locator('.filelist li')).toHaveCount(2);
    await expect(detail).toContainText('NOTES.txt');
  });

  test('search finds by message, author and ref', async ({ page }) => {
    const input = page.getByRole('searchbox');
    await input.fill('validate');
    await input.press('Enter');
    await expect(page.locator('.search-count')).toHaveText('1/1');
    await expect(row(page, 'Login: validate input')).toHaveClass(/match-active/);
    await input.fill('v1.0.0');
    await input.press('Enter');
    await expect(page.locator('.search-count')).toHaveText('1/1');
    await input.fill('no-such-thing');
    await input.press('Enter');
    await expect(page.locator('.search-count')).toHaveText('該当なし');
    await input.fill('Chen Wei');
    await input.press('Enter');
    await expect(page.locator('.search-count')).toContainText('1/');
    await input.press('Enter');
    await expect(page.locator('.search-count')).toContainText('2/');
  });

  test('keyboard: j/k move, / focuses search, c toggles compare, Escape clears', async ({ page }) => {
    await page.locator('.row[data-hash]').first().click();
    const first = await page.locator('.row.selected').getAttribute('data-hash');
    await page.keyboard.press('j');
    await expect(page.locator('.row.selected')).not.toHaveAttribute('data-hash', first!);
    await page.keyboard.press('k');
    await expect(page.locator('.row.selected')).toHaveAttribute('data-hash', first!);
    await page.keyboard.press('/');
    await expect(page.getByRole('searchbox')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('c');
    await expect(page.locator('.comparebar')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.comparebar')).toBeHidden();
  });

  test('filters hide remote branches from the graph', async ({ page }) => {
    await expect(row(page, 'Collaborator: bump CI node version')).toBeVisible();
    await page.getByRole('button', { name: '表示' }).click();
    await page.getByLabel('リモートブランチ').uncheck();
    // origin-only commits disappear, local ones stay
    await expect(page.locator('.row', { hasText: 'Collaborator: bump CI node version' })).toHaveCount(0);
    await expect(row(page, 'Local: docs for themes')).toBeVisible();
    await page.getByLabel('リモートブランチ').check();
    await expect(row(page, 'Collaborator: bump CI node version')).toBeVisible();
  });

  test('theme and density settings apply and persist', async ({ page }) => {
    await page.getByRole('button', { name: '密度' }).click();
    await page.getByRole('radio', { name: 'ダーク' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('radio', { name: 'コンパクト' }).click();
    await expect(page.locator('.table')).toHaveCSS('--row-h', '24px');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('compare mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(demo());
    await expect(page.locator('.row[data-hash]').first()).toBeVisible();
  });

  test('shows ahead/behind, marks A-only / B-only commits and the merge base', async ({ page }) => {
    await page.getByRole('button', { name: /比較/ }).first().click();
    const bar = page.locator('.comparebar');
    await expect(bar.locator('.compare-sentence')).toHaveText('main は origin/main より 3 進んでいて、2 遅れている');
    await expect(bar.locator('.big-ahead')).toHaveText('3');
    await expect(bar.locator('.big-behind')).toHaveText('2');
    await expect(page.locator('.row[data-side="A"]')).toHaveCount(3);
    await expect(page.locator('.row[data-side="B"]')).toHaveCount(2);
    await expect(page.locator('.row[data-side="base"]')).toContainText('Cleanup');
    // the side is also readable without colour: shapes and letters
    await expect(page.locator('.row[data-side="A"] .side-tag').first()).toHaveText('A');
    await expect(page.locator('.row[data-side="B"] .side-tag').first()).toHaveText('B');
    await expect(page.locator('.row[data-side="base"] .side-tag')).toHaveText('◆');
    // changed files between the two sides, with a bar per file
    await expect(page.locator('.detail .filelist li').first()).toBeVisible();
    await expect(page.locator('.detail .bar').first()).toBeVisible();
  });

  test('picks A and B by clicking ref badges, and swaps them', async ({ page }) => {
    await row(page, 'Release 1.0.0').locator('.badge-tag .badge-main').click();
    await expect(page.locator('.comparebar select').first()).toHaveValue('v1.0.0');
    await row(page, 'Search: add query parser').locator('.badge-local .badge-main').click();
    await expect(page.locator('.comparebar select').nth(1)).toHaveValue('feature/search');
    await expect(page.locator('.compare-sentence')).toContainText('v1.0.0');
    await page.getByRole('button', { name: 'A と B を入れ替え' }).click();
    await expect(page.locator('.comparebar select').first()).toHaveValue('feature/search');
  });

  test('works for tags and remote branches, with three-dot and two-dot modes', async ({ page }) => {
    await page.getByRole('button', { name: /比較/ }).first().click();
    await page.locator('.comparebar select').first().selectOption('v0.2.0');
    await page.locator('.comparebar select').nth(1).selectOption('origin/feature/login');
    await expect(page.locator('.compare-sentence')).toContainText('v0.2.0');
    await expect(page.locator('.detail .filelist-head')).toContainText('ファイルの変更');
    await page.getByRole('button', { name: 'A↔B' }).click();
    await expect(page.locator('.detail')).toContainText('直接比較');
  });

  test('ends the comparison', async ({ page }) => {
    await page.getByRole('button', { name: /比較/ }).first().click();
    await page.getByRole('button', { name: '比較を終了' }).click();
    await expect(page.locator('.comparebar')).toBeHidden();
    await expect(page.locator('.row[data-side]')).toHaveCount(0);
  });

  test('minimap is drawn', async ({ page }) => {
    await expect(page.locator('.minimap canvas')).toBeVisible();
  });
});

test.describe('security', () => {
  test('the API cannot be used without the token', async ({ request }) => {
    const res = await request.get(`${process.env.OGG_BASE}/api/repo`);
    expect(res.status()).toBe(401);
  });
});

test.describe('large repository (10k+ commits)', () => {
  test('renders the first screen quickly and scrolls smoothly', async ({ page }) => {
    const t0 = Date.now();
    await page.goto(process.env.OGG_LARGE_URL!);
    await expect(page.locator('.row[data-hash]').first()).toBeVisible();
    const firstPaint = Date.now() - t0;
    console.log(`first rows visible after ${firstPaint} ms`);
    expect(firstPaint).toBeLessThan(2000);

    // scroll through the list for ~2 s and record frame times
    const stats = await page.evaluate(async () => {
      const el = document.querySelector('.tbody') as HTMLElement;
      const frames: number[] = [];
      let last = performance.now();
      const start = last;
      await new Promise<void>((done) => {
        const step = (now: number) => {
          frames.push(now - last);
          last = now;
          el.scrollTop += 900;
          if (now - start < 2000) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      frames.sort((a, b) => a - b);
      return { n: frames.length, p50: frames[Math.floor(frames.length * 0.5)]!, p95: frames[Math.floor(frames.length * 0.95)]!, max: frames[frames.length - 1]! };
    });
    console.log(`scroll frames: ${JSON.stringify(stats)}`);
    expect(stats.n).toBeGreaterThan(20);
    expect(stats.p95).toBeLessThan(50);
    await expect(page.locator('.row[data-hash]').first()).toBeVisible();
  });

  test('search jumps to a commit far down the history', async ({ page }) => {
    await page.goto(process.env.OGG_LARGE_URL!);
    const input = page.getByRole('searchbox');
    await input.fill('commit 2500:');
    await input.press('Enter');
    // the generated history has a main-line and a side-branch commit with this number
    await expect(page.locator('.search-count')).toHaveText('1/2');
    await expect(page.locator('.row.match-active')).toContainText('commit 2500:');
  });
});

test.describe('compare scrolling', () => {
  test('brings the compared commits into view even when the list was scrolled elsewhere', async ({ page }) => {
    await page.goto(process.env.OGG_DEMO_URL!);
    await expect(page.locator('.row[data-hash]').first()).toBeVisible();
    await page.locator('.tbody').evaluate((el) => (el.scrollTop = 400));
    await page.keyboard.press('c');
    await expect(page.locator('.compare-sentence')).toBeVisible();
    await expect(page.locator('.row[data-side="A"]').first()).toBeInViewport();
    await expect(page.locator('.row[data-side="base"]')).toBeInViewport();
  });
});
