// Pure helpers of the Marketplaces page (Phase 12, ADR-054; docs/UI.md 8.13, 11.9): the "Add marketplace" input (over the
// shared `parseMarketplaceShorthand`, the only parser of that text), the state of an entry against the installed plugins
// and the updates, the source line of a marketplace or an entry, the search and category filters and the official
// suggestion. No Vue, no stores. Signatures frozen from Gate P12-0b (C46); W12.8 owns the bodies (P12-A).
import type {
  MarketplaceEntry,
  MarketplaceSource,
  PluginSummary,
  PluginUpdate,
} from '@harness-forge/shared'
import { parseMarketplaceShorthand } from '@harness-forge/shared'

/** The official Claude Code marketplace (the suggestion card's repository). */
export const OFFICIAL_MARKETPLACE = 'anthropics/claude-plugins-official'

/** `localStorage` key: `'1'` once the official suggestion was dismissed (wrapped in try/catch by the page). */
export const SUGGESTION_DISMISSED_KEY = 'hf-marketplace-suggestion-dismissed'

/** One entry row of the page: the entry of a marketplace with its state against the installed plugins. */
export interface MarketplaceEntryView {
  marketplaceId: string
  marketplaceName: string
  entry: MarketplaceEntry
  state: 'available' | 'installed' | 'update' | 'unsupported'
  /** The installed plugin of the entry, else null. */
  pluginId: string | null
  /** The installed plugin's version, else null. */
  installedVersion: string | null
  /** The update the marketplace offers for the installed plugin, else null. */
  update: PluginUpdate | null
}

/** What the "Add marketplace" input holds: a source kind and its value, or the reason it is unusable. */
export type MarketplaceInputResult
  = | { kind: 'github', repo: string, ref?: string }
    | { kind: 'url', url: string }
    | { kind: 'folder', path: string }
    | { error: string }

/** The copy of an unusable "Add marketplace" input (docs/UI.md 8.13). */
export const MARKETPLACE_INPUT_ERROR = 'Enter owner/repo, an https URL or an absolute folder path.'

/** Reads the "Add marketplace" input (`owner/repo[#ref]`, a GitHub URL, an https `marketplace.json` URL, a folder). */
export function parseMarketplaceInput(text: string): MarketplaceInputResult {
  const parsed = parseMarketplaceShorthand(text)
  if (parsed === null)
    return { error: MARKETPLACE_INPUT_ERROR }
  switch (parsed.kind) {
    case 'github':
      return parsed.ref === undefined ? { kind: 'github', repo: parsed.repo } : { kind: 'github', repo: parsed.repo, ref: parsed.ref }
    case 'url':
      return { kind: 'url', url: parsed.url }
    case 'path':
      return { kind: 'folder', path: parsed.path }
  }
}

/** The `MarketplaceSource` of a usable input (null for an error). */
export function sourceOfInput(input: MarketplaceInputResult): MarketplaceSource | null {
  if ('error' in input)
    return null
  switch (input.kind) {
    case 'github':
      return input.ref === undefined ? { type: 'github', repo: input.repo } : { type: 'github', repo: input.repo, ref: input.ref }
    case 'url':
      return { type: 'url', url: input.url }
    case 'folder':
      return { type: 'path', path: input.path }
  }
}

/**
 * The state of an entry: `unsupported` (the harness cannot install its source), `update` (installed, and the marketplace
 * offers another version or commit), `installed`, else `available`.
 */
export function entryState(
  entry: MarketplaceEntry,
  marketplaceId: string,
  plugins: readonly PluginSummary[],
  updates: readonly PluginUpdate[],
): MarketplaceEntryView['state'] {
  if (!entry.supported)
    return 'unsupported'
  const pluginId = entry.installedPluginId
  if (pluginId === null)
    return 'available'
  const offered = updates.some(update => update.pluginId === pluginId && update.marketplaceId === marketplaceId)
  if (offered || entry.updateAvailable)
    return 'update'
  // The server knows the install; a plugin list that is not loaded yet does not hide it.
  return plugins.length === 0 || plugins.some(plugin => plugin.id === pluginId) ? 'installed' : 'available'
}

function urlText(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`
  }
  catch {
    return url
  }
}

function hostOf(text: string): string {
  try {
    return new URL(text).host || text
  }
  catch {
    return text
  }
}

/**
 * One source line: a marketplace's (`github.com/<repo>@<sha7>`, the URL's host and path, the folder path) or an entry's
 * ("GitHub {repo}", "npm {package}", "Archive {host}", "In this marketplace" for a relative path, else its text).
 */
export function sourceText(source: MarketplaceSource | MarketplaceEntry['source'], resolvedRef?: string | null): string {
  if ('type' in source) {
    switch (source.type) {
      case 'github': {
        const at = resolvedRef ? `@${resolvedRef.slice(0, 7)}` : source.ref ? `#${source.ref}` : ''
        return `github.com/${source.repo}${at}`
      }
      case 'url':
        return urlText(source.url)
      case 'path':
        return source.path
    }
  }
  switch (source.kind) {
    case 'relative':
      return 'In this marketplace'
    case 'github':
      return `GitHub ${source.text}`
    case 'npm':
      return `npm ${source.text}`
    case 'archive':
    case 'url':
      return `Archive ${hostOf(source.text)}`
    default:
      return source.text
  }
}

/** Entries whose name, description or tags contain `q` (case-insensitive) and whose category is `category` (null = all). */
export function filterEntries(entries: readonly MarketplaceEntryView[], q: string, category: string | null): MarketplaceEntryView[] {
  const needle = q.trim().toLowerCase()
  return entries.filter((view) => {
    if (category !== null && category !== '' && view.entry.category !== category)
      return false
    if (needle === '')
      return true
    const { name, description, tags } = view.entry
    return [name, description ?? '', ...tags].some(text => text.toLowerCase().includes(needle))
  })
}

/** The categories of the entries: sorted, unique, without empty ones. */
export function categoriesOf(entries: readonly MarketplaceEntryView[]): string[] {
  const categories = new Set<string>()
  for (const view of entries) {
    const category = view.entry.category?.trim()
    if (category)
      categories.add(category)
  }
  return [...categories].sort((a, b) => a.localeCompare(b))
}
