// Web search helpers for the Phase 14 specs (docs/UI.md 2.20, 7.35, 9.15, 13.14; docs/API.md 4.39; docs/PROVIDERS.md 8
// "MCP and search mocks (Phase 14)"; ADR-062, ADR-063): the two search mocks, the fake remote of the builtin `search_web`
// (`fixtures/fake-remote.mjs`: Brave Search, Tavily and Exa behind the server's `HF_TEST_REMOTE_URL`), and the search
// configuration, which is global state of the server: `useWebSearchConfig` changes it for one test and restores it
// through `cleanup` (registered first).
//
// - `mock:search` has a native (provider-executed) `web_search`: with the chat's web search on it answers a
//   `tool-web_search` part, two `source-url` parts and `Search done: 2 sources`, else `Search off`.
// - `mock:search-tool` has no native search: with `search_web` offered (the builtin of `core-search`, registered only
//   while the selected backend has a key) it calls it once and answers `Results: <title 1> | <title 2> | …`; without it
//   `Tools are disabled.`.
// - The fake remote answers the deterministic results `Result one` (`https://example.com/a`), `Result two`
//   (`https://example.org/b`), …; the key `invalid-key` answers 401, `rate-limited` 429. Its log (`GET /__log`) never
//   holds a key header.
import type { Locator, Page } from '@playwright/test'
import type { WebSearchBackend, WebSearchMode } from '../../packages/shared/src/index.ts'
import type { FakeRemoteLogEntry } from '../fixtures/fake-remote.mjs'
import type { HarnessApi } from './api.ts'
import type { CleanupTask } from './fixtures.ts'
import process from 'node:process'
import { RESULTS } from '../fixtures/fake-remote.mjs'
import { composer } from './chat.ts'
import { testIds } from './testids.ts'

export { INVALID_KEY, RATE_LIMITED_KEY } from '../fixtures/fake-remote.mjs'
export type { FakeRemoteLogEntry } from '../fixtures/fake-remote.mjs'

// ---------- the mocks ----------

/** Native (provider-executed) search. */
export const MOCK_SEARCH_MODEL = 'mock:search'
/** The builtin `search_web` of `core-search`. */
export const MOCK_SEARCH_TOOL_MODEL = 'mock:search-tool'
/** The answer of `mock:search` after its native search. */
export const MOCK_SEARCH_DONE = 'Search done: 2 sources'
/** The answer of `mock:search` without a native search offered. */
export const MOCK_SEARCH_OFF = 'Search off'
/** The two sources of `mock:search` (their domains are the chips of the sources row). */
export const MOCK_SEARCH_SOURCES = [
  { url: 'https://example.com/mock-search-1', title: 'Mock result one', domain: 'example.com' },
  { url: 'https://example.org/mock-search-2', title: 'Mock result two', domain: 'example.org' },
] as const

/** The titles of the fake remote's first `count` results. */
export function fakeResultTitles(count: number): string[] {
  return RESULTS.slice(0, count).map(result => result.title)
}

/** What `mock:search-tool` answers after a `search_web` call with `count` results. */
export function mockSearchToolText(count: number): string {
  return count === 0 ? 'Results: none' : `Results: ${fakeResultTitles(count).join(' | ')}`
}

// ---------- the fake remote ----------

/**
 * The fake remote next to the e2e server: `http://127.0.0.1:<E2E_FAKE_REMOTE_PORT>` (default 8889, like
 * `playwright.config.ts` and `pnpm start:e2e`). A server started for `E2E_BASE_URL` needs `HF_TEST_REMOTE_URL` at this URL.
 */
export function fakeRemoteUrl(): string {
  return `http://127.0.0.1:${process.env.E2E_FAKE_REMOTE_PORT || '8889'}`
}

/** The request log of the fake remote (method, host, path, status, a POST's JSON body; never a key header). */
export async function fakeRemoteLog(): Promise<FakeRemoteLogEntry[]> {
  const response = await fetch(`${fakeRemoteUrl()}/__log`)
  if (!response.ok)
    throw new Error(`The fake remote at ${fakeRemoteUrl()} answered ${response.status}.`)
  return await response.json() as FakeRemoteLogEntry[]
}

