// Pure rules of the composer's web search toggle (docs/UI.md 7.35, 11.10, 12; ADR-062, ADR-063). The resolution itself
// is only `resolveWebSearch` of `@harness-forge/shared` (the rule the server applies to the turn): the toggle asks what
// turning search on would do (`mode: 'auto'`). Signatures from C54 (P14-0b, frozen from Gate P14-0b); W14.8 owns the
// module (it may add helpers) and its tests.
import type { WebSearchBackend, WebSearchResolution, WebSearchResolveInput, WebSearchUnavailableReason } from '@harness-forge/shared'
import { resolveWebSearch } from '@harness-forge/shared'

/** The names of the search APIs of `core-search` (Settings → Web search, the toggle's tooltip). */
export const WEB_SEARCH_BACKEND_LABELS: Readonly<Record<WebSearchBackend, string>> = {
  brave: 'Brave Search',
  tavily: 'Tavily',
  exa: 'Exa',
}

/** The popover text of an unavailable toggle, per resolver reason (docs/UI.md 7.35, 15). */
export const WEB_SEARCH_REASON_TEXT: Readonly<Record<WebSearchUnavailableReason, string>> = {
  'no-backend': 'This model has no web search of its own. Add a search key in Settings → Web search.',
  'tools-unsupported': 'This model can\'t use tools.',
  'tool-mode-off': 'Tools are off in this chat.',
  'tools-conflict': 'This model can\'t search while tools are on. Add a search key in Settings → Web search to search with tools.',
}

/** The Alt+W shortcut of the toggle (`useShortcuts` keys; it obeys `altShortcuts`, docs/UI.md 12). */
export const WEB_SEARCH_SHORTCUT_KEYS = 'alt+code:KeyW'

/** What turning web search on would do for the composer's state (`resolveWebSearch` with `mode: 'auto'`; never off). */
export function webSearchAvailability(input: Omit<WebSearchResolveInput, 'mode'>): WebSearchResolution {
  return resolveWebSearch({ ...input, mode: 'auto' })
}

/**
 * Who searches: the model's provider (native search) or the search API (the builtin `search_web`); null while
 * unavailable or off.
 */
export function webSearchVia(availability: WebSearchResolution, providerName: string | null, backend: WebSearchBackend | null): string | null {
  if (availability.kind === 'native')
    return providerName
  if (availability.kind === 'builtin')
    return backend ? WEB_SEARCH_BACKEND_LABELS[backend] : null
  return null
}

/** The toggle's tooltip: "Web search on · {via}" or "Web search off" (+ the shortcut while `altShortcuts` is on). */
export function webSearchTooltip(on: boolean, via: string | null, altShortcuts: boolean): string {
  const text = on ? (via ? `Web search on · ${via}` : 'Web search on') : 'Web search off'
  return altShortcuts ? `${text} (Alt+W)` : text
}
