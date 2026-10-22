// The common part of the `core-search` backends (W14.5-T1): the error mapping of every backend against every mode of
// `createFakeSearchFetch` (the key never in an error), the request limits handed to `safeFetch` and the normalization of
// results (URLs, caps, duplicates, control characters, the requested count).
import type { SearchWebResult, WebSearchBackend } from '@harness-forge/shared'
import type { FakeSearchMode } from '../../../testing/fake-search.ts'
import type { BackendSearchRequest, RawSearchResult } from './common.ts'
import { HarnessError, isHarnessError, LIMITS, SEARCH_WEB_SNIPPET_MAX_CHARS, SEARCH_WEB_TITLE_MAX_CHARS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createFakeSearchFetch, FAKE_SEARCH_RESULTS } from '../../../testing/fake-search.ts'
import { braveBackend } from './brave.ts'
import { cleanText, cutText, normalizeResults, retryAfterMs, SEARCH_KEY_REJECTED_MESSAGE, searchBackend } from './common.ts'
import { exaBackend } from './exa.ts'
import { tavilyBackend } from './tavily.ts'

const KEY = 'sk-search-canary-7f3a9c'
const QUERY = 'canary query 51d2'
const BACKENDS = [braveBackend, tavilyBackend, exaBackend]

function request(overrides: Partial<BackendSearchRequest> = {}): BackendSearchRequest {
  return { query: QUERY, count: 3, key: KEY, ...overrides }
}

/** The error a search throws (fails the test when it resolves). */
async function failure(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    if (isHarnessError(error))
      return error
    throw error
  }
  throw new Error('The search did not fail.')
}

function expectNoSecret(error: HarnessError): void {
  const text = JSON.stringify({ message: error.message, details: error.details ?? null, code: error.code })
  expect(text).not.toContain(KEY)
  expect(text).not.toContain(QUERY)
}

