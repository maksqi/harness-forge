// Installed plugins of a marketplace and their updates (Phase 12, ADR-054; ARCHITECTURE.md 6.34 "Updates"). Owner:
// W12.2. Computed from the stored catalogs and the `plugins` rows only (no network; nothing is refreshed on its own).
//
// An installed plugin belongs to an entry when its `plugins.origin` is `{ kind: 'marketplace' }` with the entry name and
// the marketplace's id, or its name (an origin dangles after the marketplace was removed; a marketplace added again
// under the same name finds its plugins). "Update available": the entry's `version` differs from `origin.version` (the
// entry version at install time); without an entry version, the commit differs: the marketplace's stored commit for a
// relative entry, the entry's pinned `sha` for a GitHub entry, the pinned `sha256` for an archive entry, an exact npm
// version for an npm entry. Anything else (a GitHub ref without a sha, a folder marketplace) reports no update.
import type { ClaudeMarketplaceEntry, PluginUpdate } from '@harness-forge/shared'
import type { PluginRecord, StoredPluginOrigin } from '../types.ts'
import type { StoredMarketplace } from './store.ts'
import semver from 'semver'

/** A marketplace origin of a `plugins` row. */
export type MarketplaceOrigin = Extract<StoredPluginOrigin, { kind: 'marketplace' }>

/** A plugin installed from a marketplace entry. */
export interface InstalledEntry {
  readonly pluginId: string
  /** The installed version as the record holds it. */
  readonly version: string
  readonly origin: MarketplaceOrigin
}

/** The plugins of `records` installed from `marketplace`, by entry name (the first by id when two claim one entry). */
export function installedEntries(records: readonly PluginRecord[], marketplace: Pick<StoredMarketplace, 'id' | 'name'>): Map<string, InstalledEntry> {
  const byEntry = new Map<string, InstalledEntry>()
  const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const record of sorted) {
    const origin = record.origin
    if (origin === null || origin.kind !== 'marketplace')
      continue
    if (origin.marketplaceId !== marketplace.id && origin.marketplace !== marketplace.name)
      continue
    if (!byEntry.has(origin.plugin))
      byEntry.set(origin.plugin, { pluginId: record.id, version: record.version, origin })
  }
  return byEntry
}

/** True when the entry now offers another version than the installed one (see the module comment). */
export function hasUpdate(entry: ClaudeMarketplaceEntry, installed: InstalledEntry, marketplace: Pick<StoredMarketplace, 'resolvedRef' | 'source'>): boolean {
  const origin = installed.origin
  if (entry.version !== undefined)
    return entry.version !== origin.version
  const source = entry.source
  switch (source.kind) {
    case 'relative':
      return marketplace.source.type === 'github' && marketplace.resolvedRef !== null && origin.commit !== undefined && marketplace.resolvedRef !== origin.commit
    case 'github':
      return source.sha !== undefined && origin.commit !== undefined && source.sha.toLowerCase() !== origin.commit
    case 'archive':
      return source.sha256 !== undefined && origin.archiveSha256 !== undefined && source.sha256.toLowerCase() !== origin.archiveSha256
    case 'npm': {
      const exact = source.version === undefined ? null : semver.valid(source.version)
      return exact !== null && origin.npmVersion !== undefined && exact !== origin.npmVersion
    }
    default:
      return false
  }
}

/** The plugin updates of one marketplace (entries with an installed plugin and an update). */
export function updatesOf(marketplace: StoredMarketplace, records: readonly PluginRecord[]): PluginUpdate[] {
  const entries = marketplace.catalog?.marketplace.plugins ?? []
  const installed = installedEntries(records, marketplace)
  const updates: PluginUpdate[] = []
  for (const entry of entries) {
    const plugin = installed.get(entry.name)
    if (plugin === undefined || !hasUpdate(entry, plugin, marketplace))
      continue
    updates.push({
      pluginId: plugin.pluginId,
      marketplaceId: marketplace.id,
      plugin: entry.name.slice(0, 128),
      version: (plugin.origin.version ?? plugin.version).slice(0, 128),
      availableVersion: entry.version === undefined ? null : entry.version.slice(0, 128),
    })
  }
  return updates
}
