// The search fake of the Phase 14 unit tests (ADR-063; C53-T4, FROZEN after Gate P14-0b; phase doc "Mock and fixture
// contract"): `createFakeSearchFetch()` is a `SafeFetch` that answers the three backends of `core-search` from memory, in
// each vendor's response shape, so `search_web`, the "Test search" route and their error mapping are tested without any
// network. Nothing here touches the network; every other URL is refused like the SSRF guard refuses a private host.
//
// What it serves (the shapes W14.5 verifies against the vendor docs and updates here through a CCR if they differ):
// - Brave Search: `GET https://api.search.brave.com/res/v1/web/search?q=…&count=…` (key: header
//   `X-Subscription-Token`) → `{ type: 'search', query: { original }, web: { type: 'search', results: [{ title, url,
//   description, page_age, age }] } }`;
// - Tavily: `POST https://api.tavily.com/search` with a JSON body `{ query, max_results, … }` (key: header
//   `Authorization: Bearer <key>`, or a body `api_key`) → `{ query, answer: null, images: [], follow_up_questions: null,
//   results: [{ title, url, content, score, raw_content: null, published_date }], response_time }`;
// - Exa: `POST https://api.exa.ai/search` with a JSON body `{ query, numResults, … }` (key: header `x-api-key`, or
//   `Authorization: Bearer <key>`) → `{ requestId, resolvedSearchType, results: [{ id, title, url, publishedDate,
//   author, highlights, highlightScores }] }`.
// Another method on these URLs answers 405. The results are `FAKE_SEARCH_RESULTS` (or the `results` option), cut to the
// requested count (Brave `count`, Tavily `max_results`, Exa `numResults`; 1 … 20; without one the vendor default:
// Brave 20, Tavily 5, Exa 10): `Result one` `https://example.com/a`, `Result two` `https://example.org/b`, … (the same
// list as the e2e fake remote, `e2e/fixtures/fake-remote.mjs`).
//
// Keys: a missing key or the key `invalid-key` answers 401, the key `rate-limited` 429 (the conventions of the e2e fake
// remote); with the `keys` option a backend accepts only its expected key (any other answers 401).
// Modes per backend (`modes` option or `setMode`; default `ok`): `ok`; `401`, `403`, `429`, `500` (the vendor's error
// body with that status; 429 with `retry-after: 1`); `timeout` (no answer until `timeoutMs` (default 10 000) has passed,
// then `provider_unreachable` "The request to <host> timed out after <ms> ms." like `safeFetch`; the signal aborts it
// earlier; fake timers advance it); `oversize` (a body of `maxBytes + 1` bytes: `payload_too_large`); `bad-json` (200
// with a body that is not JSON); `redirect` (302 to `https://redirect.invalid/elsewhere`: a GET follows it like
// `safeFetch` (beyond `maxRedirects`, `provider_error` "Too many redirects"; within it the target is refused), a POST
// returns the 302 as its result, since `safeFetch` never follows a POST).
// The `safeFetch` rules it mirrors: an absolute URL with an allowed protocol (`protocols`, default http and https) and no
// credentials (`validation_error`); `method` GET, HEAD or POST; a `body` only with POST and at most 64 KiB
// (`validation_error`); a response over `maxBytes` → `payload_too_large`; an aborted signal → the abort reason.
//
// The request log (`requests`) has one entry per call, refused ones included: `{ method, url, headers, body, status }`
// with lowercase header names, the values of the key headers (`x-subscription-token`, `x-api-key`, `authorization`)
// replaced by `<redacted>`, the parsed JSON body of a POST (a body `api_key` redacted too; a body that is not JSON as
// text; null without one) and the answered status (null when the call threw).
import type { WebSearchBackend } from '@harness-forge/shared'
import type { SafeFetchOptions, SafeFetchResult } from '../security/types.ts'
import { Buffer } from 'node:buffer'
import { HarnessError } from '@harness-forge/shared'

export const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'
export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
export const EXA_SEARCH_URL = 'https://api.exa.ai/search'

/** The key that answers 401 (also with mode `ok`). */
export const FAKE_SEARCH_INVALID_KEY = 'invalid-key'
/** The key that answers 429 (also with mode `ok`). */
export const FAKE_SEARCH_RATE_LIMITED_KEY = 'rate-limited'
/** The text of a redacted key value in the request log. */
export const FAKE_SEARCH_REDACTED = '<redacted>'
/** Where the `redirect` mode points. */
export const FAKE_SEARCH_REDIRECT_URL = 'https://redirect.invalid/elsewhere'
/** The largest POST body (`safeFetch` POST). */
export const FAKE_SEARCH_BODY_MAX_BYTES = 64 * 1024
/** The most results one request gets. */
export const FAKE_SEARCH_RESULTS_MAX = 20