describe.each(BACKENDS.map(backend => [backend.id, backend] as const))('%s: the error mapping', (id, backend) => {
  const cases: Array<[FakeSearchMode, string, number | undefined]> = [
    ['401', 'provider_error', 401],
    ['403', 'provider_error', 403],
    ['429', 'rate_limited', 429],
    ['500', 'provider_error', 500],
    ['timeout', 'provider_unreachable', undefined],
    ['oversize', 'provider_error', undefined],
    ['bad-json', 'provider_error', 200],
    ['redirect', 'provider_error', undefined],
  ]

  it.each(cases)('mode %s -> %s', async (mode, code, status) => {
    const fake = createFakeSearchFetch({ modes: { [id]: mode } })
    const error = await failure(searchBackend(backend, request(), { safeFetch: fake.safeFetch, timeoutMs: 20 }))
    expect(error.code).toBe(code)
    if (status !== undefined)
      expect(error.status).toBe(status)
    if (mode === '401' || mode === '403')
      expect(error.message).toBe(SEARCH_KEY_REJECTED_MESSAGE)
    if (mode === '429')
      expect(error.retryAfterMs).toBe(1000)
    if (mode === 'timeout')
      expect(error.message).toContain('timed out')
    if (mode === 'oversize')
      expect(error.message).toBe(`${backend.label} answered with more than 1 MB.`)
    if (mode === 'bad-json')
      expect(error.message).toBe(`${backend.label} answered with a response that is not JSON.`)
    expectNoSecret(error)
    expect(fake.requests).toHaveLength(1)
    expect(JSON.stringify(fake.requests)).not.toContain(KEY)
  })

  it('the keys invalid-key (401) and rate-limited (429) of the fakes', async () => {
    const fake = createFakeSearchFetch()
    const rejected = await failure(searchBackend(backend, request({ key: 'invalid-key' }), { safeFetch: fake.safeFetch }))
    expect(rejected).toMatchObject({ code: 'provider_error', message: SEARCH_KEY_REJECTED_MESSAGE, status: 401 })
    const limited = await failure(searchBackend(backend, request({ key: 'rate-limited' }), { safeFetch: fake.safeFetch }))
    expect(limited).toMatchObject({ code: 'rate_limited', status: 429 })
    expect(limited.message).toBe(`${backend.label} is limiting the number of searches: try again later.`)
    // A backend that expects another key rejects this one.
    const strict = createFakeSearchFetch({ keys: { [id]: 'the-right-key' } })
    expect(await failure(searchBackend(backend, request(), { safeFetch: strict.safeFetch }))).toMatchObject({ code: 'provider_error', status: 401 })
  })

  it('hands safeFetch the search limits: 1 MB, 10 s by default, no redirect, https only, the caller\'s signal', async () => {
    const seen: unknown[] = []
    const fake = createFakeSearchFetch()
    const controller = new AbortController()
    const result = await searchBackend(backend, request(), {
      safeFetch: async (url, options) => {
        seen.push(options)
        return fake.safeFetch(url, options)
      },
      signal: controller.signal,
    })
    expect(result.status).toBe(200)
    expect(seen[0]).toMatchObject({
      maxBytes: LIMITS.searchWebFetchBytes,
      timeoutMs: LIMITS.searchWebTimeoutMs,
      maxRedirects: 0,
      protocols: ['https:'],
      signal: controller.signal,
      method: backend.id === 'brave' ? 'GET' : 'POST',
    })
    expect(LIMITS.searchWebFetchBytes).toBe(1_048_576)
    expect(LIMITS.searchWebTimeoutMs).toBe(10_000)
  })

  it('re-throws an abort of the caller as is', async () => {
    const fake = createFakeSearchFetch({ modes: { [id]: 'timeout' } })
    const controller = new AbortController()
    const reason = new Error('stopped by the user')
    const pending = searchBackend(backend, request(), { safeFetch: fake.safeFetch, signal: controller.signal, timeoutMs: 5000 })
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it('maps a refused address to provider_unreachable and an unexpected throw too', async () => {
    const refused = await failure(searchBackend(backend, request(), {
      safeFetch: async () => {
        throw new HarnessError({ code: 'validation_error', message: `The host resolves to a private address (${KEY}).` })
      },
    }))
    expect(refused.code).toBe('provider_unreachable')
    expect(refused.message).toBe(`Could not reach ${new URL(backend.endpoint).host}: the address is not allowed.`)
    expectNoSecret(refused)
    const broken = await failure(searchBackend(backend, request(), {
      safeFetch: async () => {
        throw new TypeError(`socket hang up ${KEY}`)
      },
    }))
    expect(broken).toMatchObject({ code: 'provider_unreachable', message: `Could not reach ${new URL(backend.endpoint).host}.` })
  })

  it('answers provider_error for a 2xx body that is not the vendor\'s shape', async () => {
    const error = await failure(searchBackend(backend, request(), {
      safeFetch: async url => ({ url, status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: new TextEncoder().encode(backend.id === 'brave' ? '{"web":{"results":"nope"}}' : '{"items":[]}') }),
    }))
    expect(error).toMatchObject({ code: 'provider_error', message: `${backend.label} answered with an unexpected response.` })
  })
})

describe('the normalization of results', () => {
  function raw(entries: Array<Partial<Record<keyof RawSearchResult, unknown>>>): RawSearchResult[] {
    return entries.map(entry => ({ title: entry.title, url: entry.url, snippet: entry.snippet, published: entry.published }))
  }

  it('keeps http(s) URLs only, drops duplicates and stops at the count', () => {
    const results = normalizeResults(raw([
      { title: 'A', url: 'https://example.com/a', snippet: 'one', published: '2026-10-20' },
      { title: 'Script', url: 'javascript:alert(1)' },
      { title: 'File', url: 'file:///etc/passwd' },
      { title: 'Data', url: 'data:text/html,hi' },
      { title: 'Spaces', url: 'https://example.com/a b' },
      { title: 'Not a string', url: 42 },
      { title: 'Duplicate', url: 'https://example.com/a' },
      { title: 'B', url: ' http://example.org/b ', published: null },
      { title: 'C', url: 'https://example.net/c' },
    ]), 2)
    expect(results).toEqual<SearchWebResult[]>([
      { title: 'A', url: 'https://example.com/a', snippet: 'one', published: '2026-10-20' },
      { title: 'B', url: 'http://example.org/b', snippet: '', published: null },
    ])
  })

  it('caps titles (300), snippets (800), published (64) and URLs (2048); a missing title becomes the host', () => {
    const long = 'x'.repeat(5000)
    const [result] = normalizeResults(raw([{ title: long, url: 'https://www.example.com/p', snippet: long, published: long }]), 5)
    expect(result!.title).toHaveLength(SEARCH_WEB_TITLE_MAX_CHARS)
    expect(result!.title.endsWith('…')).toBe(true)
    expect(result!.snippet).toHaveLength(SEARCH_WEB_SNIPPET_MAX_CHARS)
    expect(result!.published).toHaveLength(64)
    expect(normalizeResults(raw([{ url: `https://example.com/${'a'.repeat(2048)}` }]), 5)).toEqual([])
    expect(normalizeResults(raw([{ title: '  ', url: 'https://www.example.com/p' }]), 5)[0]!.title).toBe('example.com')
  })

  it('turns control and bidi characters into spaces and collapses whitespace', () => {
    expect(cleanText('a\u0000b\u001Bc\u202Ed\u2066e\n\t f', 100)).toBe('a b c d e f')
    expect(cleanText(42, 10)).toBe('')
    expect(cutText('abcdef', 4)).toBe('abc…')
    // Never inside a surrogate pair.
    expect(cutText('ab\u{1F600}cd', 4)).toBe('ab…')
  })

  it('reads retry-after as seconds or an HTTP date, capped at one hour', () => {
    expect(retryAfterMs('3')).toBe(3000)
    expect(retryAfterMs(null)).toBeUndefined()
    expect(retryAfterMs('soon')).toBeUndefined()
    expect(retryAfterMs('999999')).toBe(3_600_000)
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4000)).toBe(6000)
  })

  it.each(BACKENDS.map(backend => [backend.id, backend] as const))('%s: the canned results normalize to the fake\'s list', async (_id, backend) => {
    const fake = createFakeSearchFetch()
    const { results } = await searchBackend(backend, request({ count: 4 }), { safeFetch: fake.safeFetch })
    expect(results.map(result => [result.title, result.url, result.snippet])).toEqual(FAKE_SEARCH_RESULTS.slice(0, 4).map(result => [result.title, result.url, result.snippet]))
    const published = results.map(result => result.published)
    const expected: Record<WebSearchBackend, string[]> = {
      brave: FAKE_SEARCH_RESULTS.slice(0, 4).map(result => `${result.published}T00:00:00`),
      tavily: FAKE_SEARCH_RESULTS.slice(0, 4).map(result => result.published!),
      exa: FAKE_SEARCH_RESULTS.slice(0, 4).map(result => `${result.published}T00:00:00.000Z`),
    }
    expect(published).toEqual(expected[backend.id])
  })
})
