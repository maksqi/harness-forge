// A marketplace's catalog (Phase 12, ADR-054; API.md 4.33). Owner: W12.2.
//
// - `readCatalog(bytes)`: the fetched `.claude-plugin/marketplace.json` parsed by `parseMarketplaceJson`
//   (`util/claude-plugins.ts`, the only parser; byte cap before `JSON.parse`, entries classified, unknown keys dropped)
//   into the stored catalog; an unusable file is `validation_error` with the parser's first error (never its contents).
// - `entryDto` / `diagnosticDto`: the stored catalog as the DTOs of `GET /marketplaces/:id` (the entry overlays stay on
//   the server). An entry is installable when the parser supports its source and, for a relative path, the marketplace
//   has files to take it from (a GitHub commit or a folder; a hosted `marketplace.json` has none).
import type { ClaudeDiagnostic, ClaudeEntrySource, ClaudeMarketplaceEntry, ClaudePluginDiagnostic, MarketplaceEntry, MarketplaceSource } from '@harness-forge/shared'
import type { StoredMarketplaceCatalog } from './types.ts'
import { HarnessError, LIMITS, parseMarketplaceJson } from '@harness-forge/shared'
import { shortSha } from './github.ts'

/** The marketplace file inside a repository or folder. */
export const MARKETPLACE_JSON_PATH = '.claude-plugin/marketplace.json'

/** The reason of a relative entry in a marketplace added from a URL (only the JSON is fetched). */
export const RELATIVE_FROM_URL_REASON = 'Relative plugin folders cannot be resolved for a marketplace added from a URL; add it from GitHub or a folder.'

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses fetched `marketplace.json` bytes into the stored catalog. Throws `payload_too_large` above
 * `LIMITS.marketplaceJsonBytes` and `validation_error` for a file that is not a usable marketplace.
 */
export function readCatalog(bytes: Uint8Array): StoredMarketplaceCatalog {
  if (bytes.byteLength > LIMITS.marketplaceJsonBytes)
    throw new HarnessError({ code: 'payload_too_large', message: 'The marketplace.json is larger than 1 MiB.', details: { limitBytes: LIMITS.marketplaceJsonBytes } })
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    throw invalidCatalog('The marketplace.json is not UTF-8 text.')
  }
  const { marketplace, diagnostics } = parseMarketplaceJson(text, { maxBytes: LIMITS.marketplaceJsonBytes })
  if (marketplace === null) {
    const first = diagnostics.find(diagnostic => diagnostic.level === 'error') ?? diagnostics[0]
    throw invalidCatalog(`The marketplace.json cannot be used: ${first?.message ?? 'it is not a marketplace.'}`)
  }
  const catalog: StoredMarketplaceCatalog = { version: 1, marketplace, diagnostics: diagnostics.slice(0, LIMITS.claudePluginDiagnosticsMax) }
  if (new TextEncoder().encode(JSON.stringify(catalog)).byteLength > LIMITS.marketplaceJsonBytes)
    throw new HarnessError({ code: 'payload_too_large', message: 'The marketplace catalog is larger than 1 MiB.', details: { limitBytes: LIMITS.marketplaceJsonBytes } })
  return catalog
}

function invalidCatalog(message: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['source'], message, code: 'custom' }] } })
}

/** The diagnostics of a stored catalog as DTOs (the JSON field becomes the component; the file is the path). */
export function diagnosticDtos(diagnostics: readonly ClaudePluginDiagnostic[]): ClaudeDiagnostic[] {
  return diagnostics.slice(0, LIMITS.claudePluginDiagnosticsMax).map(diagnostic => ({
    level: diagnostic.level,
    code: clip(diagnostic.code, 64),
    message: clip(diagnostic.message, 1000),
    ...(diagnostic.field === undefined ? {} : { component: clip(diagnostic.field, 256) }),
    path: MARKETPLACE_JSON_PATH,
  }))
}

/** One display line of an entry source (`owner/repo@ref/path`, a URL, `./path`, `package@version`). */
export function sourceText(source: ClaudeEntrySource): string {
  switch (source.kind) {
    case 'relative':
      return clip(source.path === '.' ? './' : `./${source.path}`, 512)
    case 'github': {
      const at = source.sha !== undefined ? `@${shortSha(source.sha)}` : source.ref !== undefined ? `@${source.ref}` : ''
      return clip(`${source.repo}${at}${source.path === undefined ? '' : `/${source.path}`}`, 512)
    }
    case 'git':
    case 'url':
      return clip(`${source.url}${source.ref === undefined ? '' : `#${source.ref}`}`, 512)
    case 'git-subdir':
      return clip(`${source.url}${source.ref === undefined ? '' : `#${source.ref}`} (${source.path})`, 512)
    case 'archive':
      return clip(source.url, 512)
    case 'npm':
      return clip(`${source.package}${source.version === undefined ? '' : `@${source.version}`}`, 512)
    case 'command':
      return 'command'
    default:
      return 'unknown'
  }
}

/** Whether the entry can be installed from this marketplace, and why not. */
export function entrySupport(entry: ClaudeMarketplaceEntry, source: MarketplaceSource): { supported: boolean, reason?: string } {
  if (!entry.supported)
    return { supported: false, reason: entry.unsupportedReason ?? 'The source type is not supported.' }
  if (entry.source.kind === 'relative' && source.type === 'url')
    return { supported: false, reason: RELATIVE_FROM_URL_REASON }
  return { supported: true }
}

/** The `author` of an entry overlay (`{ name }` or a text), when any. */
function authorOf(entry: ClaudeMarketplaceEntry): string | null {
  const author = isRecord(entry.overlay) ? entry.overlay.author : undefined
  if (typeof author === 'string' && author.trim() !== '')
    return clip(author.trim(), 200)
  if (isRecord(author) && typeof author.name === 'string' && author.name.trim() !== '')
    return clip(author.name.trim(), 200)
  return null
}

/** The install state of an entry (`updates.ts`). */
export interface EntryInstallState {
  readonly installedPluginId: string | null
  readonly updateAvailable: boolean
}

/** A stored entry as the DTO of `GET /marketplaces/:id`. */
export function entryDto(entry: ClaudeMarketplaceEntry, source: MarketplaceSource, state: EntryInstallState): MarketplaceEntry {
  const support = entrySupport(entry, source)
  const tags = entry.tags.filter(tag => typeof tag === 'string' && tag.trim() !== '').map(tag => clip(tag, 64)).slice(0, 20)
  return {
    name: clip(entry.name, 128),
    description: entry.description === undefined ? null : clip(entry.description, 1000),
    version: entry.version === undefined ? null : clip(entry.version, 128),
    category: entry.category === undefined ? null : clip(entry.category, 64),
    tags,
    author: authorOf(entry),
    source: { kind: entry.source.kind, text: sourceText(entry.source) },
    supported: support.supported,
    ...(support.reason === undefined ? {} : { unsupportedReason: clip(support.reason, 300) }),
    installedPluginId: state.installedPluginId,
    updateAvailable: state.updateAvailable,
  }
}
