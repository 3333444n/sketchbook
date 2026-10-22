import { defineConfig } from '@playwright/test'

// E2E tests drive the *production* build (out/main/index.js) through Electron.
// Run with `pnpm test:e2e` (builds first).
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})
