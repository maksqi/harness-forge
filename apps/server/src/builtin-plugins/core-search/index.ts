// Builtin plugin `core-search` (Phase 14, ADR-063; PLUGINS.md 1, ARCHITECTURE.md 6.44): the builtin web search tool
// `search_web` (policy `safe`; the composer's Search toggle is the consent), backed by Brave Search, Tavily or Exa with
// the user's own key, registered only while the selected backend has a key (`ctx.settings.onChange` re-checks). Loaded
// right after `core-tools`. Every backend request goes through the `SafeFetch` given to `createCoreSearchPlugin`: the
// plugin-source fetch of `security/ssrf.ts` (`createPluginSourceFetch`: https only; with the test-only
// `HF_TEST_REMOTE_URL` and `HF_MOCK_PROVIDER=1` rerouted to the loopback fake remote), 10 s, 1 MB, no redirect; POST
// bodies for Tavily and Exa. Queries and keys are never logged at `info`; a key never appears in an error.
//
// C50 (P14-0b) landed the final manifest and settings schema and a body that registers no tool (so no chat offers
// `search_web` yet); W14.5 implements `search-web.ts` and `backends/{brave,tavily,exa}.ts` behind
// `createCoreSearchPlugin`. The manifest uses only plugin API 1.0 members (a tool, settings, `ctx.settings.onChange`).
import type { PluginManifest, PluginModule } from '@harness-forge/plugin-sdk'
import type { WebSearchBackend } from '@harness-forge/shared'
import type { SafeFetch } from '../../security/types.ts'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { WEB_SEARCH_BACKENDS } from '@harness-forge/shared'

/** The plugin id (`BUILTIN_PLUGIN_IDS`, after `core-tools`). */
export const CORE_SEARCH_PLUGIN_ID = 'core-search'

/** The default of the `backend` setting. */
export const DEFAULT_SEARCH_BACKEND: WebSearchBackend = 'brave'

/** The default of the `maxResults` setting (the `count` of a call that names none). */
export const DEFAULT_SEARCH_MAX_RESULTS = 5

/** The secret setting that holds each backend's key (`format: 'secret'`, scope `plugin:core-search`, `settings.<key>`). */
export const SEARCH_KEY_SETTINGS = {
  brave: 'braveApiKey',
  tavily: 'tavilyApiKey',
  exa: 'exaApiKey',
} as const satisfies Record<WebSearchBackend, string>

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

/** Settings of `core-search` (`ctx.settings.get()`; the keys are decrypted values, never logged). */
export interface CoreSearchSettings {
  backend?: WebSearchBackend
  braveApiKey?: string
  tavilyApiKey?: string
  exaApiKey?: string
  maxResults?: number
}

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

/**
 * The `core-search` module (C50 stub): `setup` registers no tool, so `search_web` is absent from `GET /tools` and the
 * resolver's `builtinAvailable` is false whatever the settings hold; W14.5 registers `search_web` while the selected
 * backend has a key.
 */
export function createCoreSearchPlugin(_options: CoreSearchPluginOptions): PluginModule {
  return definePlugin({
    setup() {},
  })
}
