// Catalog tables (ARCHITECTURE.md 8): `model_cache` (last good live listing per provider, attempt time and error) and
// `model_prefs` (hidden / favorite / alias / custom models / last use).
import type { HarnessErrorInit, ModelInfo } from '@harness-forge/shared'
import type { Db } from '../db/client.ts'
import type { ModelPrefRow } from '../db/schema.ts'
import { and, eq } from 'drizzle-orm'
import { modelCache, modelPrefs } from '../db/schema.ts'

/** A `model_cache` row. */
export interface CachedListing {
  providerId: string
  /** Last good listing (`[]` when there never was one). */
  models: ModelInfo[]
  /** Last successful fetch; null = no listing yet (seeds are used). */
  fetchedAt: number | null
  /** Last attempt (successful or not). */
  attemptedAt: number
  /** Error of the last attempt; null after a success. */
  error: HarnessErrorInit | null
}

/** Columns of `model_prefs` a write may change (`undefined` = keep). */
export interface ModelPrefsPatch {
  hidden?: boolean | null
  favorite?: boolean
  alias?: string | null
  custom?: boolean
  info?: ModelInfo | null
  lastUsedAt?: number | null
}

export interface CatalogStore {
  readonly listings: () => Promise<Map<string, CachedListing>>
  readonly listing: (providerId: string) => Promise<CachedListing | null>
  readonly saveListing: (listing: CachedListing) => Promise<void>
  /** Every prefs row, or the rows of one provider. */
  readonly prefs: (providerId?: string) => Promise<ModelPrefRow[]>
  readonly pref: (providerId: string, modelId: string) => Promise<ModelPrefRow | null>
  readonly upsertPref: (providerId: string, modelId: string, patch: ModelPrefsPatch) => Promise<void>
  readonly deletePref: (providerId: string, modelId: string) => Promise<void>
}

function toListing(row: typeof modelCache.$inferSelect): CachedListing {
  return {
    providerId: row.providerId,
    models: Array.isArray(row.models) ? row.models : [],
    fetchedAt: row.fetchedAt,
    attemptedAt: row.attemptedAt,
    error: row.error ?? null,
  }
}

export function createCatalogStore(db: Db, now: () => number = Date.now): CatalogStore {
  return {
    listings: async () => {
      const rows = await db.select().from(modelCache)
      return new Map(rows.map(row => [row.providerId, toListing(row)]))
    },
    listing: async (providerId) => {
      const rows = await db.select().from(modelCache).where(eq(modelCache.providerId, providerId)).limit(1)
      return rows[0] ? toListing(rows[0]) : null
    },
    saveListing: async (listing) => {
      const values = {
        models: listing.models,
        fetchedAt: listing.fetchedAt,
        attemptedAt: listing.attemptedAt,
        error: listing.error,
      }
      await db
        .insert(modelCache)
        .values({ providerId: listing.providerId, ...values })
        .onConflictDoUpdate({ target: modelCache.providerId, set: values })
    },
    prefs: async (providerId) => {
      if (providerId === undefined)
        return db.select().from(modelPrefs)
      return db.select().from(modelPrefs).where(eq(modelPrefs.providerId, providerId))
    },
    pref: async (providerId, modelId) => {
      const rows = await db
        .select()
        .from(modelPrefs)
        .where(and(eq(modelPrefs.providerId, providerId), eq(modelPrefs.modelId, modelId)))
        .limit(1)
      return rows[0] ?? null
    },
    upsertPref: async (providerId, modelId, patch) => {
      const set: Partial<typeof modelPrefs.$inferInsert> = { updatedAt: now() }
      if (patch.hidden !== undefined)
        set.hidden = patch.hidden
      if (patch.favorite !== undefined)
        set.favorite = patch.favorite
      if (patch.alias !== undefined)
        set.alias = patch.alias
      if (patch.custom !== undefined)
        set.custom = patch.custom
      if (patch.info !== undefined)
        set.info = patch.info
      if (patch.lastUsedAt !== undefined)
        set.lastUsedAt = patch.lastUsedAt
      await db
        .insert(modelPrefs)
        .values({ providerId, modelId, ...set })
        .onConflictDoUpdate({ target: [modelPrefs.providerId, modelPrefs.modelId], set })
    },
    deletePref: async (providerId, modelId) => {
      await db.delete(modelPrefs).where(and(eq(modelPrefs.providerId, providerId), eq(modelPrefs.modelId, modelId)))
    },
  }
}
