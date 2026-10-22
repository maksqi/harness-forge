// Web search test route (API.md 5.40, ADR-063). Owner: W14.5 (W14.5-T5, replacing C47's 501 stub). Thin: validate, run
// one search through `core-search`'s backend client.
//
// - `POST /web-search/test` (body `{ backend? }`, default the backend selected in the `core-search` settings; no fresh
//   auth): runs one fixed query (`WEB_SEARCH_TEST_QUERY`, 3 results) with the stored key of that backend and answers
//   `{ ok: true, backend, results, ms }`. The request goes through the `SafeFetch` of the loaded `core-search` builtin
//   (`coreSearchRuntime`: the plugin-source fetch, https only, with the test remote when `HF_TEST_REMOTE_URL` is honored),
//   else a plugin-source fetch built here the same way; 10 s, 1 MB, no redirects. `400` `provider_not_configured` when
//   the backend has no key (or `core-search` is not installed), `502` `provider_error` "The search key was rejected."
//   for a 401 / 403 (the key is never echoed), `429` `rate_limited`, `502` `provider_unreachable`, `502` `provider_error`
//   for any other failure. `HF_OFFLINE` does not block it (an explicit user action).
// - Logs only the backend, the result count, the status and the duration (never the query or the key).
import type { SafeFetch } from '../../security/types.ts'
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, isHarnessError, LIMITS, webSearchTestBodySchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { CORE_SEARCH_PLUGIN_ID, coreSearchRuntime, readSearchSettings, testWebSearch } from '../../builtin-plugins/core-search/index.ts'
import { searchFailureFields } from '../../builtin-plugins/core-search/search-web.ts'
import { createPluginSourceFetch } from '../../security/ssrf.ts'
import { validate } from '../validate.ts'

export function createWebSearchRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  let fallbackFetch: SafeFetch | null = null

  /** The fetch and timeout of the loaded `core-search` builtin, else a plugin-source fetch like `getBuiltinPlugins`'. */
  function runtime(): { safeFetch: SafeFetch, timeoutMs: number } {
    const builtin = deps.builtins.find(plugin => (plugin.id as string) === CORE_SEARCH_PLUGIN_ID)
    const own = builtin === undefined ? null : coreSearchRuntime(builtin.module)
    if (own !== null)
      return own
    fallbackFetch ??= createPluginSourceFetch({ testRemoteUrl: deps.env.testRemoteUrl })
    return { safeFetch: fallbackFetch, timeoutMs: LIMITS.searchWebTimeoutMs }
  }

  /** The `core-search` settings with decrypted keys (none when the plugin is unknown). */
  async function settings(): Promise<Record<string, unknown>> {
    try {
      return await deps.plugins.settingsValues(CORE_SEARCH_PLUGIN_ID)
    }
    catch (error) {
      if (isHarnessError(error) && error.code === 'not_found')
        return {}
      throw error
    }
  }

  app.post(apiRoutes['webSearch.test'].path, validate('json', webSearchTestBodySchema), async (c) => {
    const body = c.req.valid('json')
    const values = await settings()
    const backend = body.backend ?? readSearchSettings(values).backend
    const { safeFetch, timeoutMs } = runtime()
    const started = performance.now()
    try {
      const result = await testWebSearch({ settings: values, backend, safeFetch, timeoutMs, signal: c.req.raw.signal })
      deps.logger.info('web search test', { backend: result.backend, results: result.results, ms: result.ms })
      return c.json(result)
    }
    catch (error) {
      deps.logger.info('web search test failed', searchFailureFields(backend, error, Math.max(0, Math.round(performance.now() - started))))
      throw error
    }
  })

  return app
}
