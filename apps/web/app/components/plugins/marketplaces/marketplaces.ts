// Pure helpers of the Marketplaces page (Phase 12, ADR-054; docs/UI.md 8.13, 11.9): the "Add marketplace" input (over the
// shared `parseMarketplaceShorthand`, the only parser of that text), the state of an entry against the installed plugins
// and the updates, the source line of a marketplace or an entry, the search and category filters and the official
// suggestion. No Vue, no stores. Signatures frozen from Gate P12-0b (C46); W12.8 owns the bodies (P12-A) and adds the
// copy helpers below the frozen ones (state words, chip names, the add errors, the page query, a bounded loader).
import type {
  MarketplaceEntry,
  MarketplaceList,
  MarketplaceSource,
  MarketplaceSummary,
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

// ---------- W12.8 additions (P12-A): copy, query and loading helpers of the page ----------

/** The kinds of the "Add marketplace" source toggle, in order. */
export type MarketplaceInputKind = 'github' | 'url' | 'folder'

/** The source toggle of the add dialog: label and placeholder per kind (URLs live here, never in a template prop). */
export const MARKETPLACE_INPUT_KINDS: readonly { value: MarketplaceInputKind, label: string, placeholder: string }[] = [
  { value: 'github', label: 'GitHub', placeholder: 'owner/repo#ref' },
  { value: 'url', label: 'URL', placeholder: 'https://example.com/marketplace.json' },
  { value: 'folder', label: 'Folder on this server', placeholder: '/srv/marketplaces/acme' },
]

/** The state words of an entry (its accessible name "{name}, {state}"). */
export const ENTRY_STATE_WORDS: Readonly<Record<MarketplaceEntryView['state'], string>> = {
  available: 'Available',
  installed: 'Installed',
  update: 'Update available',
  unsupported: 'Unsupported',
}

/** The version an update offers: the update's, else the entry's; null when the update is a newer commit. */
export function offeredVersion(view: MarketplaceEntryView): string | null {
  return view.update?.availableVersion ?? view.entry.version ?? null
}

/**
 * The state line of an entry: "Installed", "Installed · Update to {version}" ("Installed · Update available" for a
 * newer commit), "Unsupported source ({type})"; empty for an available entry (its button says it).
 */
export function entryStatusText(view: MarketplaceEntryView): string {
  switch (view.state) {
    case 'installed':
      return 'Installed'
    case 'update': {
      const version = offeredVersion(view)
      return version ? `Installed · Update to ${version}` : 'Installed · Update available'
    }
    case 'unsupported':
      return `Unsupported source (${view.entry.source.kind})`
    default:
      return ''
  }
}

/** The accessible name of a marketplace chip: "{name}, {n} plugins" (", {u} updates", ", last refresh failed"). */
export function chipName(item: MarketplaceSummary): string {
  let name = `${item.name}, ${item.plugins} ${item.plugins === 1 ? 'plugin' : 'plugins'}`
  if (item.updates > 0)
    name += `, ${item.updates} ${item.updates === 1 ? 'update' : 'updates'}`
  if (item.lastError)
    name += ', last refresh failed'
  return name
}

/** "· {u} updates" of a chip ("· 1 update"). */
export function updatesText(count: number): string {
  return `· ${count} ${count === 1 ? 'update' : 'updates'}`
}

/** The repository of the official marketplace is this source (case-insensitive). */
export function isOfficialSource(source: MarketplaceSource): boolean {
  return source.type === 'github' && source.repo.toLowerCase() === OFFICIAL_MARKETPLACE
}

/**
 * The suggestion card shows while the list's suggestions hold the official marketplace, no marketplace of that
 * repository is added and the user did not dismiss it. Deciding sends nothing.
 */
export function showsOfficialSuggestion(list: MarketplaceList | null, dismissed: boolean): boolean {
  if (dismissed || !list)
    return false
  if (!list.suggestions.some(suggestion => isOfficialSource(suggestion.source)))
    return false
  return !list.items.some(item => isOfficialSource(item.source))
}

/** The error fields the add dialog reads (a `HarnessError` or its view). */
export interface MarketplaceAddErrorInput {
  code: string
  message: string
  retryAfterMs?: number
  details?: unknown
}

/** What the add dialog shows for a failed add: the server message as is, "Try again in {n} min" after a 429. */
export function addErrorText(error: MarketplaceAddErrorInput): string {
  if (error.code === 'rate_limited' && typeof error.retryAfterMs === 'number' && error.retryAfterMs > 0) {
    const minutes = Math.max(1, Math.ceil(error.retryAfterMs / 60_000))
    const message = error.message.trim()
    const sentence = message === '' || /[.!?]$/.test(message) ? message : `${message}.`
    return `${sentence} Try again in ${minutes} min`.trim()
  }
  return error.message
}

/** `details.reason` of a 409 `conflict` (`exists`, `offline`), else null. */
export function conflictReasonOf(error: MarketplaceAddErrorInput): string | null {
  if (error.code !== 'conflict' || typeof error.details !== 'object' || error.details === null)
    return null
  const reason = (error.details as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : null
}

/** The first string of a route query value (`?q=a&q=b` reads `a`), else ''. */
export function queryText(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw : ''
}

/**
 * Shortens a long line in the middle ("github.com/acme/very-long…tools@3f2a9c1"), so the commit and the end stay
 * readable at 390 px; the full text belongs in a `title`.
 */
export function middleTruncate(text: string, max = 56): string {
  if (text.length <= max || max < 5)
    return text
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** Runs `task` for every item with at most `limit` running at a time; failures are left to the task. */
export async function forEachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T
      try {
        await task(item)
      }
      catch {
        // The task reports its own failure.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
}
