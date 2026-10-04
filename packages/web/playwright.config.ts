import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    // set PW_CHANNEL=msedge (or chrome) to use an installed browser instead of the bundled Chromium
    channel: process.env.PW_CHANNEL || undefined,
    locale: 'ja-JP',
  },
});
