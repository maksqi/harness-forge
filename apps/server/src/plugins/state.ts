// Plugin state and persistence (PLUGINS.md 11, ARCHITECTURE.md 6.4 / 8). Owner: W1.3 (W1.3-T2).
//
// The lifecycle state (`disabled | untrusted | incompatible | loading | active | error`) is computed by the host; what is
// persisted are its inputs in the `plugins` row: `enabled` (user intent), `trusted_hash` (trust pin), `loading_since`
// (boot sentinel) and `last_error`. This module owns the `plugins`, `plugin_settings` and `plugin_kv` tables plus the
// purge of a removed plugin's provider configuration.
import type { PluginState } from '@harness-forge/shared'
import type { Db } from '../db/client.ts'
import type { PluginRecord, PluginRecordInput } from './types.ts'
import { Buffer } from 'node:buffer'
import { HarnessError } from '@harness-forge/shared'
import { and, eq, inArray, like, ne, sql } from 'drizzle-orm'
import { modelCache, pluginKv, plugins, pluginSettings, providerConfigs, secrets } from '../db/schema.ts'

// ---------- state machine (ARCHITECTURE.md 6.4) ----------

/** Allowed transitions; `loading` is entered from every state by enable / reload / trust / hot reload. */
export const PLUGIN_STATE_TRANSITIONS: Readonly<Record<PluginState, readonly PluginState[]>> = {
  disabled: ['loading', 'disabled'],
  untrusted: ['loading', 'disabled', 'untrusted'],
  incompatible: ['loading', 'disabled', 'incompatible'],
  loading: ['active', 'error', 'untrusted', 'incompatible', 'disabled', 'loading'],
  active: ['loading', 'disabled', 'active'],
  error: ['loading', 'disabled', 'error'],
}

export function isAllowedTransition(from: PluginState, to: PluginState): boolean {
  return PLUGIN_STATE_TRANSITIONS[from].includes(to)
}

// ---------- plugins rows ----------

function toRecord(row: typeof plugins.$inferSelect): PluginRecord {
  return {
    id: row.id,
    source: row.source,
    sourceRef: row.sourceRef ?? null,
    version: row.version,
    enabled: row.enabled,
    trustedHash: row.trustedHash ?? null,
    loadingSince: row.loadingSince ?? null,
    lastError: row.lastError ?? null,
    installedAt: row.installedAt,
    updatedAt: row.updatedAt,
  }
}

/** Mutable columns of a row (everything but the id and `installed_at`). */
export type PluginRecordPatch = Partial<Omit<PluginRecord, 'id' | 'installedAt' | 'updatedAt'>>

export interface PluginRecordStore {
  readonly get: (id: string) => Promise<PluginRecord | null>
  readonly list: () => Promise<PluginRecord[]>
  /** Inserts a builtin row, or refreshes its version (source stays `builtin`, `enabled` is kept). */
  readonly ensureBuiltin: (id: string, version: string) => Promise<PluginRecord>
  /** `PluginHost.saveRecord`: upsert; `enabled` / `trustedHash` undefined keep the stored value (default true / null). */
  readonly upsert: (input: PluginRecordInput) => Promise<PluginRecord>
  /** Updates columns of an existing row; null when there is no row. */
  readonly update: (id: string, patch: PluginRecordPatch) => Promise<PluginRecord | null>
  readonly remove: (id: string) => Promise<boolean>
}

