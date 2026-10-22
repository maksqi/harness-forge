// The `core-search` backends over real loopback HTTP (W14.5-T1 / T5): the e2e fake remote (`e2e/fixtures/fake-remote.mjs`,
// started on port 0) behind the real plugin-source fetch with the `HF_TEST_REMOTE_URL` reroute, as the gate probes and the
// e2e specs run it: Brave's GET and the POST JSON bodies of Tavily and Exa arrive, the keys `invalid-key` and
// `rate-limited` map to the tool's errors, and the fake's log never holds a key. The child process is stopped and its
// exit asserted.
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPluginSourceFetch } from '../../security/ssrf.ts'
import { runSearch } from './search-web.ts'

const FAKE_REMOTE_PATH = fileURLToPath(new URL('../../../../../e2e/fixtures/fake-remote.mjs', import.meta.url))
const KEYS = { braveApiKey: 'brave-loopback-canary', tavilyApiKey: 'tavily-loopback-canary', exaApiKey: 'exa-loopback-canary' }

describe('core-search through the e2e fake remote (loopback)', () => {
  let child: ChildProcess
  let exited: Promise<number | null>
  let base = ''

  beforeAll(async () => {
    child = spawn(process.execPath, [FAKE_REMOTE_PATH, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } })
    exited = new Promise(resolve => child.once('exit', code => resolve(code)))
    const line = await new Promise<string>((resolve, reject) => {
      createInterface({ input: child.stdout! }).once('line', resolve)
      child.once('exit', () => reject(new Error('The fake remote exited early.')))
    })
    base = (JSON.parse(line) as { url: string }).url
  })

  afterAll(async () => {
    child.kill('SIGTERM')
    expect(await exited).toBe(0)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('searches every backend through the rerouted plugin-source fetch; the log shows GET / POST JSON, never a key', async () => {
    const safeFetch = createPluginSourceFetch({ testRemoteUrl: base })
    for (const backend of ['brave', 'tavily', 'exa'] as const) {
      const result = await runSearch({ settings: { backend, ...KEYS }, query: 'loopback search', count: 2, safeFetch })
      expect(result.results.map(entry => entry.title), backend).toEqual(['Result one', 'Result two'])
      expect(result.results.map(entry => entry.url), backend).toEqual(['https://example.com/a', 'https://example.org/b'])
    }
    const log = await (await fetch(`${base}/__log`)).json() as Array<Record<string, unknown>>
    expect(log.map(entry => [entry.method, entry.host, entry.status])).toEqual([
      ['GET', 'api.search.brave.com', 200],
      ['POST', 'api.tavily.com', 200],
      ['POST', 'api.exa.ai', 200],
    ])
    expect(log[1]?.body).toEqual({ query: 'loopback search', max_results: 2, search_depth: 'basic', include_published_date: true })
    expect(log[2]?.body).toEqual({ query: 'loopback search', numResults: 2, type: 'auto', contents: { highlights: true } })
    for (const key of Object.values(KEYS))
      expect(JSON.stringify(log)).not.toContain(key)
  }, 20_000)

  it('maps the fake\'s invalid-key (401) and rate-limited (429) keys', async () => {
    const safeFetch = createPluginSourceFetch({ testRemoteUrl: base })
    await expect(runSearch({ settings: { backend: 'tavily', tavilyApiKey: 'invalid-key' }, query: 'q', safeFetch })).rejects.toMatchObject({ code: 'provider_error', message: 'The search key was rejected.', status: 401 })
    await expect(runSearch({ settings: { backend: 'exa', exaApiKey: 'rate-limited' }, query: 'q', safeFetch })).rejects.toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 1000 })
  }, 20_000)
})
