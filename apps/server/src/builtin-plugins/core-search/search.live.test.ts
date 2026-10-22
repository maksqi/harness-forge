// Live check of the `core-search` backends (W14.5-T6, ADR-027 / ADR-063): one real, PAID search per backend whose key
// is in the environment or the repository `.env` (`BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`; read only
// here, never by the server). Run it only on purpose (`pnpm test:live`); `pnpm test` excludes `*.live.test.ts` and the
// guard below skips it unless `HF_LIVE=1`. The requests go through the real plugin-source fetch (https only, the SSRF
// guard) with the production limits; the key is never printed.
import type { WebSearchBackend } from '@harness-forge/shared'
import process from 'node:process'
import { searchWebOutputSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { liveEnvironment } from '../../live/matrix.ts'
import { createPluginSourceFetch } from '../../security/ssrf.ts'
import { runSearch, searchWebOutput } from './search-web.ts'
import { SEARCH_KEY_SETTINGS } from './settings.ts'

const LIVE_KEYS: Readonly<Record<WebSearchBackend, string>> = {
  brave: 'BRAVE_SEARCH_API_KEY',
  tavily: 'TAVILY_API_KEY',
  exa: 'EXA_API_KEY',
}

describe.runIf(process.env.HF_LIVE === '1')('live web search backends', () => {
  const env = liveEnvironment()
  const safeFetch = createPluginSourceFetch()

  for (const backend of ['brave', 'tavily', 'exa'] as const) {
    const key = env[LIVE_KEYS[backend]]?.trim() ?? ''
    it.skipIf(key === '')(`${backend}: one search returns normalized http(s) results`, async () => {
      const result = await runSearch({
        settings: { backend, [SEARCH_KEY_SETTINGS[backend]]: key },
        query: 'Node.js release schedule',
        count: 3,
        freshness: 'year',
        safeFetch,
      })
      expect(result.status).toBe(200)
      expect(result.results.length).toBeGreaterThan(0)
      expect(result.results.length).toBeLessThanOrEqual(3)
      const output = searchWebOutput('Node.js release schedule', backend, result.results)
      expect(searchWebOutputSchema.safeParse(output).success).toBe(true)
      for (const entry of output.results) {
        expect(entry.url).toMatch(/^https?:\/\//)
        expect(entry.title.length).toBeGreaterThan(0)
      }
    })
  }
})
