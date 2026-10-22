// The search fakes of Phase 14 (C53-T4 / C53-T5): `createFakeSearchFetch` per backend and mode, and the e2e fake remote
// (`e2e/fixtures/fake-remote.mjs`, plain Node) started as a script on port 0 and queried on every route. Loopback only.
import type { WebSearchBackend } from '@harness-forge/shared'
import type { ChildProcess } from 'node:child_process'
import type { SafeFetch } from '../security/types.ts'
import type { FakeSearchFetchCallOptions } from './fake-search.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { HarnessError } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginSourceFetch } from '../security/ssrf.ts'
import {
  BRAVE_SEARCH_URL,
  createFakeSearchFetch,
  EXA_SEARCH_URL,
  FAKE_SEARCH_DEFAULT_COUNTS,
  FAKE_SEARCH_MODES,
  FAKE_SEARCH_REDIRECT_URL,
  FAKE_SEARCH_RESULTS,
  fakeSearchAnswer,
  TAVILY_SEARCH_URL,
} from './fake-search.ts'

const MAX_BYTES = 1024 * 1024
const KEY = 'sk-test-search-key-1234'

/** The request of each backend as `core-search` sends it (design shapes). */
function request(backend: WebSearchBackend, key: string | null = KEY, count = 3, query = 'harness forge'): { url: string, options: FakeSearchFetchCallOptions } {
  switch (backend) {
    case 'brave':
      return { url: `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${count}`, options: { maxBytes: MAX_BYTES, maxRedirects: 0, protocols: ['https:'], headers: key === null ? {} : { 'X-Subscription-Token': key } } }
    case 'tavily':
      return { url: TAVILY_SEARCH_URL, options: { method: 'POST', maxBytes: MAX_BYTES, maxRedirects: 0, protocols: ['https:'], headers: { 'content-type': 'application/json', ...(key === null ? {} : { Authorization: `Bearer ${key}` }) }, body: JSON.stringify({ query, max_results: count, search_depth: 'basic' }) } }
    case 'exa':
      return { url: EXA_SEARCH_URL, options: { method: 'POST', maxBytes: MAX_BYTES, maxRedirects: 0, protocols: ['https:'], headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'x-api-key': key }) }, body: JSON.stringify({ query, numResults: count, type: 'auto', contents: { highlights: true } }) } }
  }
}

function bodyJson(body: Uint8Array): unknown {
  return JSON.parse(Buffer.from(body).toString('utf8')) as unknown
}

function titlesOf(backend: WebSearchBackend, value: unknown): string[] {
  const results = backend === 'brave' ? (value as { web: { results: Array<{ title: string }> } }).web.results : (value as { results: Array<{ title: string }> }).results
  return results.map(result => result.title)
}

const BACKENDS: WebSearchBackend[] = ['brave', 'tavily', 'exa']

afterEach(() => {
  vi.useRealTimers()
})

