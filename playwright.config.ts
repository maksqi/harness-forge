import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8899'

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Started only when no server answers on the health URL (a coordinator build or E2E_BASE_URL).
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm start:e2e',
        url: 'http://localhost:8899/api/health',
        reuseExistingServer: true,
        timeout: 120_000,
      },
})
