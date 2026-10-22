// The builtin `search_web` tool (W14.5-T2) against every mode of `createFakeSearchFetch`: the definition, the count
// default, the backend read at call time, the error mapping, the 32 KB output cap and the log hygiene (backend, count,
// status and duration only: never the query, the key, a title or a snippet).
import type { Logger as PluginLogger, ToolCallContext } from '@harness-forge/plugin-sdk'
import type { SearchWebOutput, WebSearchBackend } from '@harness-forge/shared'
import type { FakeSearchMode, FakeSearchResult } from '../../testing/fake-search.ts'
import { Buffer } from 'node:buffer'
import { HarnessError, LIMITS, SEARCH_WEB_TOOL_NAME, searchWebOutputSchema } from '@harness-forge/shared'
import { asSchema } from 'ai'
import { describe, expect, it } from 'vitest'
import { createFakeSearchFetch, FAKE_SEARCH_MODES, FAKE_SEARCH_RESULTS } from '../../testing/fake-search.ts'
import { SEARCH_KEY_REJECTED_MESSAGE } from './backends/common.ts'
import { createSearchWebTool, missingKeyError, runSearch, SEARCH_WEB_DESCRIPTION, searchWebOutput, testWebSearch, WEB_SEARCH_TEST_COUNT, WEB_SEARCH_TEST_QUERY } from './search-web.ts'

const KEYS = { braveApiKey: 'brave-key-canary-11', tavilyApiKey: 'tavily-key-canary-22', exaApiKey: 'exa-key-canary-33' }
const QUERY = 'query canary 8e1f'

interface LogEntry { level: string, message: string, data: unknown }

function recordingLogger(): { logger: PluginLogger, entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const at = (level: string) => (message: string, data?: unknown) => void entries.push({ level, message, data })
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, entries }
}

function context(signal: AbortSignal = new AbortController().signal): ToolCallContext {
  return { chatId: '0199a8f0-0000-7000-8000-000000000001', modelRef: 'mock:search-tool', toolCallId: 'call_1', messages: [], signal }
}

function tool(settings: Record<string, unknown>, options: { modes?: Partial<Record<WebSearchBackend, FakeSearchMode>>, results?: readonly FakeSearchResult[] } = {}) {
  const fake = createFakeSearchFetch(options)
  const log = recordingLogger()
  let current = settings
  const definition = createSearchWebTool({ settings: () => current, safeFetch: fake.safeFetch, timeoutMs: 20, logger: log.logger })
  return {
    fake,
    log,
    definition,
    setSettings: (next: Record<string, unknown>) => {
      current = next
    },
    run: async (input: { query: string, count?: number, freshness?: 'day' | 'week' | 'month' | 'year' }, signal?: AbortSignal) =>
      definition.execute(input, context(signal)) as Promise<SearchWebOutput>,
  }
}

function expectCleanLogs(entries: readonly LogEntry[]): void {
  const text = JSON.stringify(entries)
  for (const secret of [...Object.values(KEYS), QUERY, 'Result one', 'Snippet one'])
    expect(text).not.toContain(secret)
}

describe('search_web: the definition', () => {
  it('is search_web, policy safe, with the shared input schema and no toModelOutput (the model reads the JSON)', async () => {
    const { definition } = tool({})
    expect(definition).toMatchObject({ name: SEARCH_WEB_TOOL_NAME, policy: 'safe' })
    expect(definition.toModelOutput).toBeUndefined()
    expect(SEARCH_WEB_DESCRIPTION.length).toBeLessThanOrEqual(1024)
    const schema = asSchema(definition.inputSchema)
    expect(await schema.validate!({ query: '  cats  ' })).toEqual({ success: true, value: { query: 'cats' } })
    expect((await schema.validate!({ query: '' })).success).toBe(false)
    expect((await schema.validate!({ query: 'x'.repeat(401) })).success).toBe(false)
    expect((await schema.validate!({ query: 'cats', count: 11 })).success).toBe(false)
    expect((await schema.validate!({ query: 'cats', freshness: 'hour' })).success).toBe(false)
    const json = await schema.jsonSchema as { properties: Record<string, { description?: string }> }
    expect(Object.keys(json.properties)).toEqual(['query', 'count', 'freshness'])
    expect(Object.values(json.properties).every(property => typeof property.description === 'string')).toBe(true)
  })
})

