// `provider_configs` rows (ARCHITECTURE.md 8): enabled flag, last check status, last error and validation time. A
// missing row means the defaults (enabled, no options). The non-secret credential values in `options` belong to the
// credential service (W1.2); these helpers never write them, so an upsert here keeps whatever W1.2 stored.
import type { HarnessErrorInit, ProviderStatus } from '@harness-forge/shared'
import type { Db } from '../db/client.ts'
import type { ProviderConfigRow } from '../db/schema.ts'
import { eq } from 'drizzle-orm'
import { providerConfigs } from '../db/schema.ts'

/** Fields written by the provider service and the catalog. */
export interface ProviderConfigPatch {
  enabled?: boolean
  status?: ProviderStatus | null
  lastError?: HarnessErrorInit | null
  validatedAt?: number | null
}

export interface ProviderConfigStore {
  /** Every row by provider id. */
  readonly all: () => Promise<Map<string, ProviderConfigRow>>
  readonly get: (providerId: string) => Promise<ProviderConfigRow | null>
  /** Inserts the row with defaults when missing, else updates only the patched columns. */
  readonly update: (providerId: string, patch: ProviderConfigPatch) => Promise<void>
}

export function createProviderConfigStore(db: Db, now: () => number = Date.now): ProviderConfigStore {
  return {
    all: async () => {
      const rows = await db.select().from(providerConfigs)
      return new Map(rows.map(row => [row.providerId, row]))
    },
    get: async (providerId) => {
      const rows = await db.select().from(providerConfigs).where(eq(providerConfigs.providerId, providerId)).limit(1)
      return rows[0] ?? null
    },
    update: async (providerId, patch) => {
      const set: Partial<typeof providerConfigs.$inferInsert> = { updatedAt: now() }
      if (patch.enabled !== undefined)
        set.enabled = patch.enabled
      if (patch.status !== undefined)
        set.status = patch.status
      if (patch.lastError !== undefined)
        set.lastError = patch.lastError
      if (patch.validatedAt !== undefined)
        set.validatedAt = patch.validatedAt
      await db
        .insert(providerConfigs)
        .values({ providerId, ...set })
        .onConflictDoUpdate({ target: providerConfigs.providerId, set })
    },
  }
}

/** `provider_configs.enabled`, default true. */
export function isEnabledRow(row: ProviderConfigRow | null | undefined): boolean {
  return row?.enabled ?? true
}