describe('createFakeSearchFetch', () => {
  it('is a SafeFetch (also with the Phase 14 POST options)', () => {
    const fake = createFakeSearchFetch()
    const asSafeFetch: SafeFetch = fake.safeFetch
    expect(typeof asSafeFetch).toBe('function')
    expect(FAKE_SEARCH_MODES).toEqual(['ok', '401', '403', '429', '500', 'timeout', 'oversize', 'bad-json', 'redirect'])
  })

  it.each(BACKENDS)('%s: answers the vendor shape with the requested count and logs the call with the key redacted', async (backend) => {
    const fake = createFakeSearchFetch()
    const { url, options } = request(backend, KEY, 3)
    const result = await fake.safeFetch(url, options)
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toBe('application/json')
    const value = bodyJson(result.body)
    expect(value).toEqual(fakeSearchAnswer(backend, 'harness forge', FAKE_SEARCH_RESULTS.slice(0, 3)))
    expect(titlesOf(backend, value)).toEqual(['Result one', 'Result two', 'Result three'])
    expect(fake.requests).toHaveLength(1)
    const logged = fake.requests[0]!
    expect(logged).toMatchObject({ method: backend === 'brave' ? 'GET' : 'POST', url, status: 200 })
    expect(JSON.stringify(logged)).not.toContain(KEY)
    expect(Object.values(logged.headers)).toContain('<redacted>')
    if (backend !== 'brave')
      expect(logged.body).toMatchObject({ query: 'harness forge' })
    else
      expect(logged.body).toBeNull()
  })

  it('the canned results and the vendor shapes', async () => {
    expect(FAKE_SEARCH_RESULTS).toHaveLength(20)
    expect(FAKE_SEARCH_RESULTS.slice(0, 3)).toEqual([
      { title: 'Result one', url: 'https://example.com/a', snippet: 'Snippet one of the fake search.', published: '2026-10-20' },
      { title: 'Result two', url: 'https://example.org/b', snippet: 'Snippet two of the fake search.', published: '2026-10-19' },
      { title: 'Result three', url: 'https://example.com/c', snippet: 'Snippet three of the fake search.', published: '2026-10-18' },
    ])
    const one = FAKE_SEARCH_RESULTS.slice(0, 1)
    expect(fakeSearchAnswer('brave', 'q', one)).toEqual({ type: 'search', query: { original: 'q' }, web: { type: 'search', results: [{ title: 'Result one', url: 'https://example.com/a', description: 'Snippet one of the fake search.', page_age: '2026-10-20T00:00:00', age: '2026-10-20' }] } })
    expect(fakeSearchAnswer('tavily', 'q', one)).toMatchObject({ query: 'q', results: [{ title: 'Result one', url: 'https://example.com/a', content: 'Snippet one of the fake search.', published_date: '2026-10-20' }] })
    expect(fakeSearchAnswer('exa', 'q', one)).toMatchObject({ results: [{ title: 'Result one', url: 'https://example.com/a', publishedDate: '2026-10-20T00:00:00.000Z', highlights: ['Snippet one of the fake search.'] }] })
    // Without a count: the vendor default; a count above 20 is capped; custom results.
    for (const backend of BACKENDS) {
      const { url, options } = request(backend)
      const bare = backend === 'brave' ? `${BRAVE_SEARCH_URL}?q=x` : url
      const body = backend === 'brave' ? undefined : JSON.stringify({ query: 'x' })
      const answered = bodyJson((await createFakeSearchFetch().safeFetch(bare, { ...options, ...(body === undefined ? {} : { body }) })).body)
      expect(titlesOf(backend, answered), backend).toHaveLength(FAKE_SEARCH_DEFAULT_COUNTS[backend])
      const many = request(backend, KEY, 50)
      expect(titlesOf(backend, bodyJson((await createFakeSearchFetch().safeFetch(many.url, many.options)).body))).toHaveLength(20)
    }
    const custom = createFakeSearchFetch({ results: [{ title: 'Only', url: 'https://only.example/', snippet: '', published: null }] })
    const { url, options } = request('brave')
    expect(titlesOf('brave', bodyJson((await custom.safeFetch(url, options)).body))).toEqual(['Only'])
  })

  it.each(BACKENDS)('%s: keys — missing or invalid-key 401, rate-limited 429, the keys option; never echoed', async (backend) => {
    const fake = createFakeSearchFetch({ keys: { [backend]: 'expected-key' } })
    const statusFor = async (key: string | null): Promise<number> => {
      const { url, options } = request(backend, key)
      const result = await fake.safeFetch(url, options)
      expect(Buffer.from(result.body).toString('utf8')).not.toContain(key ?? 'no-key')
      return result.status
    }
    expect(await statusFor(null)).toBe(401)
    expect(await statusFor('invalid-key')).toBe(401)
    expect(await statusFor('rate-limited')).toBe(429)
    expect(await statusFor('another-key')).toBe(401)
    expect(await statusFor('expected-key')).toBe(200)
  })

  it.each(BACKENDS)('%s: modes 401, 403, 429 and 500 answer the vendor error with that status', async (backend) => {
    const fake = createFakeSearchFetch()
    for (const mode of ['401', '403', '429', '500'] as const) {
      fake.setMode(backend, mode)
      const { url, options } = request(backend)
      const result = await fake.safeFetch(url, options)
      expect(result.status, mode).toBe(Number(mode))
      expect(result.headers.get('retry-after'), mode).toBe(mode === '429' ? '1' : null)
      expect(Buffer.from(result.body).toString('utf8')).not.toContain(KEY)
    }
    fake.reset()
    expect(fake.requests).toEqual([])
    const { url, options } = request(backend)
    expect((await fake.safeFetch(url, options)).status).toBe(200)
  })

  it('mode timeout: no answer until timeoutMs, then provider_unreachable; an abort ends it earlier', async () => {
    vi.useFakeTimers()
    const fake = createFakeSearchFetch({ modes: { tavily: 'timeout' } })
    const { url, options } = request('tavily')
    let settled = false
    const pending = fake.safeFetch(url, { ...options, timeoutMs: 10_000 }).finally(() => {
      settled = true
    })
    const failure = expect(pending).rejects.toMatchObject({ code: 'provider_unreachable', message: 'The request to api.tavily.com timed out after 10000 ms.' })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await failure
    const controller = new AbortController()
    const aborted = fake.safeFetch(url, { ...options, signal: controller.signal })
    controller.abort(new Error('stop'))
    await expect(aborted).rejects.toThrow('stop')
    expect(fake.requests.map(entry => entry.status)).toEqual([null, null])
  })

  it('modes oversize, bad-json and redirect', async () => {
    const fake = createFakeSearchFetch({ modes: { brave: 'oversize', tavily: 'bad-json', exa: 'redirect' } })
    const brave = request('brave')
    const oversize = await fake.safeFetch(brave.url, brave.options).catch((error: unknown) => error)
    expect(oversize).toBeInstanceOf(HarnessError)
    expect(oversize).toMatchObject({ code: 'payload_too_large', details: { limitBytes: MAX_BYTES } })
    const tavily = request('tavily')
    const badJson = await fake.safeFetch(tavily.url, tavily.options)
    expect(badJson.status).toBe(200)
    expect(() => JSON.parse(Buffer.from(badJson.body).toString('utf8'))).toThrow()
    // A POST never follows a redirect: the 302 is the result.
    const exa = request('exa')
    const redirected = await fake.safeFetch(exa.url, exa.options)
    expect([redirected.status, redirected.headers.get('location')]).toEqual([302, FAKE_SEARCH_REDIRECT_URL])
    // A GET follows it like safeFetch: beyond maxRedirects a provider_error, within it the target is refused.
    fake.setMode('brave', 'redirect')
    await expect(fake.safeFetch(brave.url, brave.options)).rejects.toMatchObject({ code: 'provider_error', message: 'Too many redirects: api.search.brave.com redirected more than 0 times.' })
    await expect(fake.safeFetch(brave.url, { ...brave.options, maxRedirects: 1 })).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('refuses what safeFetch refuses: other hosts, protocols, credentials, bodies without POST, bodies over 64 KiB', async () => {
    const fake = createFakeSearchFetch()
    const { options } = request('brave')
    await expect(fake.safeFetch('https://example.com/search', options)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(fake.safeFetch('http://api.search.brave.com/res/v1/web/search?q=x', options)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(fake.safeFetch('https://user:pw@api.search.brave.com/res/v1/web/search?q=x', options)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(fake.safeFetch(BRAVE_SEARCH_URL, { ...options, body: '{}' })).rejects.toMatchObject({ code: 'validation_error' })
    const tavily = request('tavily')
    await expect(fake.safeFetch(TAVILY_SEARCH_URL, { ...tavily.options, body: 'x'.repeat(64 * 1024 + 1) })).rejects.toMatchObject({ code: 'validation_error' })
    // Another method on a backend URL: 405; HEAD on Brave: an empty body.
    expect((await fake.safeFetch(TAVILY_SEARCH_URL, { ...options })).status).toBe(405)
    expect((await fake.safeFetch(`${BRAVE_SEARCH_URL}?q=x`, { ...options, method: 'HEAD' })).body).toHaveLength(0)
    expect(fake.requests).toHaveLength(7)
  })

  it('logs a Tavily key sent in the body redacted', async () => {
    const fake = createFakeSearchFetch()
    await fake.safeFetch(TAVILY_SEARCH_URL, { method: 'POST', maxBytes: MAX_BYTES, body: JSON.stringify({ query: 'q', api_key: KEY }) })
    expect(fake.requests[0]?.body).toEqual({ query: 'q', api_key: '<redacted>' })
    expect(fake.requests[0]?.status).toBe(200)
  })
})

// ---------- the e2e fake remote ----------

const FAKE_REMOTE_PATH = fileURLToPath(new URL('../../../../e2e/fixtures/fake-remote.mjs', import.meta.url))

async function startScript(args: string[], env: Record<string, string> = {}): Promise<{ child: ChildProcess, url: string, exited: Promise<number | null> }> {
  const child = spawn(process.execPath, [FAKE_REMOTE_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', ...env } })
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  const line = await new Promise<string>((resolve, reject) => {
    createInterface({ input: child.stdout! }).once('line', resolve)
    child.once('exit', () => reject(new Error('The fake remote exited early.')))
  })
  return { child, url: (JSON.parse(line) as { url: string }).url, exited }
}

describe('e2e fake remote (e2e/fixtures/fake-remote.mjs)', () => {
  it('serves the three backends behind the HF_TEST_REMOTE_URL layout, logs without keys, resets, stops on SIGTERM', async () => {
    const { child, url, exited } = await startScript(['--port', '0'])
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect((await fetch(url)).status).toBe(200)
      const brave = await fetch(`${url}/api.search.brave.com/res/v1/web/search?q=harness%20forge&count=3`, { headers: { 'X-Subscription-Token': KEY } })
      expect(await brave.json()).toEqual(fakeSearchAnswer('brave', 'harness forge', FAKE_SEARCH_RESULTS.slice(0, 3)))
      const tavily = await fetch(`${url}/api.tavily.com/search`, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${KEY}` }, body: JSON.stringify({ query: 'q', max_results: 2 }) })
      expect(await tavily.json()).toEqual(fakeSearchAnswer('tavily', 'q', FAKE_SEARCH_RESULTS.slice(0, 2)))
      const exa = await fetch(`${url}/api.exa.ai/search`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify({ query: 'q', numResults: 4 }) })
      expect(await exa.json()).toEqual(fakeSearchAnswer('exa', 'q', FAKE_SEARCH_RESULTS.slice(0, 4)))
      const defaults = await fetch(`${url}/api.tavily.com/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'q', api_key: KEY }) })
      expect(titlesOf('tavily', await defaults.json())).toHaveLength(5)
      const invalid = await fetch(`${url}/api.exa.ai/search`, { method: 'POST', headers: { 'x-api-key': 'invalid-key' }, body: '{}' })
      expect(invalid.status).toBe(401)
      expect(await invalid.text()).not.toContain('invalid-key')
      const limited = await fetch(`${url}/api.search.brave.com/res/v1/web/search?q=x`, { headers: { 'X-Subscription-Token': 'rate-limited' } })
      expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '1'])
      expect((await fetch(`${url}/api.search.brave.com/res/v1/web/search?q=x`)).status).toBe(401)
      expect((await fetch(`${url}/api.tavily.com/search`)).status).toBe(405)
      expect((await fetch(`${url}/api.github.com/repos/a/b`)).status).toBe(404)
      const log = await (await fetch(`${url}/__log`)).json() as Array<Record<string, unknown>>
      expect(log.map(entry => [entry.method, entry.host, entry.status])).toEqual([
        ['GET', 'api.search.brave.com', 200],
        ['POST', 'api.tavily.com', 200],
        ['POST', 'api.exa.ai', 200],
        ['POST', 'api.tavily.com', 200],
        ['POST', 'api.exa.ai', 401],
        ['GET', 'api.search.brave.com', 429],
        ['GET', 'api.search.brave.com', 401],
        ['GET', 'api.tavily.com', 405],
        ['GET', 'api.github.com', 404],
      ])
      expect(log[0]?.path).toBe('/res/v1/web/search?q=harness%20forge&count=3')
      expect(log[1]?.body).toEqual({ query: 'q', max_results: 2 })
      expect(log[3]?.body).toEqual({ query: 'q', api_key: '<redacted>' })
      expect(JSON.stringify(log)).not.toContain(KEY)
      expect(await (await fetch(`${url}/__reset`, { method: 'POST' })).json()).toEqual({ ok: true })
      expect(await (await fetch(`${url}/__log`)).json()).toEqual([])
      // The real reroute of `createPluginSourceFetch` (HF_TEST_REMOTE_URL) reaches it.
      const rerouted = createPluginSourceFetch({ testRemoteUrl: url })
      const result = await rerouted(`${BRAVE_SEARCH_URL}?q=reroute&count=2`, { maxBytes: MAX_BYTES, maxRedirects: 0, headers: { 'X-Subscription-Token': KEY } })
      expect(titlesOf('brave', bodyJson(result.body))).toEqual(['Result one', 'Result two'])
    }
    finally {
      child.kill('SIGTERM')
    }
    expect(await exited).toBe(0)
  }, 20_000)

  it('takes its port from E2E_FAKE_REMOTE_PORT and refuses a non-loopback host or a bad port', async () => {
    const { child, url, exited } = await startScript([], { E2E_FAKE_REMOTE_PORT: '0' })
    child.kill('SIGTERM')
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(await exited).toBe(0)
    for (const args of [['--host', '0.0.0.0'], ['--port', 'abc']]) {
      const failing = spawn(process.execPath, [FAKE_REMOTE_PATH, ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
      expect(await new Promise<number | null>(resolve => failing.once('exit', code => resolve(code))), args.join(' ')).toBe(1)
    }
  }, 20_000)
})
