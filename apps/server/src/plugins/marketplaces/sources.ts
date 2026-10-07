// A marketplace entry as an install source (Phase 12, ADR-054; ARCHITECTURE.md 6.34 "Entries"). Owner: W12.2. The
// installer's `{ source: 'marketplace', marketplaceId, plugin }` reads the stored catalog here and gets back what to
// stage, or why it cannot:
//
// | Entry source | Staged from |
// |---|---|
// | relative (`./plugins/x`, a bare name under `metadata.pluginRoot`) | the marketplace's **stored commit** (GitHub: the subtree of that commit's zip) or its folder (`path`); a hosted `marketplace.json` (`url`) has no files: unsupported |
// | `github` (also github.com `url` / `git-subdir`) | that repository: the entry's `sha`, else its `ref` resolved to a commit, else the default branch; `path` = its folder |
// | `archive` | the https archive; its `sha256` is checked when given |
// | `npm` (default registry) | the npm pipeline (`package@version`) |
// | anything else | unsupported (400, the parser's reason) |
//
// The marketplace and the entry must exist (`not_found`); nothing here touches the network. `offlineError` is the one
// `HF_OFFLINE=1` refusal of the installer and the marketplace service.
import type { ClaudeEntrySource, ClaudeMarketplaceEntry } from '@harness-forge/shared'
import type { ClaudeEntryOverlay } from '../types.ts'
import type { StoredMarketplace } from './store.ts'
import { HarnessError } from '@harness-forge/shared'
import { entrySupport } from './catalog.ts'
import { isCommitSha } from './github.ts'

/** What to stage for an entry. */
export type EntryStaging
  = | { readonly kind: 'github', readonly repo: string, readonly ref?: string, readonly sha?: string, readonly path?: string }
    | { readonly kind: 'folder', readonly root: string, readonly path: string }
    | { readonly kind: 'archive', readonly url: string, readonly sha256?: string }
    | { readonly kind: 'npm', readonly spec: string, readonly package: string }

/** An entry ready to stage. */
export interface EntryPlan {
  readonly marketplace: StoredMarketplace
  readonly entry: ClaudeMarketplaceEntry
  readonly staging: EntryStaging
  /** Staging needs the network (everything but a relative entry of a folder marketplace): refused with `HF_OFFLINE=1`. */
  readonly needsNetwork: boolean
  /** The entry overlay a Claude Code plugin is read with (stored in `plugins.origin`). */
  readonly overlay: ClaudeEntryOverlay
}

/** The overlay of an entry (`ClaudeEntryOverlay`): what `mergeEntryOverlay` applies to the plugin's `plugin.json`. */
export function entryOverlay(entry: ClaudeMarketplaceEntry): ClaudeEntryOverlay {
  return {
    name: entry.name,
    strict: entry.strict,
    ...(entry.version === undefined ? {} : { version: entry.version }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    overlay: entry.overlay,
  }
}

/**
 * The message of every `HF_OFFLINE=1` refusal (409 `conflict` `offline`, ADR-054; W12.18-T4): adding or refreshing a
 * GitHub or URL marketplace, installing a marketplace entry that needs the network (its `github`, `archive` or `npm`
 * source, or a relative entry of a GitHub marketplace) and the install dialog's GitHub source. It says what is refused
 * and what still works: the dialog's npm and URL sources, zip uploads and local folders (a folder marketplace too).
 */
export const OFFLINE_MESSAGE = 'Adding, refreshing and installing from marketplaces and GitHub need the network (HF_OFFLINE=1). npm and URL installs from the install dialog, zip uploads and local folders work offline.'

/** `409 conflict` (`offline`) with `OFFLINE_MESSAGE`. */
export function offlineError(): HarnessError {
  return new HarnessError({ code: 'conflict', message: OFFLINE_MESSAGE, details: { reason: 'offline' } })
}

function unsupported(reason: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message: `This plugin cannot be installed: ${reason}`, details: { issues: [{ path: ['plugin'], message: reason, code: 'custom' }] } })
}

function stagingOf(source: ClaudeEntrySource, marketplace: StoredMarketplace): EntryStaging | null {
  switch (source.kind) {
    case 'relative': {
      const path = source.path === '.' ? undefined : source.path
      if (marketplace.source.type === 'github') {
        if (marketplace.resolvedRef === null || !isCommitSha(marketplace.resolvedRef))
          return null
        return { kind: 'github', repo: marketplace.source.repo, sha: marketplace.resolvedRef, ...(path === undefined ? {} : { path }) }
      }
      if (marketplace.source.type === 'path')
        return { kind: 'folder', root: marketplace.source.path, path: source.path }
      return null
    }
    case 'github':
      return {
        kind: 'github',
        repo: source.repo,
        ...(source.ref === undefined ? {} : { ref: source.ref }),
        ...(source.sha === undefined ? {} : { sha: source.sha.toLowerCase() }),
        ...(source.path === undefined ? {} : { path: source.path }),
      }
    case 'archive':
      return { kind: 'archive', url: source.url, ...(source.sha256 === undefined ? {} : { sha256: source.sha256.toLowerCase() }) }
    case 'npm':
      return { kind: 'npm', package: source.package, spec: source.version === undefined ? source.package : `${source.package}@${source.version}` }
    default:
      return null
  }
}

/**
 * The staging plan of the entry `plugin` of `marketplace` (null = the marketplace does not exist): `not_found` for an
 * unknown entry, `validation_error` (400) for an entry this harness cannot install.
 */
export function planEntryInstall(marketplace: StoredMarketplace | null, marketplaceId: string, plugin: string): EntryPlan {
  if (marketplace === null)
    throw new HarnessError({ code: 'not_found', message: `Marketplace ${marketplaceId} not found.` })
  const entry = marketplace.catalog?.marketplace.plugins.find(candidate => candidate.name === plugin)
  if (entry === undefined)
    throw new HarnessError({ code: 'not_found', message: `The marketplace "${marketplace.name}" has no plugin named "${plugin.slice(0, 128)}".` })
  const support = entrySupport(entry, marketplace.source)
  if (!support.supported)
    throw unsupported(support.reason ?? 'its source type is not supported.')
  const staging = stagingOf(entry.source, marketplace)
  if (staging === null)
    throw unsupported('its source cannot be resolved; refresh the marketplace and try again.')
  return { marketplace, entry, staging, needsNetwork: staging.kind !== 'folder', overlay: entryOverlay(entry) }
}
