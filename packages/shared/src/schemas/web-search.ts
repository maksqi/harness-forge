// Web search DTOs (Phase 14; API.md section 4.39): the input and output of the builtin `search_web` tool of `core-search`
// (ADR-063) and the "Test search" route. The per-chat mode (`webSearchModeSchema`), the model flag
// (`modelWebSearchSchema`) and the backends (`webSearchBackendSchema`) are enums (`enums.ts`); the resolution rule is
// `resolveWebSearch` (`util/web-search.ts`). Search snippets are untrusted text: shown as plain text, capped here.
import { z } from 'zod'
import { webSearchBackendSchema } from '../enums.ts'
import { hasControlChars } from '../util/text.ts'

/** Characters of a `search_web` query. */
export const SEARCH_WEB_QUERY_MAX_CHARS = 400
/** Results of one `search_web` call (`count`, the `maxResults` setting of `core-search`). */
export const SEARCH_WEB_RESULTS_MAX = 10
/** Characters of a result title. */
export const SEARCH_WEB_TITLE_MAX_CHARS = 300
/** Characters of a result URL. */
export const SEARCH_WEB_URL_MAX_CHARS = 2048
/** Characters of a result snippet. */
export const SEARCH_WEB_SNIPPET_MAX_CHARS = 800

/** True for an absolute http(s) URL of at most 2048 characters without whitespace or control characters. */
function isResultUrl(value: string): boolean {
  if (value.length === 0 || value.length > SEARCH_WEB_URL_MAX_CHARS || /\s/.test(value) || hasControlChars(value) || !URL.canParse(value))
    return false
  const url = new URL(value)
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== ''
}

/** How recent the results of a `search_web` call must be (mapped to each backend's own filter). */
export const searchWebFreshnessSchema = z.enum(['day', 'week', 'month', 'year'])
export type SearchWebFreshness = z.infer<typeof searchWebFreshnessSchema>

/**
 * Input of the builtin `search_web` tool (ADR-063): the query (1..400 characters), how many results (1..10; default the
 * `maxResults` setting of `core-search`) and an optional freshness filter.
 */
export const searchWebInputSchema = z.object({
  query: z.string().trim().min(1).max(SEARCH_WEB_QUERY_MAX_CHARS),
  count: z.int().min(1).max(SEARCH_WEB_RESULTS_MAX).optional(),
  freshness: searchWebFreshnessSchema.optional(),
})
export type SearchWebInput = z.infer<typeof searchWebInputSchema>

/** One normalized search result (every backend maps to it; a result with a non-http(s) URL is dropped). */
export const searchWebResultSchema = z.object({
  title: z.string().max(SEARCH_WEB_TITLE_MAX_CHARS),
  url: z.string().refine(isResultUrl, 'Expected an http(s) URL of at most 2048 characters.'),
  snippet: z.string().max(SEARCH_WEB_SNIPPET_MAX_CHARS),
  /** The publication date the backend reports (as given, e.g. an ISO date or "2 days ago"); null = unknown. */
  published: z.string().max(64).nullable(),
})
export type SearchWebResult = z.infer<typeof searchWebResultSchema>

/**
 * Output of the builtin `search_web` tool: the query, the backend that answered and the results (at most
 * `LIMITS.searchWebOutputBytes` of JSON; results are dropped from the end to fit). Each result URL also becomes a
 * `source-url` part of the reply (deduplicated).
 */
export const searchWebOutputSchema = z.object({
  query: z.string().max(SEARCH_WEB_QUERY_MAX_CHARS),
  backend: webSearchBackendSchema,
  results: z.array(searchWebResultSchema).max(SEARCH_WEB_RESULTS_MAX),
})
export type SearchWebOutput = z.infer<typeof searchWebOutputSchema>

/**
 * Body of `POST /web-search/test` ("Test search" of Settings -> Web search; no fresh auth): runs one fixed query against
 * `backend` (default: the backend selected in the `core-search` settings) with its stored key. The query and the key are
 * never logged.
 */
export const webSearchTestBodySchema = z.strictObject({
  backend: webSearchBackendSchema.optional(),
})
export type WebSearchTestBody = z.infer<typeof webSearchTestBodySchema>

/** Answer of `POST /web-search/test`: the backend answered (a failure is an error envelope). */
export const webSearchTestResultSchema = z.object({
  ok: z.literal(true),
  backend: webSearchBackendSchema,
  /** Results the backend returned. */
  results: z.int().min(0),
  /** Round-trip time in milliseconds. */
  ms: z.int().min(0),
})
export type WebSearchTestResult = z.infer<typeof webSearchTestResultSchema>
