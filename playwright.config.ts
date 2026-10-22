import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8899'
// The fake Brave / Tavily / Exa remote behind `HF_TEST_REMOTE_URL` (Phase 14; `pnpm start:e2e` uses the same port).
const fakeRemotePort = process.env.E2E_FAKE_REMOTE_PORT ?? '8889'

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
    // Voice specs (Phase 6, ADR-029): Chromium's fake microphone, granted without a prompt, and audio that may play
    // without a user gesture (read-aloud chunks after the first one).
    permissions: ['microphone'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /specs\/(?:mobile|tablet)\//,
    },
    {
      // Pixel 7 is a Chromium device, so CI needs no extra browser.
      name: 'mobile',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
      testMatch: /specs\/mobile\/.*\.spec\.ts$/,
    },
    {
      // A touch tablet wider than the 768 px sheet breakpoint (1024 x 640, coarse pointer), also Chromium (Phase 6,
      // 40 px icon-rail targets).
      name: 'tablet',
      use: { ...devices['Galaxy Tab S9 landscape'] },
      testMatch: /specs\/tablet\/.*\.spec\.ts$/,
    },
  ],
  // Started only when nothing answers on their URLs (a coordinator build or E2E_BASE_URL): first the fake search remote
  // (Phase 14), then the app, whose `start:e2e` points `HF_TEST_REMOTE_URL` at it.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: `node e2e/fixtures/fake-remote.mjs --port ${fakeRemotePort}`,
          url: `http://127.0.0.1:${fakeRemotePort}/`,
          reuseExistingServer: true,
          timeout: 30_000,
        },
        {
          command: 'pnpm start:e2e',
          url: 'http://localhost:8899/api/health',
          reuseExistingServer: true,
          timeout: 120_000,
        },
      ],
})
