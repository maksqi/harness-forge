import type { Database } from '../db/client.ts'
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client.ts'
import { migrateDatabase } from '../db/migrate.ts'
import { modelCache, providerConfigs, secrets } from '../db/schema.ts'
import {
  createPluginRecordStore,
  createPluginStorage,
  deleteProviderRows,
  deleteSettingsValues,
  deleteStorage,
  isAllowedTransition,
  readSettingsValues,
  STORAGE_TOTAL_MAX_BYTES,
  storedProviderIds,
  writeSettingsValues,
} from './state.ts'

const databases: Database[] = []

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

async function db(): Promise<Database['db']> {
  const database = await openDatabase({ path: ':memory:' })
  databases.push(database)
  await migrateDatabase(database.db)
  return database.db
}

describe('state machine', () => {
  it('allows the documented transitions', () => {
    expect(isAllowedTransition('disabled', 'loading')).toBe(true)
    expect(isAllowedTransition('loading', 'active')).toBe(true)
    expect(isAllowedTransition('loading', 'untrusted')).toBe(true)
    expect(isAllowedTransition('active', 'disabled')).toBe(true)
    expect(isAllowedTransition('error', 'loading')).toBe(true)
    expect(isAllowedTransition('disabled', 'active')).toBe(false)
    expect(isAllowedTransition('untrusted', 'active')).toBe(false)
  })
})

describe('plugin records', () => {
  it('upserts rows, keeping enabled and the trust pin unless given', async () => {
    let now = 1000
    const records = createPluginRecordStore(await db(), () => now)
    const created = await records.upsert({ id: 'acme', source: 'zip', sourceRef: 'acme.zip', version: '1.0.0', trustedHash: 'a'.repeat(64) })
    expect(created).toEqual({
      id: 'acme',
      source: 'zip',
      sourceRef: 'acme.zip',
      version: '1.0.0',
      enabled: true,
      trustedHash: 'a'.repeat(64),
      loadingSince: null,
      lastError: null,
      installedAt: 1000,
      updatedAt: 1000,
    })
    now = 2000
    await records.update('acme', { enabled: false })
    const updated = await records.upsert({ id: 'acme', source: 'zip', version: '1.1.0' })
    expect(updated).toMatchObject({ version: '1.1.0', enabled: false, trustedHash: 'a'.repeat(64), sourceRef: 'acme.zip', installedAt: 1000, updatedAt: 2000 })
    expect((await records.upsert({ id: 'acme', source: 'zip', version: '1.1.0', trustedHash: null })).trustedHash).toBeNull()
    await records.update('acme', { loadingSince: 5, lastError: { code: 'plugin_error', message: 'x' } })
    expect(await records.get('acme')).toMatchObject({ loadingSince: 5, lastError: { code: 'plugin_error', message: 'x' } })
    expect(await records.update('missing', { enabled: true })).toBeNull()
    expect(await records.remove('acme')).toBe(true)
    expect(await records.remove('acme')).toBe(false)
  })

  it('creates builtin rows once and refreshes their version', async () => {
    const records = createPluginRecordStore(await db())
    const first = await records.ensureBuiltin('core-tools', '1.0.0')
    expect(first).toMatchObject({ source: 'builtin', enabled: true, version: '1.0.0' })
    await records.update('core-tools', { enabled: false })
    expect(await records.ensureBuiltin('core-tools', '1.1.0')).toMatchObject({ version: '1.1.0', enabled: false })
    expect((await records.list()).map(record => record.id)).toEqual(['core-tools'])
  })
})

describe('settings values', () => {
  it('round-trips non-secret values', async () => {
    const database = await db()
    expect(await readSettingsValues(database, 'acme')).toEqual({})
    await writeSettingsValues(database, 'acme', { region: 'eu', limit: 3 })
    await writeSettingsValues(database, 'acme', { region: 'us' })
    expect(await readSettingsValues(database, 'acme')).toEqual({ region: 'us' })
    await deleteSettingsValues(database, 'acme')
    expect(await readSettingsValues(database, 'acme')).toEqual({})
  })
})

describe('plugin storage', () => {
  it('stores JSON per plugin with key rules and a total quota', async () => {
    const database = await db()
    const storage = createPluginStorage(database, 'acme')
    const other = createPluginStorage(database, 'other')
    await storage.set('a', { x: [1, 2] })
    await storage.set('a', { x: [3] })
    await other.set('a', 'separate')
    expect(await storage.get('a')).toEqual({ x: [3] })
    expect(await other.get('a')).toBe('separate')
    await expect(storage.set('bad\u0000key', 1)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(storage.set('x'.repeat(257), 1)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(storage.set('fn', () => 1)).rejects.toMatchObject({ code: 'validation_error' })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(storage.set('circular', circular)).rejects.toMatchObject({ code: 'validation_error' })

    const chunk = 'x'.repeat(200_000)
    const count = Math.floor(STORAGE_TOTAL_MAX_BYTES / (chunk.length + 2))
    for (let i = 0; i < count; i++)
      await storage.set(`chunk-${i}`, chunk)
    await expect(storage.set('one-more', chunk)).rejects.toMatchObject({ code: 'payload_too_large', details: { limitBytes: STORAGE_TOTAL_MAX_BYTES } })
    // Replacing an existing key does not count its old value twice.
    await expect(storage.set('chunk-0', chunk)).resolves.toBeUndefined()
    await deleteStorage(database, 'acme')
    expect(await storage.list()).toEqual([])
    expect(await other.list()).toEqual(['a'])
  })
})

describe('provider rows', () => {
  it('lists stored provider ids and deletes their rows', async () => {
    const database = await db()
    await database.insert(providerConfigs).values({ providerId: 'acme' })
    await database.insert(modelCache).values({ providerId: 'acme-eu', attemptedAt: 1 })
    await database.insert(secrets).values({ scope: 'provider:acme-us', name: 'apiKey', ciphertext: Buffer.from('x') })
    await database.insert(secrets).values({ scope: 'plugin:acme', name: 'kv.x', ciphertext: Buffer.from('x') })
    expect(await storedProviderIds(database)).toEqual(['acme', 'acme-eu', 'acme-us'])
    await deleteProviderRows(database, ['acme', 'acme-eu'])
    expect(await storedProviderIds(database)).toEqual(['acme-us'])
    await deleteProviderRows(database, [])
  })
})
