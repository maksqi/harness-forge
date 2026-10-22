// Phase 14 records of stored messages (ADR-060, ADR-062, ADR-063; W14.6): the readers that share snapshots
// (../shares/snapshot.ts) and Markdown exports (./export.ts) use for the new content of a reply. No new part type exists:
//
// - a provider-executed search call (native web search, `isProviderExecutedPart`: Anthropic / OpenAI / xAI / OpenRouter
//   `web_search`, Google `google_search`, Groq `browser_search`) is an ordinary tool part with `providerExecuted: true`.
//   Provider tools reach a turn only through the provider's `webSearch` hook, so every provider-executed part is a web
//   search. Its query is the input's `query` (Anthropic, the mock) or the output's `action.query` / `action.queries`
//   (OpenAI, xAI); its output may hold provider-only data (Anthropic `encryptedContent`) that shares and exports never
//   carry (coordinator decision C);
// - a `search_web` call (the builtin of `core-search`) has the output `SearchWebOutput` (`searchWebOutputSchema`);
// - the final output of an MCP tool call (`mcp__<server>__<tool>`) may hold `elicitations`: `McpElicitationRecord`s
//   (message, field names, action, reason; never a value the user entered).
//
// Every reader is lenient (stored parts are untrusted JSON): invalid entries are dropped, nothing throws.
import type { McpElicitationRecord, SearchWebOutput, SearchWebResult } from '@harness-forge/shared'
import {
  MCP_TOOL_PREFIX,
  mcpElicitationRecordSchema,
  SEARCH_WEB_QUERY_MAX_CHARS,
  SEARCH_WEB_RESULTS_MAX,
  searchWebResultSchema,
  webSearchBackendSchema,
} from '@harness-forge/shared'

type UnknownRecord = Record<string, unknown>

/** Elicitation records read from one tool output at most. */
export const ELICITATION_RECORDS_READ_MAX = 50

/** The display names of the `search_web` backends (as the Settings page and the search rows show them). */
export const WEB_SEARCH_BACKEND_LABELS = Object.freeze({ brave: 'Brave Search', tavily: 'Tavily', exa: 'Exa' } as const)

/** C0 / C1 control characters, DEL and bidi overrides / isolates (removed from a query). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as UnknownRecord : null
}

/** True for the registry name of an MCP tool (`mcp__<server>__<tool>`, `mcpToolName`). */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX) && name.length > MCP_TOOL_PREFIX.length
}

/**
 * A query as one line: whitespace collapsed, control characters removed, trimmed, at most `SEARCH_WEB_QUERY_MAX_CHARS`
 * code points; null when nothing is left (or the value is not a string).
 */
export function queryText(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const flat = value.replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').trim()
  if (flat === '')
    return null
  const chars = Array.from(flat)
  return chars.length <= SEARCH_WEB_QUERY_MAX_CHARS ? flat : chars.slice(0, SEARCH_WEB_QUERY_MAX_CHARS).join('').trim()
}

/**
 * The query of a search call: the input's `query` (`search_web`, Anthropic, the mock), else the output's `query`
 * (`SearchWebOutput`), else its `action.query`, else its `action.queries` joined with ", " (OpenAI, xAI). Null when
 * none is a non-empty string (Google and Groq report no query).
 */
export function searchQueryOf(input: unknown, output: unknown): string | null {
  const result = asRecord(output)
  const action = asRecord(result?.action)
  const queries = Array.isArray(action?.queries) ? action.queries.filter(item => typeof item === 'string').join(', ') : undefined
  for (const candidate of [asRecord(input)?.query, result?.query, action?.query, queries]) {
    const query = queryText(candidate)
    if (query !== null)
      return query
  }
  return null
}

/**
 * A stored `search_web` output read leniently: the query (one line, see `queryText`), a known backend and the results
 * that pass `searchWebResultSchema` (an http(s) URL of at most 2048 characters, capped title and snippet), at most
 * `SEARCH_WEB_RESULTS_MAX`, each copied field by field. Null when the value is not a search output (no string `query`,
 * an unknown backend or no `results` array: an error object or the 64 KB truncation marker).
 */
export function searchWebOutputOf(output: unknown): SearchWebOutput | null {
  const record = asRecord(output)
  if (record === null || typeof record.query !== 'string' || !Array.isArray(record.results))
    return null
  const backend = webSearchBackendSchema.safeParse(record.backend)
  if (!backend.success)
    return null
  const results: SearchWebResult[] = []
  for (const item of record.results) {
    if (results.length >= SEARCH_WEB_RESULTS_MAX)
      break
    const parsed = searchWebResultSchema.safeParse(item)
    if (parsed.success) {
      const { title, url, snippet, published } = parsed.data
      results.push({ title, url, snippet, published })
    }
  }
  return { query: queryText(record.query) ?? '', backend: backend.data, results }
}

/** An MCP tool output split into its elicitation records and the rest of the output. */
export interface ElicitationSplit {
  /** The valid records, copied field by field, in order (at most `ELICITATION_RECORDS_READ_MAX`). */
  readonly records: McpElicitationRecord[]
  /** The output without its `elicitations` key. */
  readonly rest: UnknownRecord
}

/**
 * The elicitation records of a stored MCP tool output (`output.elicitations`, `mcpElicitationRecordSchema`), or null
 * when the output is not an object with an `elicitations` key. Invalid records are dropped; a record never holds a
 * value the user entered, and nothing but its five fields is copied.
 */
export function elicitationRecordsOf(output: unknown): ElicitationSplit | null {
  const record = asRecord(output)
  if (record === null || !Object.hasOwn(record, 'elicitations'))
    return null
  const { elicitations, ...rest } = record
  const records: McpElicitationRecord[] = []
  for (const item of Array.isArray(elicitations) ? elicitations.slice(0, ELICITATION_RECORDS_READ_MAX) : []) {
    const parsed = mcpElicitationRecordSchema.safeParse(item)
    if (parsed.success) {
      const { id, message, fields, action, reason } = parsed.data
      records.push({ id, message, fields: [...fields], action, reason })
    }
  }
  return { records, rest }
}
