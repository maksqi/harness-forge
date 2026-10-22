// Pure rules of web search in the transcript (Phase 14, ADR-062, ADR-063; docs/UI.md 7.35, 11.10): which tool rows are
// search rows (the builtin `search_web` of `core-search`, and the provider-executed search tools of native search), the
// view of a search row's body, and the sources row's domain chips and letter avatars (no favicons: the SPA's CSP blocks
// external images). Snippets and titles are untrusted plain text; links only through `safeExternalUrl`.
// Signatures from C54 (P14-0b, frozen from Gate P14-0b). `isWebSearchPart` is complete (ToolPart mounts
// WebSearchToolBody through it); W14.9 owns the module (it may add helpers) and implements `webSearchView`.
// W14.9 (P14-A): `webSearchView` reads the builtin output (`SearchWebOutput`, each result checked on its own so one bad
// entry never hides the others) and the provider-executed outputs as the providers stream them (Anthropic and the mock:
// an array of `{ type: 'web_search_result', url, title, pageAge, encryptedContent }`; OpenAI and xAI: `{ action: { query |
// queries }, sources: [{ type: 'url', url }] }`; Groq: nothing). `encryptedContent` is never read, shown or copied:
// `stripEncryptedContent` removes it from the raw blocks. Helpers for the row (label, results count), the share page
// (`shareWebSearchKind`: a snapshot's tool part has no `providerExecuted`, so the native tools are known by name) and the
// avatar classes (`SOURCE_AVATAR_CLASSES`, literal Tailwind classes of the `chart-1` … `chart-5` tokens).
import type { ToolPartLike } from '../chat-format'
import { isProviderExecutedPart, SEARCH_WEB_TOOL_NAME, searchWebResultSchema, sourceDomain, webSearchBackendSchema } from '@harness-forge/shared'
import { hostnameOf, safeExternalUrl, toolNameOf } from '../chat-format'
import { WEB_SEARCH_BACKEND_LABELS } from '../composer/web-search'

/** The names of the provider-executed search tools (Anthropic, OpenAI, xAI, OpenRouter; Google; Groq gpt-oss). */
export const NATIVE_WEB_SEARCH_TOOL_NAMES: readonly string[] = ['web_search', 'google_search', 'browser_search']

/** The body of a search row. */
export interface WebSearchView {
  query: string | null
  /** The search API's name of a `search_web` row; null for native search. */
  backend: string | null
  results: { title: string, url: string, domain: string, snippet: string, published: string | null }[]
  native: boolean
}

/** Results one search row lists (the builtin returns at most 10; a provider may list more sources). */
export const WEB_SEARCH_VIEW_RESULTS_MAX = 20
/** Characters of a query, title or snippet kept for display (the builtin caps them too: 400 / 300 / 800). */
const QUERY_MAX_CHARS = 400
const TITLE_MAX_CHARS = 300
const SNIPPET_MAX_CHARS = 800
const PUBLISHED_MAX_CHARS = 64

