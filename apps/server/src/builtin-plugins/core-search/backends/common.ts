// The common part of the three `core-search` backends (Phase 14, ADR-063, W14.5-T1): one request through the injected
// `SafeFetch` (in production the plugin-source fetch of `security/ssrf.ts`: https only, the SSRF guard, the test-only
// reroute to the loopback fake remote) with the search limits (`LIMITS.searchWebTimeoutMs` 10 s,
// `LIMITS.searchWebFetchBytes` 1 MB, no redirect: a POST never follows one and a GET gets `maxRedirects: 0`), the
// error mapping and the normalization of the vendor's results to `searchWebResultSchema`.
//
// Error mapping (API.md 4.39 / 5.40): 401 / 403 -> `provider_error` "The search key was rejected."; 429 ->
// `rate_limited` (with `retryAfterMs` from `retry-after`); another non-2xx answer (a 3xx included) -> `provider_error`;
// a network failure, a timeout or a refused address -> `provider_unreachable`; a body over 1 MB, a body that is not JSON
// or not the vendor's shape -> `provider_error`. An abort of the caller's signal is re-thrown as is. Messages name the
// backend (and the host of a network failure), never the key, the query or the vendor's error text.
//
// Normalization: http(s) URLs only (at most 2048 characters, no whitespace or control characters; other results are
// dropped), duplicates by URL dropped, titles cut to 300 characters (a result without a title gets its host), snippets
// to 800, `published` to 64 (null when the vendor gives none); control and bidi formatting characters become spaces,
// whitespace runs collapse. At most the requested count is kept. The text stays untrusted: callers show it as plain
// text.
import type { SearchWebFreshness, SearchWebResult, WebSearchBackend } from '@harness-forge/shared'
import type { SafeFetch, SafeFetchResult } from '../../../security/types.ts'
import { Buffer } from 'node:buffer'
import {
  HarnessError,
  isHarnessError,
  LIMITS,
  SEARCH_WEB_RESULTS_MAX,
  SEARCH_WEB_SNIPPET_MAX_CHARS,
  SEARCH_WEB_TITLE_MAX_CHARS,
  searchWebResultSchema,
  sourceDomain,
} from '@harness-forge/shared'

/** Characters of a normalized `published` value (`searchWebResultSchema`). */
export const SEARCH_PUBLISHED_MAX_CHARS = 64

/** The message of a 401 / 403 answer (API.md 5.40; the key is never echoed). */
export const SEARCH_KEY_REJECTED_MESSAGE = 'The search key was rejected.'

/** The longest wait a `retry-after` header may ask for (1 hour). */
const RETRY_AFTER_MAX_MS = 3_600_000

/** One search of a backend. */
export interface BackendSearchRequest {
  /** The query (trimmed, 1 … 400 characters). */
  readonly query: string
  /** Results wanted, 1 … 10. */
  readonly count: number
  readonly freshness?: SearchWebFreshness
  /** The backend's key (sent only in its auth header). */
  readonly key: string
}

/** How a backend request runs. */
export interface BackendCallOptions {
  /** The outbound fetch (the plugin-source fetch in production, `createFakeSearchFetch` in tests). */
  readonly safeFetch: SafeFetch
  /** Timeout of the whole request (default `LIMITS.searchWebTimeoutMs`). */
  readonly timeoutMs?: number
  /** The caller's signal (a tool call's `c.signal`, a route's request signal). */
  readonly signal?: AbortSignal
  /** The clock (ms since the epoch) for date filters; default `Date.now`. */
  readonly now?: () => number
}

/** The HTTP request of one search (built by a backend). */
export interface BackendHttpRequest {
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  /** The JSON body of a POST. */
  readonly body?: string
}

/** One result as the vendor gives it (fields still unchecked). */
export interface RawSearchResult {
  readonly title: unknown
  readonly url: unknown
  readonly snippet: unknown
  readonly published: unknown
}

/** One search backend of `core-search`. */
export interface SearchBackend {
  readonly id: WebSearchBackend
  /** The name shown in messages (`Brave Search`, `Tavily`, `Exa`). */
  readonly label: string
  /** The endpoint (`https://…`). */
  readonly endpoint: string
  /** The request of a search (`now` = ms since the epoch, for date filters). */
  readonly buildRequest: (request: BackendSearchRequest, now: number) => BackendHttpRequest
  /** The results of a parsed 2xx body, or null when the body is not the vendor's shape. */
  readonly readResults: (body: unknown) => readonly RawSearchResult[] | null
}

/** What one backend search returned. */
export interface BackendSearchResult {
  /** The normalized results (at most the requested count). */
  readonly results: SearchWebResult[]
  /** The HTTP status of the answer. */
  readonly status: number
}

// ---------- text normalization ----------

/** C0 / C1 controls and the bidi embedding, override and isolate characters. */
function isUnsafeChar(code: number): boolean {
  return code < 0x20 || (code >= 0x7F && code < 0xA0) || (code >= 0x202A && code <= 0x202E) || (code >= 0x2066 && code <= 0x2069)
}

/** Cuts `text` to at most `max` UTF-16 units (never inside a surrogate pair), ending with `…` when cut. */
export function cutText(text: string, max: number): string {
  if (text.length <= max)
    return text
  let end = Math.max(0, max - 1)
  const code = text.charCodeAt(end - 1)
  if (end > 0 && code >= 0xD800 && code <= 0xDBFF)
    end -= 1
  return `${text.slice(0, end).trimEnd()}…`
}