export const FAKE_SEARCH_MODES = ['ok', '401', '403', '429', '500', 'timeout', 'oversize', 'bad-json', 'redirect'] as const
export type FakeSearchMode = (typeof FAKE_SEARCH_MODES)[number]

/** One canned result (normalized; each backend maps it to its own shape). */
export interface FakeSearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
  /** An ISO date (`YYYY-MM-DD`), or null. */
  readonly published: string | null
}

const COUNT_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'] as const

/**
 * The deterministic results (20): `Result one` `https://example.com/a`, `Result two` `https://example.org/b`, … (the
 * domains alternate, the path letters run a … t), snippet `Snippet <n> of the fake search.`, published `2026-10-20`
 * counting down by one day.
 */
export const FAKE_SEARCH_RESULTS: readonly FakeSearchResult[] = COUNT_WORDS.map((word, index) => ({
  title: `Result ${word}`,
  url: `https://example.${index % 2 === 0 ? 'com' : 'org'}/${String.fromCharCode(97 + index)}`,
  snippet: `Snippet ${word} of the fake search.`,
  published: `2026-10-${String(20 - index).padStart(2, '0')}`,
}))

/** The vendor default count of each backend (no count in the request). */
export const FAKE_SEARCH_DEFAULT_COUNTS: Readonly<Record<WebSearchBackend, number>> = { brave: 20, tavily: 5, exa: 10 }

/** One logged call. */
export interface FakeSearchRequest {
  readonly method: string
  readonly url: string
  /** Lowercase names; key values replaced by `<redacted>`. */
  readonly headers: Readonly<Record<string, string>>
  /** The parsed JSON body (`api_key` redacted), the raw text when it is not JSON, or null. */
  readonly body: unknown
  /** The answered status, or null when the call threw. */
  readonly status: number | null
}

export interface FakeSearchFetchOptions {
  /** The mode of each backend (default `ok`). */
  readonly modes?: Partial<Record<WebSearchBackend, FakeSearchMode>>
  /** The only key each listed backend accepts (any other answers 401). */
  readonly keys?: Partial<Record<WebSearchBackend, string>>
  /** The canned results (default `FAKE_SEARCH_RESULTS`), cut to the requested count. */
  readonly results?: readonly FakeSearchResult[]
}

/** The options `safeFetch` takes since Phase 14 (C50: POST with a body); written so it also fits the older type. */
export type FakeSearchFetchCallOptions = Omit<SafeFetchOptions, 'method'> & {
  readonly method?: 'GET' | 'HEAD' | 'POST'
  readonly body?: string | Uint8Array
}

export interface FakeSearchFetch {
  /** Inject as the `safeFetch` of `core-search` (assignable to `SafeFetch`). */
  readonly safeFetch: (url: string, options: FakeSearchFetchCallOptions) => Promise<SafeFetchResult>
  /** Every call, refused ones included, in order. */
  readonly requests: FakeSearchRequest[]
  setMode: (backend: WebSearchBackend, mode: FakeSearchMode) => void
  /** Clears the log and every mode set by `setMode` (back to the options). */
  reset: () => void
}

interface FakeAnswer {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: Uint8Array
}

const KEY_HEADERS: ReadonlySet<string> = new Set(['x-subscription-token', 'x-api-key', 'authorization'])
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])
const BEARER = /^bearer\s+(\S.*)$/i

const ENDPOINTS: ReadonlyArray<{ backend: WebSearchBackend, url: string, method: 'GET' | 'POST' }> = [
  { backend: 'brave', url: BRAVE_SEARCH_URL, method: 'GET' },
  { backend: 'tavily', url: TAVILY_SEARCH_URL, method: 'POST' },
  { backend: 'exa', url: EXA_SEARCH_URL, method: 'POST' },
]

function json(status: number, value: unknown, headers: Record<string, string> = {}): FakeAnswer {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: new Uint8Array(Buffer.from(JSON.stringify(value))) }
}

function invalid(message: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message })
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error)
    return reason
  const error = new Error('The request was aborted.', { cause: reason })
  error.name = 'AbortError'
  return error
}