describe('search_web: a search', () => {
  it('searches the selected backend; count defaults to maxResults; the output is the normalized JSON', async () => {
    const t = tool({ backend: 'brave', maxResults: 4, ...KEYS })
    const output = await t.run({ query: QUERY })
    expect(searchWebOutputSchema.parse(output)).toEqual(output)
    expect(output).toEqual({ query: QUERY, backend: 'brave', results: FAKE_SEARCH_RESULTS.slice(0, 4).map(result => ({ ...result, published: `${result.published}T00:00:00` })) })
    expect(new URL(t.fake.requests[0]!.url).searchParams.get('count')).toBe('4')
    // An explicit count wins; the default maxResults is 5.
    expect((await t.run({ query: QUERY, count: 2 })).results).toHaveLength(2)
    t.setSettings({ ...KEYS })
    expect((await t.run({ query: QUERY })).results).toHaveLength(5)
    expect(t.log.entries.filter(entry => entry.level === 'info')).toEqual([
      { level: 'info', message: 'search_web: searched', data: { backend: 'brave', results: 4, status: 200, ms: expect.any(Number) } },
      { level: 'info', message: 'search_web: searched', data: { backend: 'brave', results: 2, status: 200, ms: expect.any(Number) } },
      { level: 'info', message: 'search_web: searched', data: { backend: 'brave', results: 5, status: 200, ms: expect.any(Number) } },
    ])
    expectCleanLogs(t.log.entries)
  })

  it('reads the backend when the call runs (a switch applies at once) and passes freshness on', async () => {
    const t = tool({ backend: 'brave', ...KEYS })
    await t.run({ query: QUERY, freshness: 'day' })
    t.setSettings({ backend: 'tavily', ...KEYS })
    expect((await t.run({ query: QUERY, freshness: 'year' })).backend).toBe('tavily')
    t.setSettings({ backend: 'exa', ...KEYS })
    expect((await t.run({ query: QUERY })).backend).toBe('exa')
    expect(t.fake.requests.map(request => request.method)).toEqual(['GET', 'POST', 'POST'])
    expect(new URL(t.fake.requests[0]!.url).searchParams.get('freshness')).toBe('pd')
    expect(t.fake.requests[1]!.body).toMatchObject({ query: QUERY, time_range: 'year' })
    expect(t.fake.requests[2]!.body).toMatchObject({ query: QUERY, numResults: 5 })
    expect(JSON.stringify(t.fake.requests)).not.toContain(KEYS.tavilyApiKey)
  })

  it('without a key for the selected backend: provider_not_configured, nothing sent', async () => {
    const t = tool({ backend: 'exa', braveApiKey: KEYS.braveApiKey })
    await expect(t.run({ query: QUERY })).rejects.toMatchObject({ code: 'provider_not_configured', message: 'No API key is set for Exa: add one in Settings → Web search.' })
    expect(t.fake.requests).toEqual([])
    expect(missingKeyError('brave').message).toBe('No API key is set for Brave Search: add one in Settings → Web search.')
  })

  it.each(FAKE_SEARCH_MODES.filter(mode => mode !== 'ok'))('mode %s: the mapped error, a warn log without secrets', async (mode) => {
    const expected: Record<Exclude<FakeSearchMode, 'ok'>, string> = {
      '401': 'provider_error',
      '403': 'provider_error',
      '429': 'rate_limited',
      '500': 'provider_error',
      'timeout': 'provider_unreachable',
      'oversize': 'provider_error',
      'bad-json': 'provider_error',
      'redirect': 'provider_error',
    }
    for (const backend of ['brave', 'tavily', 'exa'] as const) {
      const t = tool({ backend, ...KEYS }, { modes: { [backend]: mode } })
      const error = await t.run({ query: QUERY }).then(() => null, (reason: unknown) => reason as HarnessError)
      expect(error, backend).toBeInstanceOf(HarnessError)
      expect(error!.code, backend).toBe(expected[mode as Exclude<FakeSearchMode, 'ok'>])
      if (mode === '401' || mode === '403')
        expect(error!.message).toBe(SEARCH_KEY_REJECTED_MESSAGE)
      expect(`${error!.message} ${JSON.stringify(error!.details ?? null)}`).not.toContain(KEYS[`${backend}ApiKey`])
      const warnings = t.log.entries.filter(entry => entry.level === 'warn')
      expect(warnings).toEqual([{ level: 'warn', message: 'search_web: the search failed', data: expect.objectContaining({ backend, code: expected[mode as Exclude<FakeSearchMode, 'ok'>], ms: expect.any(Number) }) }])
      expect(t.log.entries.filter(entry => entry.level === 'info')).toEqual([])
      expectCleanLogs(t.log.entries)
    }
  })

  it('an aborted call rejects with the abort reason and logs nothing', async () => {
    const t = tool({ ...KEYS }, { modes: { brave: 'timeout' } })
    const controller = new AbortController()
    const pending = t.definition.execute({ query: QUERY }, { ...context(controller.signal) }) as Promise<unknown>
    const reason = new Error('stopped')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(t.log.entries).toEqual([])
  })
})