/** One line of plain text: controls and bidi formatting characters become spaces, whitespace runs collapse, cut. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string')
    return ''
  let text = ''
  for (const char of value)
    text += isUnsafeChar(char.codePointAt(0) ?? 0) ? ' ' : char
  return cutText(text.replace(/\s+/g, ' ').trim(), max)
}

/** The URL of a result when it is an http(s) URL `searchWebResultSchema` accepts, else null. */
export function resultUrl(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const url = value.trim()
  return searchWebResultSchema.shape.url.safeParse(url).success ? url : null
}

/** The normalized results of a backend's raw results (see the module comment), at most `count`. */
export function normalizeResults(raw: readonly RawSearchResult[], count: number): SearchWebResult[] {
  const limit = Math.min(SEARCH_WEB_RESULTS_MAX, Math.max(1, Math.trunc(count)))
  const seen = new Set<string>()
  const results: SearchWebResult[] = []
  for (const entry of raw) {
    if (results.length >= limit)
      break
    const url = resultUrl(entry.url)
    if (url === null || seen.has(url))
      continue
    const title = cleanText(entry.title, SEARCH_WEB_TITLE_MAX_CHARS) || cleanText(sourceDomain(url) ?? url, SEARCH_WEB_TITLE_MAX_CHARS)
    const published = cleanText(entry.published, SEARCH_PUBLISHED_MAX_CHARS)
    const result = searchWebResultSchema.safeParse({
      title,
      url,
      snippet: cleanText(entry.snippet, SEARCH_WEB_SNIPPET_MAX_CHARS),
      published: published === '' ? null : published,
    })
    if (!result.success)
      continue
    seen.add(url)
    results.push(result.data)
  }
  return results
}

/** The array of a parsed body's field, or null. */
export function arrayField(body: unknown, field: string): unknown[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return null
  const value = (body as Record<string, unknown>)[field]
  return Array.isArray(value) ? value : null
}

/** A field of a raw result object (undefined for anything that is not an object). */
export function fieldOf(entry: unknown, field: string): unknown {
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>)[field] : undefined
}

// ---------- the request ----------

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  }
  catch {
    return endpoint
  }
}

/** The wait a `retry-after` header asks for (seconds or an HTTP date), or undefined. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null || header.trim() === '')
    return undefined
  const value = header.trim()
  let ms: number
  if (/^\d+$/.test(value))
    ms = Number(value) * 1000
  else if (!Number.isNaN(Date.parse(value)))
    ms = Date.parse(value) - now
  else
    return undefined
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, Math.round(ms)))
}

/** A thrown `safeFetch` failure as the search error (an abort of `signal` is returned as is). */
function fetchFailure(backend: SearchBackend, error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted === true)
    return error
  if (isHarnessError(error)) {
    switch (error.code) {
      case 'payload_too_large':
        return new HarnessError({ code: 'provider_error', message: `${backend.label} answered with more than ${Math.round(LIMITS.searchWebFetchBytes / 1_048_576)} MB.` })
      case 'provider_unreachable':
        return new HarnessError({ code: 'provider_unreachable', message: error.message, action: 'retry' })
      case 'provider_error':
        return new HarnessError({ code: 'provider_error', message: `${backend.label} could not be read: ${error.message}` })
      case 'validation_error':
        return new HarnessError({ code: 'provider_unreachable', message: `Could not reach ${hostOf(backend.endpoint)}: the address is not allowed.` })
      default:
        break
    }
  }
  return new HarnessError({ code: 'provider_unreachable', message: `Could not reach ${hostOf(backend.endpoint)}.`, action: 'retry' })
}

/** Throws the search error of a non-2xx answer. */
function checkStatus(backend: SearchBackend, response: SafeFetchResult, now: number): void {
  const status = response.status
  if (status >= 200 && status < 300)
    return
  if (status === 401 || status === 403)
    throw new HarnessError({ code: 'provider_error', message: SEARCH_KEY_REJECTED_MESSAGE, status })
  if (status === 429) {
    const wait = retryAfterMs(response.headers.get('retry-after'), now)
    throw new HarnessError({
      code: 'rate_limited',
      message: `${backend.label} is limiting the number of searches: try again later.`,
      status,
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
    })
  }
  if (status >= 300 && status < 400)
    throw new HarnessError({ code: 'provider_error', message: `${backend.label} answered with a redirect (HTTP ${status}), which is not followed.`, status })
  throw new HarnessError({ code: 'provider_error', message: `${backend.label} answered HTTP ${status}.`, status })
}

/** One search: the request, the error mapping, the vendor shape and the normalized results (see the module comment). */
export async function searchBackend(backend: SearchBackend, request: BackendSearchRequest, options: BackendCallOptions): Promise<BackendSearchResult> {
  const now = options.now ?? Date.now
  const http = backend.buildRequest(request, now())
  let response: SafeFetchResult
  try {
    response = await options.safeFetch(http.url, {
      method: http.method,
      headers: { ...http.headers },
      ...(http.body === undefined ? {} : { body: http.body }),
      maxBytes: LIMITS.searchWebFetchBytes,
      timeoutMs: options.timeoutMs ?? LIMITS.searchWebTimeoutMs,
      maxRedirects: 0,
      protocols: ['https:'],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  }
  catch (error) {
    throw fetchFailure(backend, error, options.signal)
  }
  checkStatus(backend, response, now())
  let body: unknown
  try {
    body = JSON.parse(Buffer.from(response.body).toString('utf8')) as unknown
  }
  catch {
    throw new HarnessError({ code: 'provider_error', message: `${backend.label} answered with a response that is not JSON.`, status: response.status })
  }
  const raw = backend.readResults(body)
  if (raw === null)
    throw new HarnessError({ code: 'provider_error', message: `${backend.label} answered with an unexpected response.`, status: response.status })
  return { results: normalizeResults(raw, request.count), status: response.status }
}