export function createPluginRecordStore(db: Db, now: () => number = Date.now): PluginRecordStore {
  async function get(id: string): Promise<PluginRecord | null> {
    const [row] = await db.select().from(plugins).where(eq(plugins.id, id))
    return row ? toRecord(row) : null
  }

  async function update(id: string, patch: PluginRecordPatch): Promise<PluginRecord | null> {
    const [row] = await db.update(plugins).set({ ...patch, updatedAt: now() }).where(eq(plugins.id, id)).returning()
    return row ? toRecord(row) : null
  }

  return {
    get,
    list: async () => (await db.select().from(plugins).orderBy(plugins.id)).map(toRecord),
    ensureBuiltin: async (id, version) => {
      const existing = await get(id)
      if (existing && existing.source === 'builtin') {
        if (existing.version === version)
          return existing
        return (await update(id, { version })) ?? existing
      }
      const time = now()
      const [row] = await db
        .insert(plugins)
        .values({ id, source: 'builtin', sourceRef: null, version, enabled: true, trustedHash: null, installedAt: time, updatedAt: time })
        .onConflictDoUpdate({ target: plugins.id, set: { source: 'builtin', sourceRef: null, version, trustedHash: null, updatedAt: time } })
        .returning()
      return toRecord(row!)
    },
    upsert: async (input) => {
      const existing = await get(input.id)
      const time = now()
      if (existing) {
        const patch: PluginRecordPatch = { source: input.source, version: input.version }
        if (input.sourceRef !== undefined)
          patch.sourceRef = input.sourceRef
        if (input.enabled !== undefined)
          patch.enabled = input.enabled
        if (input.trustedHash !== undefined)
          patch.trustedHash = input.trustedHash
        const updated = await update(input.id, patch)
        if (updated)
          return updated
      }
      const [row] = await db
        .insert(plugins)
        .values({
          id: input.id,
          source: input.source,
          sourceRef: input.sourceRef ?? null,
          version: input.version,
          enabled: input.enabled ?? true,
          trustedHash: input.trustedHash ?? null,
          installedAt: time,
          updatedAt: time,
        })
        .returning()
      return toRecord(row!)
    },
    update,
    remove: async (id) => {
      const removed = await db.delete(plugins).where(eq(plugins.id, id)).returning({ id: plugins.id })
      return removed.length > 0
    },
  }
}

// ---------- settings values (plugin_settings) ----------

export async function readSettingsValues(db: Db, pluginId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select().from(pluginSettings).where(eq(pluginSettings.pluginId, pluginId))
  const values = row?.values
  return values !== null && typeof values === 'object' && !Array.isArray(values) ? { ...values } : {}
}

export async function writeSettingsValues(db: Db, pluginId: string, values: Record<string, unknown>, now: () => number = Date.now): Promise<void> {
  await db
    .insert(pluginSettings)
    .values({ pluginId, values, updatedAt: now() })
    .onConflictDoUpdate({ target: pluginSettings.pluginId, set: { values, updatedAt: now() } })
}

export async function deleteSettingsValues(db: Db, pluginId: string): Promise<void> {
  await db.delete(pluginSettings).where(eq(pluginSettings.pluginId, pluginId))
}

// ---------- ctx.storage (plugin_kv) ----------

/** Maximum length of a storage key. */
export const STORAGE_KEY_MAX_CHARS = 256
/** Maximum serialized size of one stored value. */
export const STORAGE_VALUE_MAX_BYTES = 262_144
/** Maximum serialized size of all values of one plugin. */
export const STORAGE_TOTAL_MAX_BYTES = 10_485_760

// eslint-disable-next-line no-control-regex -- the rule is exactly "no control characters"
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/

function storageKeyError(key: unknown): HarnessError | null {
  if (typeof key !== 'string' || key.length === 0 || key.length > STORAGE_KEY_MAX_CHARS || CONTROL_CHARS.test(key)) {
    return new HarnessError({
      code: 'validation_error',
      message: `Storage keys are strings of 1-${STORAGE_KEY_MAX_CHARS} characters without control characters.`,
    })
  }
  return null
}

/** `ctx.storage` of one plugin: JSON values in `plugin_kv` with per-value and per-plugin size limits. */
export interface PluginStorage {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: unknown) => Promise<void>
  readonly delete: (key: string) => Promise<void>
  readonly list: (prefix?: string) => Promise<string[]>
}