type WebSearchResultView = WebSearchView['results'][number]

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** One line of display text (whitespace collapsed, capped with an ellipsis); null when empty or not a string. */
function textOf(value: unknown, max: number): string | null {
  if (typeof value !== 'string')
    return null
  const text = value.replace(/\s+/g, ' ').trim()
  if (text === '')
    return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A result with an http(s) link; null for any other URL. */
function resultOf(url: unknown, title: unknown, snippet: unknown, published: unknown): WebSearchResultView | null {
  const href = typeof url === 'string' ? safeExternalUrl(url) : null
  if (!href)
    return null
  const domain = sourceDomain(href) ?? hostnameOf(href)
  return {
    title: textOf(title, TITLE_MAX_CHARS) ?? domain,
    url: href,
    domain,
    snippet: textOf(snippet, SNIPPET_MAX_CHARS) ?? '',
    published: textOf(published, PUBLISHED_MAX_CHARS),
  }
}

/** Results in order, each URL once, at most `WEB_SEARCH_VIEW_RESULTS_MAX`. */
function uniqueResults(results: readonly (WebSearchResultView | null)[]): WebSearchResultView[] {
  const seen = new Set<string>()
  const kept: WebSearchResultView[] = []
  for (const result of results) {
    if (!result || seen.has(result.url))
      continue
    seen.add(result.url)
    kept.push(result)
    if (kept.length >= WEB_SEARCH_VIEW_RESULTS_MAX)
      break
  }
  return kept
}

/** The query of a provider-executed search: the input's (Anthropic, the mock), else the output action's (OpenAI, xAI). */
function nativeQueryOf(input: unknown, output: unknown): string | null {
  const fromInput = textOf(recordOf(input)?.query, QUERY_MAX_CHARS)
  if (fromInput)
    return fromInput
  const action = recordOf(recordOf(output)?.action)
  const queries = Array.isArray(action?.queries) ? action.queries : []
  return textOf(action?.query, QUERY_MAX_CHARS) ?? textOf(queries.find(query => typeof query === 'string'), QUERY_MAX_CHARS)
}

/** The results a provider-executed search lists (titles and links only: never `encryptedContent` or page text). */
function nativeResultsOf(output: unknown): WebSearchResultView[] {
  if (Array.isArray(output)) {
    return uniqueResults(output.slice(0, 100).map((entry) => {
      const item = recordOf(entry)
      return item ? resultOf(item.url, item.title, undefined, item.pageAge) : null
    }))
  }
  const sources = recordOf(output)?.sources
  if (!Array.isArray(sources))
    return []
  return uniqueResults(sources.slice(0, 100).map((entry) => {
    const item = recordOf(entry)
    return item && (item.type === undefined || item.type === 'url') ? resultOf(item.url, item.title, undefined, undefined) : null
  }))
}

/** The view of a search row's input and output; null when nothing parses (the body then shows nothing). W14.9. */
export function webSearchView(input: unknown, output: unknown, native: boolean): WebSearchView | null {
  if (native)
    return { query: nativeQueryOf(input, output), backend: null, results: nativeResultsOf(output), native: true }
  const out = recordOf(output)
  const backend = webSearchBackendSchema.safeParse(out?.backend)
  const listed = Array.isArray(out?.results) ? out.results : null
  const query = textOf(out?.query, QUERY_MAX_CHARS) ?? textOf(recordOf(input)?.query, QUERY_MAX_CHARS)
  // A `search_web` output: its query, backend and results (each checked like the server's schema).
  if (listed && backend.success) {
    const results = uniqueResults(listed.slice(0, 100).map((entry) => {
      const parsed = searchWebResultSchema.safeParse(entry)
      return parsed.success ? resultOf(parsed.data.url, parsed.data.title, parsed.data.snippet, parsed.data.published) : null
    }))
    return { query, backend: WEB_SEARCH_BACKEND_LABELS[backend.data], results, native: false }
  }
  // A call that runs (or failed): the query of its input.
  return query === null ? null : { query, backend: null, results: [], native: false }
}

/** A search row: the builtin `search_web`, or a provider-executed call of a native search tool. */
export function isWebSearchPart(part: ToolPartLike, nativeNames: readonly string[] = NATIVE_WEB_SEARCH_TOOL_NAMES): boolean {
  const name = toolNameOf(part)
  if (name === SEARCH_WEB_TOOL_NAME)
    return !isProviderExecutedPart(part)
  return isProviderExecutedPart(part) && nativeNames.includes(name)
}

/**
 * The search kind of a shared tool row (a snapshot keeps the tool name, not `providerExecuted`): `builtin` for
 * `search_web`, `native` for the provider-executed search tools' names, else null.
 */
export function shareWebSearchKind(toolName: string, nativeNames: readonly string[] = NATIVE_WEB_SEARCH_TOOL_NAMES): 'builtin' | 'native' | null {
  if (toolName === SEARCH_WEB_TOOL_NAME)
    return 'builtin'
  return nativeNames.includes(toolName) ? 'native' : null
}

/** The label of a search row: "Searching the web…" while it runs, else "Searched the web". */
export function webSearchRowLabel(running: boolean): string {
  return running ? 'Searching the web…' : 'Searched the web'
}

/** "{n} results" ("1 result", "No results"). */
export function webSearchResultsText(count: number): string {
  if (count === 0)
    return 'No results'
  return count === 1 ? '1 result' : `${count} results`
}

/** The note of a provider-executed search's body. */
export const NATIVE_WEB_SEARCH_NOTE = 'The model\'s provider ran this search.'

/** Nested levels `stripEncryptedContent` walks (provider outputs are shallow). */
const STRIP_DEPTH_MAX = 8

/**
 * A copy of a tool value without any `encryptedContent` member (Anthropic's encrypted page content of a native search
 * result): the raw blocks of a search row never show or copy it.
 */
export function stripEncryptedContent(value: unknown, depth = 0): unknown {
  if (depth > STRIP_DEPTH_MAX || typeof value !== 'object' || value === null)
    return value
  if (Array.isArray(value))
    return value.map(item => stripEncryptedContent(item, depth + 1))
  const copy: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'encryptedContent')
      copy[key] = stripEncryptedContent(item, depth + 1)
  }
  return copy
}

/** The design tokens of the letter avatars (docs/UI.md 7.35). */
export const SOURCE_AVATAR_TOKENS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const

/** The classes of a letter avatar per token (literal, so Tailwind generates them): a tint of the token and its color. */
export const SOURCE_AVATAR_CLASSES: Readonly<Record<(typeof SOURCE_AVATAR_TOKENS)[number], string>> = {
  'chart-1': 'bg-chart-1/15 text-chart-1',
  'chart-2': 'bg-chart-2/15 text-chart-2',
  'chart-3': 'bg-chart-3/15 text-chart-3',
  'chart-4': 'bg-chart-4/15 text-chart-4',
  'chart-5': 'bg-chart-5/15 text-chart-5',
}

/** The letter avatar of a domain: its first letter, uppercase, on a token chosen by a stable hash of the domain. */
export function sourceAvatar(domain: string): { letter: string, token: (typeof SOURCE_AVATAR_TOKENS)[number] } {
  let hash = 0
  for (const char of domain)
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  const letter = [...domain].find(char => /\p{L}|\p{N}/u.test(char))?.toUpperCase() ?? '?'
  return { letter, token: SOURCE_AVATAR_TOKENS[hash % SOURCE_AVATAR_TOKENS.length]! }
}

/** The domain chips of a sources row: the first `max` unique domains (http(s) only), in order, and how many more. */
export function sourceChips(urls: readonly string[], max = 3): { domains: string[], more: number } {
  const unique: string[] = []
  for (const url of urls) {
    const domain = sourceDomain(url)
    if (domain !== null && !unique.includes(domain))
      unique.push(domain)
  }
  return { domains: unique.slice(0, max), more: Math.max(0, unique.length - max) }
}

/** The sources trigger's accessible name: "{n} sources: {a}, {b} and {m} more". */
export function sourcesTriggerName(count: number, chips: { domains: string[], more: number }): string {
  const label = count === 1 ? '1 source' : `${count} sources`
  if (chips.domains.length === 0)
    return label
  const named = chips.more > 0 ? `${chips.domains.join(', ')} and ${chips.more} more` : chips.domains.join(', ')
  return `${label}: ${named}`
}
