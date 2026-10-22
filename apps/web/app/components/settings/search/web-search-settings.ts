// Settings → Web search rules (docs/UI.md 9.15, 15; ADR-063): the order of the key rows, the vendors' key pages, the
// "Max results" field and the text of the "Test search" result line. Pure (no stores), so the page and its tests share
// them. The backend names come from `WEB_SEARCH_BACKEND_LABELS` (the composer's tooltip uses the same names).
import type { WebSearchBackend, WebSearchTestResult } from '@harness-forge/shared'
import { WEB_SEARCH_BACKENDS } from '@harness-forge/shared'
import { WEB_SEARCH_BACKEND_LABELS } from '~/components/chat/composer/web-search'
import { toHarnessError } from '~/utils/errors'

/** Where each vendor hands out API keys (docs/PROVIDERS.md 8, the guide); script constants (vue-tsc #6240). */
export const WEB_SEARCH_KEY_URLS: Readonly<Record<WebSearchBackend, string>> = {
  brave: 'https://brave.com/search/api/',
  tavily: 'https://tavily.com',
  exa: 'https://exa.ai',
}

/** The page of the builtin plugin `core-search` ("Open plugin" while it is turned off). */
export const CORE_SEARCH_PLUGIN_PATH = '/plugins/core-search'

/** A configuration younger than this is reused when the page opens (UI.md 9.15). */
export const WEB_SEARCH_CONFIG_MAX_AGE_MS = 15_000

/** The bounds of the `maxResults` setting of `core-search`. */
export const MAX_RESULTS_MIN = 1
export const MAX_RESULTS_MAX = 10
export const MAX_RESULTS_ERROR = `Enter a whole number from ${MAX_RESULTS_MIN} to ${MAX_RESULTS_MAX}.`

/** The key rows: the selected backend first, then the others in their usual order (Brave Search, Tavily, Exa). */
export function keyRowOrder(selected: WebSearchBackend): WebSearchBackend[] {
  return [selected, ...WEB_SEARCH_BACKENDS.filter(backend => backend !== selected)]
}

/** A typed "Max results": a whole number from 1 to 10, else the error text. */
export function parseMaxResults(text: string): { value: number } | { error: string } {
  const trimmed = text.trim()
  if (!/^\d{1,2}$/.test(trimmed))
    return { error: MAX_RESULTS_ERROR }
  const value = Number(trimmed)
  return value >= MAX_RESULTS_MIN && value <= MAX_RESULTS_MAX ? { value } : { error: MAX_RESULTS_ERROR }
}

/** "5 results from Brave Search in 412 ms" ("1 result …"). */
export function testResultText(result: WebSearchTestResult): string {
  const count = result.results === 1 ? '1 result' : `${result.results.toLocaleString('en-US')} results`
  return `${count} from ${WEB_SEARCH_BACKEND_LABELS[result.backend]} in ${result.ms.toLocaleString('en-US')} ms`
}

/** The server's message for a rejected search key (API.md 5.40; the key is never echoed). */
const KEY_REJECTED_MESSAGE = 'The search key was rejected.'

/**
 * A failed test as one line: a rejected key (`provider_error` with the vendor's 401 / 403 as `status`, or the server's
 * "key rejected" message), the vendor's rate limit, an unreachable vendor, else the server's message (another
 * `provider_error`: a 5xx, an unreadable answer, …).
 */
export function testErrorText(error: unknown, backend: WebSearchBackend): string {
  const harnessError = toHarnessError(error)
  const label = WEB_SEARCH_BACKEND_LABELS[backend]
  switch (harnessError.code) {
    case 'provider_error':
      if (harnessError.status === 401 || harnessError.status === 403 || harnessError.message === KEY_REJECTED_MESSAGE)
        return `${label} rejected the key.`
      return harnessError.message
    case 'rate_limited':
      return `${label} is limiting requests. Try again later.`
    case 'provider_unreachable':
      return `Couldn't reach ${label}.`
    default:
      return harnessError.message
  }
}
