// `POST /web-search/test` (W14.5-T5, API.md 5.40): the fixed query against the selected backend or the body's, through
// the loaded `core-search` module's own fetch (`createFakeSearchFetch` here); 400 `provider_not_configured` without a
// key (or without `core-search`), the error mapping of the tool (key rejected 502, rate limited 429, unreachable 502),
// the strict body, and no key or query in an answer or a log line. `HF_OFFLINE` does not block it.
import type { BuiltinPluginId } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeSearchFetch } from '../../testing/fake-search.ts'
import { harnessErrorEnvelopeSchema, webSearchTestResultSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { CORE_SEARCH_PLUGIN_ID, createCoreSearchPlugin, manifest, WEB_SEARCH_TEST_QUERY } from '../../builtin-plugins/core-search/index.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeSearchFetch } from '../../testing/fake-search.ts'

const KEYS = { braveApiKey: 'brave-route-canary-1', tavilyApiKey: 'tavily-route-canary-2', exaApiKey: 'exa-route-canary-3' }

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0))
    await cleanup()
})

async function searchApp(options: { env?: Record<string, string>, withPlugin?: boolean } = {}): Promise<{ t: TestApp, fake: FakeSearchFetch }> {
  const fake = createFakeSearchFetch()
  const builtins = options.withPlugin === false
    ? []
    : [{ id: CORE_SEARCH_PLUGIN_ID as BuiltinPluginId, manifest, module: createCoreSearchPlugin({ safeFetch: fake.safeFetch, timeoutMs: 30 }) }]
  const t = await createTestApp({ env: options.env ?? {}, builtins, start: false })
  cleanups.push(() => t.close())
  await t.deps.plugins.start()
  return { t, fake }
}

async function post(t: TestApp, body: unknown): Promise<{ status: number, body: unknown, text: string }> {
  const response = await t.request('/api/web-search/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) as unknown, text: `${[...response.headers.entries()].join('\n')}\n${text}` }
}

function expectNoSecrets(t: TestApp, text: string): void {
  for (const secret of [...Object.values(KEYS), WEB_SEARCH_TEST_QUERY]) {
    expect(text).not.toContain(secret)
    expect(t.logs.text()).not.toContain(secret)
  }
}

describe('pOST /web-search/test', () => {
  it('runs the fixed query against the selected backend: { ok, backend, results, ms }', async () => {
    const { t, fake } = await searchApp()
    await t.deps.plugins.updateSettings(CORE_SEARCH_PLUGIN_ID, { ...KEYS })
    const answer = await post(t, {})
    expect(answer.status).toBe(200)
    expect(webSearchTestResultSchema.parse(answer.body)).toEqual({ ok: true, backend: 'brave', results: 3, ms: expect.any(Number) })
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).toMatchObject({ method: 'GET', status: 200 })
    expect(new URL(fake.requests[0]!.url).searchParams.get('q')).toBe(WEB_SEARCH_TEST_QUERY)
    expectNoSecrets(t, answer.text)
    expect(t.logs.records.some(record => record.msg === 'web search test')).toBe(true)
  })

  it('tests the body\'s backend (Tavily and Exa post a JSON body; the key only in the header)', async () => {
    const { t, fake } = await searchApp()
    await t.deps.plugins.updateSettings(CORE_SEARCH_PLUGIN_ID, { ...KEYS })
    expect((await post(t, { backend: 'tavily' })).body).toMatchObject({ ok: true, backend: 'tavily', results: 3 })
    expect((await post(t, { backend: 'exa' })).body).toMatchObject({ ok: true, backend: 'exa', results: 3 })
    expect(fake.requests.map(request => [request.method, request.body])).toEqual([
      ['POST', expect.objectContaining({ query: WEB_SEARCH_TEST_QUERY, max_results: 3 })],
      ['POST', expect.objectContaining({ query: WEB_SEARCH_TEST_QUERY, numResults: 3 })],
    ])
    expect(JSON.stringify(fake.requests)).not.toContain(KEYS.tavilyApiKey)
  })

  it('400 provider_not_configured without a key for the backend, or without core-search', async () => {
    const { t, fake } = await searchApp()
    await t.deps.plugins.updateSettings(CORE_SEARCH_PLUGIN_ID, { braveApiKey: KEYS.braveApiKey })
    const missing = await post(t, { backend: 'exa' })
    expect(missing.status).toBe(400)
    expect(harnessErrorEnvelopeSchema.parse(missing.body).error).toMatchObject({ code: 'provider_not_configured', message: 'No API key is set for Exa: add one in Settings → Web search.' })
    expect(fake.requests).toEqual([])
    const bare = await searchApp({ withPlugin: false })
    const none = await post(bare.t, {})
    expect(none.status).toBe(400)
    expect(harnessErrorEnvelopeSchema.parse(none.body).error.code).toBe('provider_not_configured')
  })

  it('maps the backend errors: key rejected 502, rate limited 429, unreachable 502 (the key never echoed)', async () => {
    const { t, fake } = await searchApp()
    await t.deps.plugins.updateSettings(CORE_SEARCH_PLUGIN_ID, { ...KEYS })
    fake.setMode('brave', '401')
    const rejected = await post(t, {})
    expect(rejected.status).toBe(502)
    expect(harnessErrorEnvelopeSchema.parse(rejected.body).error).toMatchObject({ code: 'provider_error', message: 'The search key was rejected.', status: 401 })
    fake.setMode('brave', '429')
    const limited = await post(t, {})
    expect(limited.status).toBe(429)
    expect(harnessErrorEnvelopeSchema.parse(limited.body).error).toMatchObject({ code: 'rate_limited', retryAfterMs: 1000 })
    fake.setMode('brave', 'timeout')
    const unreachable = await post(t, {})
    expect(unreachable.status).toBe(502)
    expect(harnessErrorEnvelopeSchema.parse(unreachable.body).error.code).toBe('provider_unreachable')
    fake.setMode('brave', 'bad-json')
    expect((await post(t, {})).status).toBe(502)
    for (const answer of [rejected, limited, unreachable])
      expectNoSecrets(t, answer.text)
    expect(t.logs.records.filter(record => record.msg === 'web search test failed')).toHaveLength(4)
  })

  it('validates the body strictly (an unknown backend or field is a 400)', async () => {
    const { t, fake } = await searchApp()
    expect((await post(t, { backend: 'google' })).status).toBe(400)
    expect((await post(t, { backend: 'brave', query: 'x' })).status).toBe(400)
    expect(fake.requests).toEqual([])
  })

  it('hF_OFFLINE does not block it', async () => {
    const { t } = await searchApp({ env: { HF_OFFLINE: '1' } })
    await t.deps.plugins.updateSettings(CORE_SEARCH_PLUGIN_ID, { ...KEYS, backend: 'exa' })
    const answer = await post(t, {})
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ ok: true, backend: 'exa' })
  })
})