describe('search_web: the output cap', () => {
  it('keeps the output at most 32 KB of JSON by dropping results from the end', async () => {
    const wide: FakeSearchResult[] = Array.from({ length: 10 }, (_, index) => ({
      title: '日'.repeat(400),
      url: `https://example.com/${index}/${'p'.repeat(1900)}`,
      snippet: '本'.repeat(1000),
      published: '2026-10-20',
    }))
    const t = tool({ ...KEYS, maxResults: 10 }, { results: wide })
    const output = await t.run({ query: QUERY })
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThanOrEqual(LIMITS.searchWebOutputBytes)
    expect(output.results.length).toBeGreaterThan(0)
    expect(output.results.length).toBeLessThan(10)
    expect(output.results.map(result => result.url)).toEqual(wide.slice(0, output.results.length).map(result => result.url))
    expect(output.results[0]!.title).toHaveLength(300)
    expect(output.results[0]!.snippet).toHaveLength(800)
    expect(searchWebOutputSchema.safeParse(output).success).toBe(true)
  })

  it('searchWebOutput trims and caps the query', () => {
    expect(searchWebOutput('  cats  ', 'exa', [])).toEqual({ query: 'cats', backend: 'exa', results: [] })
    expect(searchWebOutput('q'.repeat(500), 'exa', []).query).toHaveLength(400)
  })
})

describe('runSearch / testWebSearch', () => {
  it('"Test search": the fixed query, 3 results, the given backend or the selected one', async () => {
    const fake = createFakeSearchFetch()
    const result = await testWebSearch({ settings: { backend: 'tavily', ...KEYS }, safeFetch: fake.safeFetch })
    expect(result).toEqual({ ok: true, backend: 'tavily', results: WEB_SEARCH_TEST_COUNT, ms: expect.any(Number) })
    expect(fake.requests[0]!.body).toMatchObject({ query: WEB_SEARCH_TEST_QUERY, max_results: 3 })
    const brave = await testWebSearch({ settings: { backend: 'tavily', ...KEYS }, backend: 'brave', safeFetch: fake.safeFetch })
    expect(brave.backend).toBe('brave')
    await expect(testWebSearch({ settings: {}, safeFetch: fake.safeFetch })).rejects.toMatchObject({ code: 'provider_not_configured' })
  })

  it('reads blank keys as missing and clamps maxResults', async () => {
    const fake = createFakeSearchFetch()
    await expect(runSearch({ settings: { braveApiKey: '   ' }, query: 'q', safeFetch: fake.safeFetch })).rejects.toMatchObject({ code: 'provider_not_configured' })
    const result = await runSearch({ settings: { braveApiKey: ` ${KEYS.braveApiKey} `, maxResults: 99 }, query: 'q', safeFetch: fake.safeFetch })
    expect(result.results).toHaveLength(10)
    expect(fake.requests.at(-1)!.headers['x-subscription-token']).toBe('<redacted>')
  })
})
