import { defineConfig } from 'vitest/config';

// e2e/*.spec.ts belongs to Playwright (`pnpm test:e2e`)
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
