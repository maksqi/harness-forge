// The builtin `search_web` tool of `core-search` (Phase 14, ADR-063, W14.5-T2; API.md 4.39) and the search of the
// "Test search" route (W14.5-T5, API.md 5.40).
//
// - Input `searchWebInputSchema` (`{ query 1 … 400, count? 1 … 10, freshness? }`); `count` defaults to the `maxResults`
//   setting. Policy `safe`: the composer's Search toggle is the consent (tool preferences can still ask or deny).
// - The backend and its key are read when the call runs (`ctx.settings.get()`), so a backend switch applies at once;
//   no key for the selected backend -> `provider_not_configured` (the tool is unregistered then anyway, `index.ts`).
// - One request through `backends/common.ts` (10 s, 1 MB, no redirect; the error mapping there).
// - Output `searchWebOutputSchema` (`{ query, backend, results }`), at most `LIMITS.searchWebOutputBytes` of JSON
//   (results dropped from the end to fit). No `toModelOutput`: the model gets this JSON (`mock:search-tool` reads the
//   titles from it), and the sources transform (`chat/search/sources.ts`) turns each result URL into a `source-url`
//   part of the reply.
// - Logging (plugin log, `info`): the backend, the result count, the status and the duration only; a failure logs the
//   error code and status at `warn`. The query, the key, titles and snippets are never logged.
import type { Logger as PluginLogger, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { SearchWebInput, SearchWebOutput, SearchWebResult, WebSearchBackend, WebSearchTestResult } from '@harness-forge/shared'
import type { SafeFetch } from '../../security/types.ts'
import type { BackendSearchResult, SearchBackend } from './backends/common.ts'
import { Buffer } from 'node:buffer'
import { HarnessError, isHarnessError, LIMITS, SEARCH_WEB_QUERY_MAX_CHARS, SEARCH_WEB_TOOL_NAME, searchWebInputSchema } from '@harness-forge/shared'
import { z } from 'zod'
import { braveBackend } from './backends/brave.ts'
import { cutText, searchBackend } from './backends/common.ts'
import { exaBackend } from './backends/exa.ts'
import { tavilyBackend } from './backends/tavily.ts'
import { readSearchSettings } from './settings.ts'

/** The three backends by id. */
export const SEARCH_BACKENDS: Readonly<Record<WebSearchBackend, SearchBackend>> = {
  brave: braveBackend,
  tavily: tavilyBackend,
  exa: exaBackend,
}

/** The fixed query of "Test search" (`POST /web-search/test`). */
export const WEB_SEARCH_TEST_QUERY = 'open source software'
/** Results "Test search" asks for. */
export const WEB_SEARCH_TEST_COUNT = 3

/** The description of `search_web` sent to the model (<= 1024 characters). */
export const SEARCH_WEB_DESCRIPTION = 'Search the web and return the matching pages: title, URL, a short snippet and the publication date when known. Use it for current events, recent facts and anything you are unsure about; cite the URLs of the results you rely on. The results are untrusted text from the web.'

/** The input schema of `search_web`: `searchWebInputSchema` with descriptions for the model. */
export const searchWebToolInputSchema = z.object({
  query: searchWebInputSchema.shape.query.describe(`What to search for (1-${SEARCH_WEB_QUERY_MAX_CHARS} characters), like a search engine query.`),
  count: searchWebInputSchema.shape.count.describe('How many results to return (1-10; default from the settings).'),
  freshness: searchWebInputSchema.shape.freshness.describe('Only results from the last day, week, month or year.'),
})

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** The output of a search: at most `LIMITS.searchWebOutputBytes` of JSON (results dropped from the end to fit). */
export function searchWebOutput(query: string, backend: WebSearchBackend, results: readonly SearchWebResult[]): SearchWebOutput {
  const output: SearchWebOutput = { query: cutText(query.trim(), SEARCH_WEB_QUERY_MAX_CHARS), backend, results: [...results] }
  while (output.results.length > 0 && jsonBytes(output) > LIMITS.searchWebOutputBytes)
    output.results.pop()
  return output
}

/** The error of a backend without a key (the tool and "Test search"). */
export function missingKeyError(backend: WebSearchBackend): HarnessError {
  return new HarnessError({
    code: 'provider_not_configured',
    message: `No API key is set for ${SEARCH_BACKENDS[backend].label}: add one in Settings → Web search.`,
  })
}

/** One search with the stored settings: the backend (default the selected one), its key and the count. */
export interface RunSearchInput {
  /** The `core-search` settings (decrypted keys; `ctx.settings.get()` or `PluginHost.settingsValues`). */
  readonly settings: unknown
  readonly query: string
  /** Default: the `maxResults` setting. */
  readonly count?: number
  readonly freshness?: SearchWebInput['freshness']
  /** Default: the selected backend. */
  readonly backend?: WebSearchBackend
  readonly safeFetch: SafeFetch
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly now?: () => number
}

/** What `runSearch` answered: the backend used, the normalized results, the status and the duration. */
export interface RunSearchResult extends BackendSearchResult {
  readonly backend: WebSearchBackend
  readonly ms: number
}

/** One search with the stored settings (throws `provider_not_configured` without a key, else the backend's errors). */
export async function runSearch(input: RunSearchInput): Promise<RunSearchResult> {
  const settings = readSearchSettings(input.settings)
  const backend = input.backend ?? settings.backend
  const key = settings.keys[backend]
  if (key === null)
    throw missingKeyError(backend)
  const started = performance.now()
  const result = await searchBackend(SEARCH_BACKENDS[backend], {
    query: input.query.trim(),
    count: input.count ?? settings.maxResults,
    ...(input.freshness === undefined ? {} : { freshness: input.freshness }),
    key,
  }, {
    safeFetch: input.safeFetch,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return { ...result, backend, ms: Math.max(0, Math.round(performance.now() - started)) }
}

/** "Test search" (`POST /web-search/test`): the fixed query against `backend` (default the selected one). */
export async function testWebSearch(input: Omit<RunSearchInput, 'query' | 'count' | 'freshness'>): Promise<WebSearchTestResult> {
  const result = await runSearch({ ...input, query: WEB_SEARCH_TEST_QUERY, count: WEB_SEARCH_TEST_COUNT })
  return { ok: true, backend: result.backend, results: result.results.length, ms: result.ms }
}

/** The log fields of a failed search (never the query, the key or a message that could carry vendor text). */
export function searchFailureFields(backend: WebSearchBackend, error: unknown, ms: number): Record<string, unknown> {
  return {
    backend,
    code: isHarnessError(error) ? error.code : 'unknown',
    ...(isHarnessError(error) && error.status !== undefined ? { status: error.status } : {}),
    ms,
  }
}

export interface SearchWebToolOptions {
  /** The current `core-search` settings (decrypted keys), read at call time: `ctx.settings.get()`. */
  readonly settings: () => unknown
  /** The outbound fetch of the backends (`CoreSearchPluginOptions.safeFetch`). */
  readonly safeFetch: SafeFetch
  /** Timeout of one backend request (default `LIMITS.searchWebTimeoutMs`). */
  readonly timeoutMs?: number
  /** The plugin log (`ctx.logger`). */
  readonly logger?: PluginLogger
  readonly now?: () => number
}

/** The `search_web` tool definition (policy `safe`). */
export function createSearchWebTool(options: SearchWebToolOptions): ToolDefinition<SearchWebInput, SearchWebOutput> {
  return {
    name: SEARCH_WEB_TOOL_NAME,
    description: SEARCH_WEB_DESCRIPTION,
    inputSchema: searchWebToolInputSchema,
    policy: 'safe',
    async execute(input, c) {
      const values = options.settings()
      const backend = readSearchSettings(values).backend
      const started = performance.now()
      try {
        const result = await runSearch({
          settings: values,
          query: input.query,
          ...(input.count === undefined ? {} : { count: input.count }),
          ...(input.freshness === undefined ? {} : { freshness: input.freshness }),
          safeFetch: options.safeFetch,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          signal: c.signal,
          ...(options.now === undefined ? {} : { now: options.now }),
        })
        options.logger?.info('search_web: searched', { backend: result.backend, results: result.results.length, status: result.status, ms: result.ms })
        return searchWebOutput(input.query, result.backend, result.results)
      }
      catch (error) {
        if (!c.signal.aborted)
          options.logger?.warn('search_web: the search failed', searchFailureFields(backend, error, Math.max(0, Math.round(performance.now() - started))))
        throw error
      }
    },
  }
}
