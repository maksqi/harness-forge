/**
 * Web search resolution (Phase 14, ADR-062 / ADR-063): one pure rule, used by the server for every turn and by the
 * composer for the toggle's state, decides whether a turn searches with the model's own provider-executed search tool
 * (native), with the builtin `search_web` tool of `core-search` (builtin), not at all (off), or cannot search
 * (unavailable, with a reason). Native and builtin search are never offered in the same request. Pure and isomorphic;
 * never throws.
 * Contract skeleton written by the coordinator in P14-0a; implemented by C48. Adding members is fine; renaming or
 * removing one is a CCR.
 *
 * Rules, in order: mode `off` → off; tool mode `off` → unavailable `tool-mode-off`; a `native` model with
 * `preferNative` → native; an `exclusive` model (Gemini 2.x: Google Search drops function tools) with `preferNative`
 * and no other function tool this turn → native (exclusive); the builtin is available (a backend key is set) and the
 * model supports tools → builtin; otherwise unavailable: `tools-conflict` (an exclusive model with function tools and no
 * builtin), `tools-unsupported` (the model has no tool support), `no-backend` (no native search and no backend key).
 * Plan, Accept edits, Ask and Auto all allow search (it is read-only).
 *
 * Details (C48): the unavailable reasons are tried in the order listed (`tools-conflict` needs `preferNative`; a model
 * without tools and without a key is `tools-unsupported`, because a key would not help it). Inputs are read
 * defensively: any mode other than `auto` is off; a `native` value other than the two kinds is null; the booleans count
 * only when they are `true`; `functionTools` counts as "none" only when it is a number ≤ 0 (anything else keeps an
 * exclusive model off native search, so function tools are never dropped silently).
 */
import type { ToolMode } from '../enums.ts'

/** Name of the builtin search tool (never `web_search`: Anthropic's server tool uses that wire name). */
export const SEARCH_WEB_TOOL_NAME = 'search_web'

/** Most searches one provider-executed search tool may run in one turn (`maxUses` / `max_results`). */
export const WEB_SEARCH_MAX_USES = 5

/** The per-chat web search modes (`chats.settings.webSearch`, the request body, the global default). */
export const WEB_SEARCH_MODES = ['off', 'auto'] as const
export type WebSearchMode = typeof WEB_SEARCH_MODES[number]

/** A model's native search support (`catalogModel.webSearch`): `exclusive` = only without function tools. */
export const MODEL_WEB_SEARCH_KINDS = ['native', 'exclusive'] as const
export type ModelWebSearchKind = typeof MODEL_WEB_SEARCH_KINDS[number]

export const WEB_SEARCH_UNAVAILABLE_REASONS = ['tool-mode-off', 'tools-conflict', 'tools-unsupported', 'no-backend'] as const
export type WebSearchUnavailableReason = typeof WEB_SEARCH_UNAVAILABLE_REASONS[number]

/** The builtin search backends of `core-search`. */
export const WEB_SEARCH_BACKENDS = ['brave', 'tavily', 'exa'] as const
export type WebSearchBackend = typeof WEB_SEARCH_BACKENDS[number]

export interface WebSearchResolveInput {
  readonly mode: WebSearchMode
  readonly toolMode: ToolMode
  /** The model's native support (null = none). */
  readonly native: ModelWebSearchKind | null
  /** The global setting `webSearchNative` (false = always the builtin). */
  readonly preferNative: boolean
  /** True when `core-search` has a key for its selected backend (the `search_web` tool is registered). */
  readonly builtinAvailable: boolean
  /** The model supports tool calls. */
  readonly modelTools: boolean
  /** Function tools this turn would send besides search (the composer passes an estimate: 1 when tools are on). */
  readonly functionTools: number
}

export type WebSearchResolution
  = | { readonly kind: 'off' }
    | { readonly kind: 'native', readonly exclusive: boolean }
    | { readonly kind: 'builtin' }
    | { readonly kind: 'unavailable', readonly reason: WebSearchUnavailableReason }

/** The one resolution rule (see the module comment). */
export function resolveWebSearch(input: WebSearchResolveInput): WebSearchResolution {
  try {
    if (typeof input !== 'object' || input === null || input.mode !== 'auto')
      return { kind: 'off' }
    if (input.toolMode === 'off')
      return { kind: 'unavailable', reason: 'tool-mode-off' }
    const native = input.native === 'native' || input.native === 'exclusive' ? input.native : null
    const preferNative = input.preferNative === true
    const modelTools = input.modelTools === true
    const noFunctionTools = typeof input.functionTools === 'number' && input.functionTools <= 0
    if (native === 'native' && preferNative)
      return { kind: 'native', exclusive: false }
    if (native === 'exclusive' && preferNative && noFunctionTools)
      return { kind: 'native', exclusive: true }
    if (input.builtinAvailable === true && modelTools)
      return { kind: 'builtin' }
    if (native === 'exclusive' && preferNative)
      return { kind: 'unavailable', reason: 'tools-conflict' }
    if (!modelTools)
      return { kind: 'unavailable', reason: 'tools-unsupported' }
    return { kind: 'unavailable', reason: 'no-backend' }
  }
  catch {
    return { kind: 'off' }
  }
}

/**
 * True for a stored or streamed UI tool part (or model tool call) the provider executed itself
 * (`providerExecuted === true`), e.g. Anthropic's `web_search` or OpenAI's `web_search` calls.
 */
export function isProviderExecutedPart(part: unknown): boolean {
  try {
    if (typeof part !== 'object' || part === null || Array.isArray(part))
      return false
    const record = part as Record<string, unknown>
    const type = Object.hasOwn(record, 'type') ? record.type : undefined
    if (typeof type !== 'string')
      return false
    const toolPart = type === 'dynamic-tool' || (type.startsWith('tool-') && type.length > 'tool-'.length)
    return toolPart && Object.hasOwn(record, 'providerExecuted') && record.providerExecuted === true
  }
  catch {
    return false
  }
}

/**
 * The host of a source / result URL for chips and avatars (`www.` removed, lowercase), or null for a non-http URL. The
 * host is the WHATWG `URL` parser's ASCII `hostname`: an internationalized host shows as punycode (`xn--…`), so a
 * lookalike Unicode domain stays visible; IPv4 shorthands are normalized, an IPv6 host keeps its brackets and a
 * trailing dot is dropped.
 */
export function sourceDomain(url: string): string | null {
  try {
    if (typeof url !== 'string' || !URL.canParse(url))
      return null
    const parsed = new URL(url)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '')
      return null
    let host = parsed.hostname.toLowerCase()
    if (host.endsWith('.'))
      host = host.slice(0, -1)
    if (host.startsWith('www.') && host.slice(4).includes('.'))
      host = host.slice(4)
    return host === '' ? null : host
  }
  catch {
    return null
  }
}
