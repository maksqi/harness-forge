// The Brave Search backend of `core-search` (Phase 14, ADR-063, W14.5-T1). Verified against the vendor's API reference
// (api-dashboard.search.brave.com, "Web search" `GET /v1/web/search`, read 2026-10-22):
// - `GET https://api.search.brave.com/res/v1/web/search?q=…&count=…[&freshness=pd|pw|pm|py]&text_decorations=false`;
//   `count` 1 … 20 (default 20), `freshness` pd (24 hours), pw (7 days), pm (31 days), py (365 days),
//   `text_decorations` (default true) adds highlight markers to snippets, so it is turned off;
// - the key in the header `X-Subscription-Token`; `Accept: application/json`;
// - the answer `{ type: 'search', query: { original, … }, web?: { type: 'search', results: [{ title, url, description?,
//   page_age?, age?, … }] } }`: `web` is absent when the query has no web results; `page_age` is the page's date (an
//   ISO date-time without an offset), `age` a human-readable form ("2 days ago", "August 16, 2024").
// Titles and descriptions may still hold HTML entities and `<strong>` markers: both are removed (plain text).
import type { SearchWebFreshness } from '@harness-forge/shared'
import type { BackendHttpRequest, BackendSearchRequest, RawSearchResult, SearchBackend } from './common.ts'
import { arrayField, fieldOf } from './common.ts'

export const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

/** Brave's `freshness` value of each freshness filter. */
export const BRAVE_FRESHNESS: Readonly<Record<SearchWebFreshness, string>> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' }

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }

/** Removes the highlight markers Brave may add and decodes the basic HTML entities of its text fields. */
export function braveText(value: unknown): unknown {
  if (typeof value !== 'string')
    return value
  return value
    .replace(/<\/?(?:strong|b|em|i|mark)\s*>/gi, '')
    .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,6});/gi, (entity, name: string) => {
      if (name.startsWith('#')) {
        const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
        return Number.isInteger(code) && code > 0 && code <= 0x10FFFF && (code < 0xD800 || code > 0xDFFF) ? String.fromCodePoint(code) : entity
      }
      return NAMED_ENTITIES[name.toLowerCase()] ?? entity
    })
}

function buildRequest(request: BackendSearchRequest): BackendHttpRequest {
  const url = new URL(BRAVE_SEARCH_ENDPOINT)
  url.searchParams.set('q', request.query)
  url.searchParams.set('count', String(request.count))
  if (request.freshness !== undefined)
    url.searchParams.set('freshness', BRAVE_FRESHNESS[request.freshness])
  url.searchParams.set('text_decorations', 'false')
  return {
    url: url.href,
    method: 'GET',
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': request.key },
  }
}

function readResults(body: unknown): RawSearchResult[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return null
  const web = (body as Record<string, unknown>).web
  // No `web` section: the query has no web results.
  if (web === undefined || web === null)
    return []
  const results = arrayField(web, 'results')
  if (results === null)
    return null
  return results.map((entry) => {
    const pageAge = fieldOf(entry, 'page_age')
    return {
      title: braveText(fieldOf(entry, 'title')),
      url: fieldOf(entry, 'url'),
      snippet: braveText(fieldOf(entry, 'description')),
      published: typeof pageAge === 'string' && pageAge.trim() !== '' ? pageAge : fieldOf(entry, 'age'),
    }
  })
}

/** Brave Search (`backend: 'brave'`). */
export const braveBackend: SearchBackend = {
  id: 'brave',
  label: 'Brave Search',
  endpoint: BRAVE_SEARCH_ENDPOINT,
  buildRequest,
  readResults,
}
