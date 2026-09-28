// Environment of the e2e run. `E2E_BASE_URL` points at a running production server (and disables the webServer of
// playwright.config.ts); without it the config starts `pnpm start:e2e` on :8899.
import process from 'node:process'

/** The `pnpm start:e2e` server, the same default as playwright.config.ts. */
export const DEFAULT_BASE_URL = 'http://localhost:8899'

/** Base URL of the server under test. Prefer the `baseURL` fixture inside tests. */
export function baseUrlFromEnv(): string {
  return process.env.E2E_BASE_URL ?? DEFAULT_BASE_URL
}

/** `http://host:port/api` for a server base URL. */
export function apiBaseUrl(baseURL: string): string {
  return new URL('/api', baseURL).href
}
