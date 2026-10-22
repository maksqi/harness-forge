// The Brave Search backend (W14.5-T1): the request shape (GET, `q`, `count`, `freshness`, `text_decorations=false`, the
// key only in `X-Subscription-Token`), the answer read from `web.results` and Brave's markers and entities removed.
import { describe, expect, it } from 'vitest'
import { BRAVE_SEARCH_URL, createFakeSearchFetch, FAKE_SEARCH_REDACTED, FAKE_SEARCH_RESULTS } from '../../../testing/fake-search.ts'
import { BRAVE_FRESHNESS, BRAVE_SEARCH_ENDPOINT, braveBackend, braveText } from './brave.ts'
import { searchBackend } from './common.ts'

const KEY = 'brave-canary-key-0d41'

describe('brave backend', () => {
  it('sends GET with q, count, freshness and text_decorations=false; the key only in X-Subscription-Token', async () => {
    expect(BRAVE_SEARCH_ENDPOINT).toBe(BRAVE_SEARCH_URL)
    const fake = createFakeSearchFetch({ keys: { brave: KEY } })
    const { results, status } = await searchBackend(braveBackend, { query: 'harness forge & co', count: 4, freshness: 'week', key: KEY }, { safeFetch: fake.safeFetch })
    expect(status).toBe(200)
    expect(results.map(result => result.title)).toEqual(['Result one', 'Result two', 'Result three', 'Result four'])
    const [logged] = fake.requests
    expect(logged).toMatchObject({ method: 'GET', body: null, status: 200 })
    const url = new URL(logged!.url)
    expect(`${url.origin}${url.pathname}`).toBe(BRAVE_SEARCH_URL)
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'harness forge & co', count: '4', freshness: 'pw', text_decorations: 'false' })
    expect(logged!.headers).toEqual({ 'accept': 'application/json', 'x-subscription-token': FAKE_SEARCH_REDACTED })
    expect(logged!.url).not.toContain(KEY)
  })

  it('maps every freshness filter (pd, pw, pm, py) and sends none without one', () => {
    expect(BRAVE_FRESHNESS).toEqual({ day: 'pd', week: 'pw', month: 'pm', year: 'py' })
    const plain = new URL(braveBackend.buildRequest({ query: 'q', count: 1, key: KEY }, 0).url)
    expect(plain.searchParams.has('freshness')).toBe(false)
    for (const [freshness, value] of Object.entries(BRAVE_FRESHNESS)) {
      const url = new URL(braveBackend.buildRequest({ query: 'q', count: 1, freshness: freshness as keyof typeof BRAVE_FRESHNESS, key: KEY }, 0).url)
      expect(url.searchParams.get('freshness')).toBe(value)
    }
  })

  it('reads web.results: description as the snippet, page_age (else age) as published; no web section = no results', () => {
    expect(braveBackend.readResults({ type: 'search', query: { original: 'q' } })).toEqual([])
    expect(braveBackend.readResults({ web: { results: [
      { title: 'A', url: 'https://example.com/a', description: 'one', page_age: '2026-10-01T10:00:00', age: '3 weeks ago' },
      { title: 'B', url: 'https://example.com/b', description: 'two', age: 'August 16, 2024' },
    ] } })).toEqual([
      { title: 'A', url: 'https://example.com/a', snippet: 'one', published: '2026-10-01T10:00:00' },
      { title: 'B', url: 'https://example.com/b', snippet: 'two', published: 'August 16, 2024' },
    ])
    expect(braveBackend.readResults([])).toBeNull()
    expect(braveBackend.readResults({ web: { results: null } })).toBeNull()
  })

  it('removes highlight markers and decodes basic entities (plain text)', () => {
    expect(braveText('The <strong>harness</strong> &amp; its &quot;forge&quot; &#x27;tools&#39; &lt;b&gt;')).toBe('The harness & its "forge" \'tools\' <b>')
    expect(braveText('&unknown; &#xD800; &#0;')).toBe('&unknown; &#xD800; &#0;')
    expect(braveText(7)).toBe(7)
  })

  it('normalizes the fake\'s answer (published from page_age)', async () => {
    const fake = createFakeSearchFetch()
    const { results } = await searchBackend(braveBackend, { query: 'q', count: 2, key: KEY }, { safeFetch: fake.safeFetch })
    expect(results).toEqual(FAKE_SEARCH_RESULTS.slice(0, 2).map(result => ({ ...result, published: `${result.published}T00:00:00` })))
  })
})