export function createPluginStorage(db: Db, pluginId: string, now: () => number = Date.now): PluginStorage {
  function checkKey(key: unknown): asserts key is string {
    const error = storageKeyError(key)
    if (error)
      throw error
  }

  return {
    get: async (key) => {
      checkKey(key)
      const [row] = await db.select({ value: pluginKv.value }).from(pluginKv).where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, key)))
      return row === undefined ? undefined : row.value
    },
    set: async (key, value) => {
      checkKey(key)
      if (value === undefined)
        throw new HarnessError({ code: 'validation_error', message: 'Storage values cannot be undefined: use delete(key) instead.' })
      let json: string | undefined
      try {
        json = JSON.stringify(value)
      }
      catch (error) {
        throw new HarnessError({ code: 'validation_error', message: `Storage values must be JSON-serializable (${error instanceof Error ? error.message : String(error)}).` })
      }
      if (json === undefined)
        throw new HarnessError({ code: 'validation_error', message: 'Storage values must be JSON-serializable.' })
      const size = Buffer.byteLength(json, 'utf8')
      if (size > STORAGE_VALUE_MAX_BYTES) {
        throw new HarnessError({
          code: 'payload_too_large',
          message: `A stored value is limited to ${STORAGE_VALUE_MAX_BYTES / 1024} KB.`,
          details: { limitBytes: STORAGE_VALUE_MAX_BYTES },
        })
      }
      const [usage] = await db
        .select({ bytes: sql<number>`coalesce(sum(length(cast(${pluginKv.value} as blob))), 0)` })
        .from(pluginKv)
        .where(and(eq(pluginKv.pluginId, pluginId), ne(pluginKv.key, key)))
      if (Number(usage?.bytes ?? 0) + size > STORAGE_TOTAL_MAX_BYTES) {
        throw new HarnessError({
          code: 'payload_too_large',
          message: `The storage of a plugin is limited to ${STORAGE_TOTAL_MAX_BYTES / 1_048_576} MB.`,
          details: { limitBytes: STORAGE_TOTAL_MAX_BYTES },
        })
      }
      // Store the round-tripped JSON so reads return exactly what JSON can represent.
      const stored: unknown = JSON.parse(json)
      await db
        .insert(pluginKv)
        .values({ pluginId, key, value: stored, updatedAt: now() })
        .onConflictDoUpdate({ target: [pluginKv.pluginId, pluginKv.key], set: { value: stored, updatedAt: now() } })
    },
    delete: async (key) => {
      checkKey(key)
      await db.delete(pluginKv).where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, key)))
    },
    list: async (prefix) => {
      if (prefix !== undefined && typeof prefix !== 'string')
        throw new HarnessError({ code: 'validation_error', message: 'The storage key prefix must be a string.' })
      const rows = await db.select({ key: pluginKv.key }).from(pluginKv).where(eq(pluginKv.pluginId, pluginId))
      return rows.map(row => row.key).filter(key => prefix === undefined || key.startsWith(prefix)).sort()
    },
  }
}

export async function deleteStorage(db: Db, pluginId: string): Promise<void> {
  await db.delete(pluginKv).where(eq(pluginKv.pluginId, pluginId))
}

// ---------- provider data of a removed plugin ----------

/** Every provider id with stored configuration: `provider_configs`, `model_cache` rows and `provider:<id>` secrets. */
export async function storedProviderIds(db: Db): Promise<string[]> {
  const ids = new Set<string>()
  for (const row of await db.select({ id: providerConfigs.providerId }).from(providerConfigs))
    ids.add(row.id)
  for (const row of await db.select({ id: modelCache.providerId }).from(modelCache))
    ids.add(row.id)
  const scopes = await db.selectDistinct({ scope: secrets.scope }).from(secrets).where(like(secrets.scope, 'provider:%'))
  for (const row of scopes)
    ids.add(row.scope.slice('provider:'.length))
  return [...ids].sort()
}

/** Deletes the `provider_configs` and `model_cache` rows of `providerIds` (secrets are deleted through the store). */
export async function deleteProviderRows(db: Db, providerIds: readonly string[]): Promise<void> {
  if (providerIds.length === 0)
    return
  await db.delete(providerConfigs).where(inArray(providerConfigs.providerId, [...providerIds]))
  await db.delete(modelCache).where(inArray(modelCache.providerId, [...providerIds]))
}
