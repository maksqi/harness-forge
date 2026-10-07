// The `marketplaces` table (Phase 12, ADR-054; migration `0009_claude_ecosystem`). Owner: W12.2. Rows hold the source,
// the resolved ref (a commit for GitHub, the sha256 of the fetched JSON for a URL, null for a folder), the normalized
// catalog (`StoredMarketplaceCatalog`, at most `LIMITS.marketplaceJsonBytes`), the last fetch and the last error. Used
// by the marketplace service and, read-only, by the installer's `marketplace` source (`sources.ts`).
import type { ClaudeMarketplace, ClaudePluginDiagnostic, HarnessErrorInit, MarketplaceSource } from '@harness-forge/shared'
import type { Db } from '../../db/client.ts'
import type { StoredMarketplaceCatalog } from './types.ts'
import { createMarketplaceId, HarnessError, marketplaceSourceSchema } from '@harness-forge/shared'
import { asc, eq } from 'drizzle-orm'
import { marketplaces } from '../../db/schema.ts'

/** One stored marketplace. */
export interface StoredMarketplace {
  readonly id: string
  readonly name: string
  readonly source: MarketplaceSource
  readonly resolvedRef: string | null
  /** Null when the stored JSON is unreadable (a row written by a newer server); the marketplace then lists nothing. */
  readonly catalog: StoredMarketplaceCatalog | null
  readonly fetchedAt: number | null
  readonly lastError: HarnessErrorInit | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** What an add or a successful refresh writes. */
export interface MarketplaceFetchResult {
  readonly name: string
  readonly resolvedRef: string | null
  readonly catalog: StoredMarketplaceCatalog
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The stored catalog when its shape is the one this server writes (layout version 1), else null. */
export function catalogOf(value: unknown): StoredMarketplaceCatalog | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.marketplace) || !Array.isArray(value.diagnostics))
    return null
  const marketplace = value.marketplace as unknown as ClaudeMarketplace
  if (typeof marketplace.name !== 'string' || !Array.isArray(marketplace.plugins))
    return null
  return { version: 1, marketplace, diagnostics: value.diagnostics as ClaudePluginDiagnostic[] }
}

function rowOf(row: typeof marketplaces.$inferSelect): StoredMarketplace | null {
  const source = marketplaceSourceSchema.safeParse(row.source)
  if (!source.success)
    return null
  return {
    id: row.id,
    name: row.name,
    source: source.data,
    resolvedRef: row.resolvedRef ?? null,
    catalog: catalogOf(row.catalog),
    fetchedAt: row.fetchedAt ?? null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function isUniqueViolation(error: unknown): boolean {
  const text = `${(error as { message?: unknown })?.message ?? ''} ${String((error as { cause?: { message?: unknown } })?.cause?.message ?? '')}`
  return /UNIQUE constraint failed/i.test(text)
}

export interface MarketplaceStore {
  /** Every row, oldest first (rows whose source no longer parses are left out). */
  readonly list: () => Promise<StoredMarketplace[]>
  readonly get: (id: string) => Promise<StoredMarketplace | null>
  readonly count: () => Promise<number>
  /** Inserts a fetched marketplace; `conflict` (`exists`) when the name is taken. */
  readonly insert: (source: MarketplaceSource, fetched: MarketplaceFetchResult) => Promise<StoredMarketplace>
  /** Stores a successful refresh (clears `lastError`); null when the row is gone. */
  readonly saveFetch: (id: string, fetched: MarketplaceFetchResult) => Promise<StoredMarketplace | null>
  /** Stores a failed refresh (the catalog is kept); null when the row is gone. */
  readonly saveError: (id: string, error: HarnessErrorInit) => Promise<StoredMarketplace | null>
  readonly remove: (id: string) => Promise<boolean>
}

export function createMarketplaceStore(db: Db, now: () => number = Date.now): MarketplaceStore {
  async function get(id: string): Promise<StoredMarketplace | null> {
    const [row] = await db.select().from(marketplaces).where(eq(marketplaces.id, id))
    return row === undefined ? null : rowOf(row)
  }

  return {
    list: async () => {
      const rows = await db.select().from(marketplaces).orderBy(asc(marketplaces.createdAt), asc(marketplaces.id))
      return rows.map(rowOf).filter((row): row is StoredMarketplace => row !== null)
    },
    get,
    count: async () => (await db.select({ id: marketplaces.id }).from(marketplaces)).length,
    insert: async (source, fetched) => {
      const time = now()
      try {
        const [row] = await db.insert(marketplaces).values({
          id: createMarketplaceId(),
          name: fetched.name,
          source,
          resolvedRef: fetched.resolvedRef,
          catalog: fetched.catalog as unknown as Record<string, unknown>,
          fetchedAt: time,
          lastError: null,
          createdAt: time,
          updatedAt: time,
        }).returning()
        const stored = row === undefined ? null : rowOf(row)
        if (stored === null)
          throw new HarnessError({ code: 'internal_error', message: 'The marketplace could not be stored.' })
        return stored
      }
      catch (error) {
        if (isUniqueViolation(error))
          throw new HarnessError({ code: 'conflict', message: `A marketplace named "${fetched.name}" is already added.`, details: { reason: 'exists' } })
        throw error
      }
    },
    saveFetch: async (id, fetched) => {
      const time = now()
      const [row] = await db.update(marketplaces).set({
        resolvedRef: fetched.resolvedRef,
        catalog: fetched.catalog as unknown as Record<string, unknown>,
        fetchedAt: time,
        lastError: null,
        updatedAt: time,
      }).where(eq(marketplaces.id, id)).returning()
      return row === undefined ? null : rowOf(row)
    },
    saveError: async (id, error) => {
      const [row] = await db.update(marketplaces).set({ lastError: error, updatedAt: now() }).where(eq(marketplaces.id, id)).returning()
      return row === undefined ? null : rowOf(row)
    },
    remove: async (id) => {
      const removed = await db.delete(marketplaces).where(eq(marketplaces.id, id)).returning({ id: marketplaces.id })
      return removed.length > 0
    },
  }
}
