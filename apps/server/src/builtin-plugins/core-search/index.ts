// Builtin plugin `core-search` (Phase 14, ADR-063; PLUGINS.md 1, ARCHITECTURE.md 6.44): the builtin web search tool
// `search_web` (policy `safe`; the composer's Search toggle is the consent), backed by Brave Search, Tavily or Exa with
// the user's own key, registered only while the selected backend has a key (`ctx.settings.onChange` re-checks). Loaded
// right after `core-tools`. Every backend request goes through the `SafeFetch` given to `createCoreSearchPlugin`: the
// plugin-source fetch of `security/ssrf.ts` (`createPluginSourceFetch`: https only; with the test-only
// `HF_TEST_REMOTE_URL` and `HF_MOCK_PROVIDER=1` rerouted to the loopback fake remote), 10 s, 1 MB, no redirect; POST
// bodies for Tavily and Exa. Queries and keys are never logged at `info`; a key never appears in an error.
//
// C50 (P14-0b) landed the final manifest and settings schema; W14.5 implemented the tool (`search-web.ts`), the
// backends (`backends/{brave,tavily,exa}.ts` on `backends/common.ts`) and the key-gated registration below. The
// manifest uses only plugin API 1.0 members (a tool, settings, `ctx.settings.onChange`). `HF_OFFLINE` does not block
// the tool (like `web_fetch`: it runs only on the user's turn). The "Test search" route (`http/routes/web-search.ts`)
// runs its search through the same `SafeFetch` as the tool (`coreSearchRuntime`).
import type { Disposable, PluginManifest, PluginModule } from '@harness-forge/plugin-sdk'
import type { SafeFetch } from '../../security/types.ts'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { LIMITS, WEB_SEARCH_BACKENDS } from '@harness-forge/shared'
import { createSearchWebTool } from './search-web.ts'
import { DEFAULT_SEARCH_BACKEND, DEFAULT_SEARCH_MAX_RESULTS, readSearchSettings, selectedBackendHasKey } from './settings.ts'

export { createSearchWebTool, runSearch, SEARCH_BACKENDS, searchWebOutput, testWebSearch, WEB_SEARCH_TEST_QUERY } from './search-web.ts'
export { DEFAULT_SEARCH_BACKEND, DEFAULT_SEARCH_MAX_RESULTS, readSearchSettings, SEARCH_KEY_SETTINGS, selectedBackendHasKey } from './settings.ts'
export type { CoreSearchSettings, SearchSettings } from './settings.ts'

/** The plugin id (`BUILTIN_PLUGIN_IDS`, after `core-tools`). */
export const CORE_SEARCH_PLUGIN_ID = 'core-search'

export const manifest = {
  manifestVersion: 1,
  id: CORE_SEARCH_PLUGIN_ID,
  name: 'Web search',
  version: '1.0.0',
  description: 'Builtin web search tool search_web, backed by Brave Search, Tavily or Exa with your own API key.',
  engines: { harness: '^1.0.0' },
  main: 'index.ts',
  permissions: ['network'],
  settings: {
    type: 'object',
    properties: {
      backend: {
        type: 'string',
        title: 'Backend',
        description: 'The search API that search_web uses. Web search is available only while this backend has a key.',
        enum: [...WEB_SEARCH_BACKENDS],
        default: DEFAULT_SEARCH_BACKEND,
      },
      braveApiKey: {
        type: 'string',
        title: 'Brave Search API key',
        description: 'The subscription token of the Brave Search API.',
        format: 'secret',
      },
      tavilyApiKey: {
        type: 'string',
        title: 'Tavily API key',
        description: 'The API key of Tavily.',
        format: 'secret',
      },
      exaApiKey: {
        type: 'string',
        title: 'Exa API key',
        description: 'The API key of Exa.',
        format: 'secret',
      },
      maxResults: {
        type: 'integer',
        title: 'Max results',
        description: 'How many results one search returns when the model does not ask for a number (1-10).',
        minimum: 1,
        maximum: 10,
        default: DEFAULT_SEARCH_MAX_RESULTS,
      },
    },
  },
} satisfies PluginManifest

/** Options of `createCoreSearchPlugin`. */
export interface CoreSearchPluginOptions {
  /**
   * The outbound fetch of every backend request: `createPluginSourceFetch({ testRemoteUrl })` in production
   * (`getBuiltinPlugins`); tests inject a fake (`createFakeSearchFetch`, `testing/fake-search.ts`).
   */
  readonly safeFetch: SafeFetch
  /** Timeout of one backend request (default `LIMITS.searchWebTimeoutMs`, 10 s; tests pass small values). */
  readonly timeoutMs?: number
}

/** What a `core-search` module searches with (the "Test search" route reads it through `coreSearchRuntime`). */
export interface CoreSearchRuntime {
  readonly safeFetch: SafeFetch
  readonly timeoutMs: number
}

/** The runtime of every module built by `createCoreSearchPlugin` (a server-internal side channel, never in `ctx`). */
const RUNTIMES = new WeakMap<PluginModule, CoreSearchRuntime>()

/** The fetch and timeout of a module built by `createCoreSearchPlugin` (`BuiltinPlugin.module`), else null. */
export function coreSearchRuntime(module: PluginModule): CoreSearchRuntime | null {
  return RUNTIMES.get(module) ?? null
}

/**
 * The `core-search` module: `search_web` is registered only while the selected backend has a key (W14.5-T3). `setup`
 * checks the stored settings, and every saved change (`ctx.settings.onChange`, with the full new values) registers the
 * tool or disposes its registration; the tool reads the backend, the key and `maxResults` when a call runs. Without the
 * tool, `GET /tools` does not list it and the resolver's `builtinAvailable` is false (the notice `no-backend`).
 */
export function createCoreSearchPlugin(options: CoreSearchPluginOptions): PluginModule {
  const runtime: CoreSearchRuntime = { safeFetch: options.safeFetch, timeoutMs: options.timeoutMs ?? LIMITS.searchWebTimeoutMs }
  const module = definePlugin({
    setup(ctx) {
      let registration: Disposable | null = null
      const tool = createSearchWebTool({
        settings: () => ctx.settings.get(),
        safeFetch: runtime.safeFetch,
        timeoutMs: runtime.timeoutMs,
        logger: ctx.logger,
      })
      const evaluate = (values: unknown): void => {
        const available = selectedBackendHasKey(readSearchSettings(values))
        if (available && registration === null) {
          try {
            registration = ctx.tools.register(tool)
          }
          catch (error) {
            // Another plugin took the name first (`conflict`): web search stays without the builtin tool.
            ctx.logger.warn('search_web could not be registered', { err: error instanceof Error ? error.message : String(error) })
          }
        }
        else if (!available && registration !== null) {
          registration.dispose()
          registration = null
        }
      }
      evaluate(ctx.settings.get())
      ctx.settings.onChange(values => evaluate(values))
    },
  })
  RUNTIMES.set(module, runtime)
  return module
}