/** The vendor error body of a status (never echoes a key). */
function vendorError(backend: WebSearchBackend, status: number): FakeAnswer {
  const detail: Record<number, string> = {
    401: 'The API key is missing or invalid.',
    403: 'The API key may not use this endpoint.',
    429: 'Too many requests: the rate limit was exceeded.',
    500: 'Internal server error.',
  }
  const text = detail[status] ?? 'Error.'
  const headers: Record<string, string> = status === 429 ? { 'retry-after': '1' } : {}
  if (backend === 'brave') {
    const codes: Record<number, string> = { 401: 'SUBSCRIPTION_TOKEN_INVALID', 403: 'OPTION_NOT_IN_PLAN', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR' }
    return json(status, { type: 'ErrorResponse', error: { id: 'fake-error', status, code: codes[status] ?? 'ERROR', detail: text }, time: 0 }, headers)
  }
  if (backend === 'tavily')
    return json(status, { detail: { error: text } }, headers)
  return json(status, { requestId: 'fake-error', error: text }, headers)
}

/** The answer of a backend for `count` results (`query` echoed where the vendor does). */
export function fakeSearchAnswer(backend: WebSearchBackend, query: string, results: readonly FakeSearchResult[]): unknown {
  switch (backend) {
    case 'brave':
      return {
        type: 'search',
        query: { original: query },
        web: {
          type: 'search',
          results: results.map(result => ({
            title: result.title,
            url: result.url,
            description: result.snippet,
            ...(result.published === null ? {} : { page_age: `${result.published}T00:00:00`, age: result.published }),
          })),
        },
      }
    case 'tavily':
      return {
        query,
        answer: null,
        images: [],
        follow_up_questions: null,
        results: results.map((result, index) => ({
          title: result.title,
          url: result.url,
          content: result.snippet,
          score: Math.round((0.95 - index * 0.04) * 100) / 100,
          raw_content: null,
          ...(result.published === null ? {} : { published_date: result.published }),
        })),
        response_time: 0.42,
      }
    case 'exa':
      return {
        requestId: 'fake-request',
        resolvedSearchType: 'neural',
        results: results.map(result => ({
          id: result.url,
          title: result.title,
          url: result.url,
          publishedDate: result.published === null ? null : `${result.published}T00:00:00.000Z`,
          author: null,
          highlights: [result.snippet],
          highlightScores: [0.5],
        })),
      }
  }
}

/** The requested count (1 … 20), or the vendor default. */
function requestedCount(backend: WebSearchBackend, url: URL, body: unknown): number {
  const raw = backend === 'brave' ? url.searchParams.get('count') : (body as Record<string, unknown> | null)?.[backend === 'tavily' ? 'max_results' : 'numResults']
  const count = Number(raw)
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(count))
    return FAKE_SEARCH_DEFAULT_COUNTS[backend]
  return Math.min(FAKE_SEARCH_RESULTS_MAX, Math.max(1, Math.trunc(count)))
}

function requestQuery(backend: WebSearchBackend, url: URL, body: unknown): string {
  const value = backend === 'brave' ? url.searchParams.get('q') : (body as Record<string, unknown> | null)?.query
  return typeof value === 'string' ? value : ''
}

/** The key a request carries (null without one). */
function requestKey(backend: WebSearchBackend, headers: Record<string, string>, body: unknown): string | null {
  const bearerKey = (headers.authorization ?? '').match(BEARER)?.[1]?.trim() ?? null
  if (backend === 'brave')
    return headers['x-subscription-token'] ?? null
  if (backend === 'tavily') {
    const bodyKey = (body as Record<string, unknown> | null)?.api_key
    return bearerKey ?? (typeof bodyKey === 'string' ? bodyKey : null)
  }
  return headers['x-api-key'] ?? bearerKey
}

function parseBody(body: string | Uint8Array | undefined): unknown {
  if (body === undefined)
    return null
  const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8')
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return text
  }
}

