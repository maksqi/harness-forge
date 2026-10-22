// The Exa backend (W14.5-T1): the request shape (POST JSON `{ query, numResults, type: 'auto', contents: { highlights:
// true }, startPublishedDate? }`, the key only in `x-api-key`) and the answer's `results` (highlights as the snippet).
import { describe, expect, it } from 'vitest'
import { createFakeSearchFetch, EXA_SEARCH_URL, FAKE_SEARCH_REDACTED, FAKE_SEARCH_RESULTS } from '../../../testing/fake-search.ts'
import { searchBackend } from './common.ts'
import { EXA_FRESHNESS_DAYS, EXA_SEARCH_ENDPOINT, exaBackend, exaStartPublishedDate } from './exa.ts'

const KEY = 'exa-canary-key-5c70'
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)

describe('exa backend', () => {
  it('sends POST with a JSON body; the key only in x-api-key', async () => {
    expect(EXA_SEARCH_ENDPOINT).toBe(EXA_SEARCH_URL)
    const fake = createFakeSearchFetch({ keys: { exa: KEY } })
    const { results, status } = await searchBackend(exaBackend, { query: 'harness forge', count: 2, freshness: 'day', key: KEY }, { safeFetch: fake.safeFetch, now: () => NOW })
    expect(status).toBe(200)
    expect(results).toEqual(FAKE_SEARCH_RESULTS.slice(0, 2).map(result => ({ ...result, published: `${result.published}T00:00:00.000Z` })))
    const [logged] = fake.requests
    expect(logged).toMatchObject({ method: 'POST', url: EXA_SEARCH_URL, status: 200 })
    expect(logged!.body).toEqual({ query: 'harness forge', numResults: 2, type: 'auto', contents: { highlights: true }, startPublishedDate: '2026-10-21T12:00:00.000Z' })
    expect(logged!.headers).toEqual({ 'accept': 'application/json', 'content-type': 'application/json', 'x-api-key': FAKE_SEARCH_REDACTED })
    expect(JSON.stringify(logged)).not.toContain(KEY)
  })

  it('maps freshness to startPublishedDate (1, 7, 31, 365 days back) and sends none without one', () => {
    expect(EXA_FRESHNESS_DAYS).toEqual({ day: 1, week: 7, month: 31, year: 365 })
    expect(exaStartPublishedDate('week', NOW)).toBe('2026-10-15T12:00:00.000Z')
    expect(exaStartPublishedDate('year', NOW)).toBe('2025-10-22T12:00:00.000Z')
    const http = exaBackend.buildRequest({ query: 'q', count: 1, key: KEY }, NOW)
    expect(JSON.parse(http.body!)).toEqual({ query: 'q', numResults: 1, type: 'auto', contents: { highlights: true } })
    expect(http.body).not.toContain(KEY)
  })

  it('reads results: highlights joined (else summary, else text) as the snippet, publishedDate', () => {
    expect(exaBackend.readResults({ requestId: 'r', results: [
      { id: 'a', title: 'A', url: 'https://example.com/a', publishedDate: '2026-10-01', highlights: ['one', ' ', 'two'] },
      { id: 'b', title: 'B', url: 'https://example.com/b', highlights: [], summary: 'a summary', text: 'the text' },
      { id: 'c', title: 'C', url: 'https://example.com/c', text: 'only text' },
    ] })).toEqual([
      { title: 'A', url: 'https://example.com/a', snippet: 'one … two', published: '2026-10-01' },
      { title: 'B', url: 'https://example.com/b', snippet: 'a summary', published: undefined },
      { title: 'C', url: 'https://example.com/c', snippet: 'only text', published: undefined },
    ])
    expect(exaBackend.readResults({ requestId: 'r' })).toBeNull()
  })
})
