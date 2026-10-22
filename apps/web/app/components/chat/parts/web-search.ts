// Pure rules of web search in the transcript (Phase 14, ADR-062, ADR-063; docs/UI.md 7.35, 11.10): which tool rows are
// search rows (the builtin `search_web` of `core-search`, and the provider-executed search tools of native search), the
// view of a search row's body, and the sources row's domain chips and letter avatars (no favicons: the SPA's CSP blocks
// external images). Snippets and titles are untrusted plain text; links only through `safeExternalUrl`.
// Signatures from C54 (P14-0b, frozen from Gate P14-0b). `isWebSearchPart` is complete (ToolPart mounts
// WebSearchToolBody through it); W14.9 owns the module (it may add helpers) and implements `webSearchView`.
import type { ToolPartLike } from '../chat-format'
import { isProviderExecutedPart, SEARCH_WEB_TOOL_NAME, sourceDomain } from '@harness-forge/shared'
import { toolNameOf } from '../chat-format'

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

/** The view of a search row's input and output; null when nothing parses (the body then shows nothing). W14.9. */
export function webSearchView(_input: unknown, _output: unknown, _native: boolean): WebSearchView | null {
  return null
}

/** A search row: the builtin `search_web`, or a provider-executed call of a native search tool. */
export function isWebSearchPart(part: ToolPartLike, nativeNames: readonly string[] = NATIVE_WEB_SEARCH_TOOL_NAMES): boolean {
  const name = toolNameOf(part)
  if (name === SEARCH_WEB_TOOL_NAME)
    return !isProviderExecutedPart(part)
  return isProviderExecutedPart(part) && nativeNames.includes(name)
}

/** The design tokens of the letter avatars (docs/UI.md 7.35). */
export const SOURCE_AVATAR_TOKENS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'] as const

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