function redactedBody(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'api_key'))
    return body
  return { ...(body as Record<string, unknown>), api_key: FAKE_SEARCH_REDACTED }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason))
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal?.reason))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** A `SafeFetch` over the three search backends (see the module comment). */
export function createFakeSearchFetch(options: FakeSearchFetchOptions = {}): FakeSearchFetch {
  const requests: FakeSearchRequest[] = []
  const modes = new Map<WebSearchBackend, FakeSearchMode>()
  const modeOf = (backend: WebSearchBackend): FakeSearchMode => modes.get(backend) ?? options.modes?.[backend] ?? 'ok'

  function answer(backend: WebSearchBackend, method: string, url: URL, headers: Record<string, string>, body: unknown): FakeAnswer | 'timeout' {
    const endpoint = ENDPOINTS.find(entry => entry.backend === backend)!
    if (method !== endpoint.method && !(method === 'HEAD' && endpoint.method === 'GET'))
      return json(405, { error: 'Method not allowed.' }, { allow: endpoint.method })
    const mode = modeOf(backend)
    switch (mode) {
      case '401':
      case '403':
      case '429':
      case '500':
        return vendorError(backend, Number(mode))
      case 'timeout':
        return 'timeout'
      case 'bad-json':
        return { status: 200, headers: { 'content-type': 'application/json' }, body: new Uint8Array(Buffer.from('{"results": [')) }
      case 'redirect':
        return { status: 302, headers: { location: FAKE_SEARCH_REDIRECT_URL }, body: new Uint8Array(0) }
      default:
        break
    }
    const key = requestKey(backend, headers, body)
    const expected = options.keys?.[backend]
    if (key === null || key === '' || key === FAKE_SEARCH_INVALID_KEY)
      return vendorError(backend, 401)
    if (key === FAKE_SEARCH_RATE_LIMITED_KEY)
      return vendorError(backend, 429)
    if (expected !== undefined && key !== expected)
      return vendorError(backend, 401)
    const results = (options.results ?? FAKE_SEARCH_RESULTS).slice(0, requestedCount(backend, url, body))
    return json(200, fakeSearchAnswer(backend, requestQuery(backend, url, body), results))
  }

  async function fetchOnce(input: string, callOptions: FakeSearchFetchCallOptions, log: { status: number | null }): Promise<SafeFetchResult> {
    const method = callOptions.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST')
      throw invalid('Only GET, HEAD and POST requests are supported.')
    if (callOptions.body !== undefined && method !== 'POST')
      throw invalid('A request body is allowed only with POST.')
    const bodyBytes = callOptions.body === undefined ? 0 : typeof callOptions.body === 'string' ? Buffer.byteLength(callOptions.body) : callOptions.body.length
    if (bodyBytes > FAKE_SEARCH_BODY_MAX_BYTES)
      throw invalid(`The request body is larger than ${FAKE_SEARCH_BODY_MAX_BYTES} bytes.`)
    const protocols = callOptions.protocols ?? ['http:', 'https:']
    const maxRedirects = callOptions.maxRedirects ?? 5
    const timeoutMs = callOptions.timeoutMs ?? 10_000
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(callOptions.headers ?? {}))
      headers[name.toLowerCase()] = value
    const body = parseBody(callOptions.body)
    if (typeof input !== 'string' || !URL.canParse(input))
      throw invalid('Invalid URL: expected an absolute http:// or https:// URL.')
    let url = new URL(input)
    for (let redirects = 0; ; redirects++) {
      if (callOptions.signal?.aborted)
        throw abortError(callOptions.signal.reason)
      if (!(protocols as readonly string[]).includes(url.protocol))
        throw invalid(`Invalid URL: only ${protocols.map(protocol => protocol.slice(0, -1)).join(' and ')} URLs are allowed.`)
      if (url.username !== '' || url.password !== '')
        throw invalid('Invalid URL: URLs with credentials are not allowed.')
      url.hash = ''
      const endpoint = ENDPOINTS.find(entry => `${url.origin}${url.pathname}` === entry.url)
      if (endpoint === undefined)
        throw invalid(`The host "${url.host}" is not served by the fake search: only the Brave, Tavily and Exa search endpoints can be fetched.`)
      const response = answer(endpoint.backend, method, url, headers, body)
      if (response === 'timeout') {
        await delay(timeoutMs, callOptions.signal)
        throw new HarnessError({ code: 'provider_unreachable', message: `The request to ${url.host} timed out after ${timeoutMs} ms.`, action: 'retry' })
      }
      log.status = response.status
      const location = response.headers.location
      if (method !== 'POST' && REDIRECT_STATUSES.has(response.status) && location !== undefined) {
        if (redirects >= maxRedirects)
          throw new HarnessError({ code: 'provider_error', message: `Too many redirects: ${url.host} redirected more than ${maxRedirects} times.` })
        url = new URL(location, url)
        continue
      }
      if (modeOf(endpoint.backend) === 'oversize' || (method !== 'HEAD' && response.body.length > callOptions.maxBytes))
        throw new HarnessError({ code: 'payload_too_large', message: `The response is larger than the limit of ${callOptions.maxBytes} bytes.`, details: { limitBytes: callOptions.maxBytes } })
      return { url: url.href, status: response.status, headers: new Headers(response.headers), body: method === 'HEAD' ? new Uint8Array(0) : response.body.slice() }
    }
  }

  const safeFetch = async (input: string, callOptions: FakeSearchFetchCallOptions): Promise<SafeFetchResult> => {
    const logged: Record<string, string> = {}
    for (const [name, value] of Object.entries(callOptions.headers ?? {}))
      logged[name.toLowerCase()] = KEY_HEADERS.has(name.toLowerCase()) ? FAKE_SEARCH_REDACTED : value
    const log = { status: null as number | null }
    try {
      const result = await fetchOnce(input, callOptions, log)
      log.status = result.status
      return result
    }
    catch (error) {
      log.status = null
      throw error
    }
    finally {
      requests.push({ method: callOptions.method ?? 'GET', url: input, headers: logged, body: redactedBody(parseBody(callOptions.body)), status: log.status })
    }
  }

  return {
    safeFetch,
    requests,
    setMode: (backend, mode) => {
      modes.set(backend, mode)
    },
    reset: () => {
      requests.length = 0
      modes.clear()
    },
  }
}