// ---------- the search configuration ----------

/** The builtin plugin of the search APIs and `search_web`. */
export const CORE_SEARCH_PLUGIN_ID = 'core-search'
/** The secret setting of each backend's key in `core-search`. */
export const SEARCH_KEY_SETTINGS: Readonly<Record<WebSearchBackend, string>> = {
  brave: 'braveApiKey',
  tavily: 'tavilyApiKey',
  exa: 'exaApiKey',
}
/** The names of the search APIs (Settings -> Web search, the toggle's tooltip, the search rows). */
export const SEARCH_BACKEND_LABELS: Readonly<Record<WebSearchBackend, string>> = {
  brave: 'Brave Search',
  tavily: 'Tavily',
  exa: 'Exa',
}

export interface WebSearchConfigPatch {
  /** The setting `webSearchNative`. */
  native?: boolean
  /** The setting `webSearchDefault`. */
  defaultMode?: WebSearchMode
  /** `core-search`: the selected search API. */
  backend?: WebSearchBackend
  /** `core-search`: results per search. */
  maxResults?: number
  /** `core-search`: keys to store (`''` removes one). */
  keys?: Partial<Record<WebSearchBackend, string>>
}

/** Stores (`key`) or removes (`''`) a backend's key of `core-search`. */
export async function setSearchKey(api: HarnessApi, backend: WebSearchBackend, key: string): Promise<void> {
  await api.client.plugins.updateSettings({ params: { id: CORE_SEARCH_PLUGIN_ID }, body: { values: { [SEARCH_KEY_SETTINGS[backend]]: key } } })
}

/**
 * Changes the search configuration for one test. Registers the restore first (the two settings, the backend and the
 * result count as they were; every key removed, so a test that stores one through the UI is cleaned up too), then applies
 * `patch`.
 */
export async function useWebSearchConfig(api: HarnessApi, cleanup: (task: CleanupTask) => void, patch: WebSearchConfigPatch = {}): Promise<void> {
  const settings = await api.getSettings()
  const plugin = await api.client.plugins.getSettings({ params: { id: CORE_SEARCH_PLUGIN_ID } })
  const before = {
    native: settings.webSearchNative,
    defaultMode: settings.webSearchDefault,
    backend: plugin.values.backend,
    maxResults: plugin.values.maxResults,
  }
  cleanup(async (api) => {
    await api.updateSettings({ webSearchNative: before.native, webSearchDefault: before.defaultMode })
    const keys = Object.fromEntries(Object.values(SEARCH_KEY_SETTINGS).map(name => [name, '']))
    await api.client.plugins.updateSettings({ params: { id: CORE_SEARCH_PLUGIN_ID }, body: { values: { backend: before.backend, maxResults: before.maxResults, ...keys } } })
  })
  if (patch.native !== undefined || patch.defaultMode !== undefined)
    await api.updateSettings({ ...(patch.native === undefined ? {} : { webSearchNative: patch.native }), ...(patch.defaultMode === undefined ? {} : { webSearchDefault: patch.defaultMode }) })
  const values: Record<string, unknown> = {}
  if (patch.backend !== undefined)
    values.backend = patch.backend
  if (patch.maxResults !== undefined)
    values.maxResults = patch.maxResults
  for (const [backend, key] of Object.entries(patch.keys ?? {}))
    values[SEARCH_KEY_SETTINGS[backend as WebSearchBackend]] = key
  if (Object.keys(values).length > 0)
    await api.client.plugins.updateSettings({ params: { id: CORE_SEARCH_PLUGIN_ID }, body: { values } })
}

// ---------- locators ----------

/** The composer's web search toggle (`composer-web-search`, `data-state`, `data-mode`). */
export function webSearchToggle(page: Page): Locator {
  return composer(page).getByTestId(testIds.composerWebSearch)
}

/** The unavailable popover of the toggle (`web-search-unavailable`, `data-reason`). */
export function webSearchUnavailable(page: Page): Locator {
  return page.getByTestId(testIds.webSearchUnavailable)
}
