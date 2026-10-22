// The Tavily backend (W14.5-T1): the request shape (POST JSON `{ query, max_results, search_depth: 'basic',
// include_published_date: true, time_range? }`, the key only in `Authorization: Bearer`) and the answer's `results`.
import { describe, expect, it } from 'vitest'
import { createFakeSearchFetch, FAKE_SEARCH_REDACTED, FAKE_SEARCH_RESULTS, TAVILY_SEARCH_URL } from '../../../testing/fake-search.ts'
import { searchBackend } from './common.ts'
import { TAVILY_SEARCH_ENDPOINT, tavilyBackend } from './tavily.ts'

const KEY = 'tvly-canary-key-93be'

describe('tavily backend', () => {
  it('sends POST with a JSON body; the key only in the Authorization header', async () => {
    expect(TAVILY_SEARCH_ENDPOINT).toBe(TAVILY_SEARCH_URL)
    const fake = createFakeSearchFetch({ keys: { tavily: KEY } })
    const { results, status } = await searchBackend(tavilyBackend, { query: 'harness forge', count: 3, freshness: 'month', key: KEY }, { safeFetch: fake.safeFetch })
    expect(status).toBe(200)
    expect(results).toEqual(FAKE_SEARCH_RESULTS.slice(0, 3))
    const [logged] = fake.requests
    expect(logged).toMatchObject({ method: 'POST', url: TAVILY_SEARCH_URL, status: 200 })
    expect(logged!.body).toEqual({ query: 'harness forge', max_results: 3, search_depth: 'basic', include_published_date: true, time_range: 'month' })
    expect(logged!.headers).toEqual({ 'accept': 'application/json', 'content-type': 'application/json', 'authorization': FAKE_SEARCH_REDACTED })
    expect(JSON.stringify(logged)).not.toContain(KEY)
  })

  it('sends no time_range without a freshness filter and never the key in the body', () => {
    const http = tavilyBackend.buildRequest({ query: 'q', count: 1, key: KEY }, 0)
    expect(JSON.parse(http.body!)).toEqual({ query: 'q', max_results: 1, search_depth: 'basic', include_published_date: true })
    expect(http.body).not.toContain(KEY)
    expect(http.headers.Authorization).toBe(`Bearer ${KEY}`)
    for (const freshness of ['day', 'week', 'month', 'year'] as const)
      expect(JSON.parse(tavilyBackend.buildRequest({ query: 'q', count: 1, freshness, key: KEY }, 0).body!).time_range).toBe(freshness)
  })

  it('reads results: content as the snippet, published_date (null when unknown)', () => {
    expect(tavilyBackend.readResults({ query: 'q', results: [
      { title: 'A', url: 'https://example.com/a', content: 'one [...] two', score: 0.9, published_date: null },
      { title: 'B', url: 'https://example.com/b', content: 'three', score: 0.8, published_date: '2026-10-02' },
    ] })).toEqual([
      { title: 'A', url: 'https://example.com/a', snippet: 'one [...] two', published: null },
      { title: 'B', url: 'https://example.com/b', snippet: 'three', published: '2026-10-02' },
    ])
    expect(tavilyBackend.readResults({ query: 'q' })).toBeNull()
    expect(tavilyBackend.readResults('nope')).toBeNull()
  })
})
