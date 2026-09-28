import type { CreateDepsOptions } from './deps.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessError } from '@harness-forge/shared'
import { getConnInfo } from '@hono/node-server/conninfo'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './db/client.ts'
import { createDeps, SERVICE_FACTORIES, SERVICE_NAMES, startDeps, stopDeps } from './deps.ts'
import { loadEnv } from './env.ts'
import { createMemoryLogger } from './logger.ts'
import { createRedactor } from './security/redact.ts'
import { createTestApp } from './testing/create-test-app.ts'
import { createFakeKeyring, createMemorySettingsService, createRecordingEventBus } from './testing/fakes.ts'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-deps-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function baseOptions(): Promise<CreateDepsOptions> {
  const database = await openDatabase({ path: ':memory:' })
  cleanups.push(() => database.close())
  return {
    env: loadEnv({ HF_DATA_DIR: tempDir() }),
    logger: createMemoryLogger().logger,
    redactor: createRedactor(),
    db: database.db,
    builtins: [],
    overrides: { keyring: createFakeKeyring() },
  }
}

describe('createDeps', () => {
  it('creates every service of AppServices', async () => {
    const deps = createDeps(await baseOptions())
    expect([...SERVICE_NAMES].sort()).toEqual(Object.keys(SERVICE_FACTORIES).sort())
    for (const name of SERVICE_NAMES)
      expect(deps[name], name).toBeDefined()
    expect(Object.isFrozen(deps)).toBe(true)
  })

  it('uses overrides instead of factories', async () => {
    const events = createRecordingEventBus()
    const deps = createDeps({ ...(await baseOptions()), overrides: { events } })
    expect(deps.events).toBe(events)
  })

  it('lets a factory read services declared after it while it runs', async () => {
    const settings = createMemorySettingsService()
    let seenByEvents: unknown
    const deps = createDeps({
      ...(await baseOptions()),
      factories: {
        // `events` is created before `settings` in SERVICE_NAMES order.
        events: (d) => {
          seenByEvents = d.settings
          return createRecordingEventBus()
        },
        settings: () => settings,
      },
    })
    expect(seenByEvents).toBe(settings)
    expect(deps.settings).toBe(settings)
  })

  it('reports construction cycles', async () => {
    const options = await baseOptions()
    expect(() => createDeps({
      ...options,
      factories: {
        events: (d) => {
          void d.settings
          return createRecordingEventBus()
        },
        settings: (d) => {
          void d.events
          return createMemorySettingsService()
        },
      },
    })).toThrow(/Circular dependency/)
  })

  it('fails when a factory throws', async () => {
    const options = await baseOptions()
    expect(() => createDeps({
      ...options,
      factories: {
        registry: () => {
          throw new Error('invalid master key')
        },
      },
    })).toThrow('invalid master key')
  })
})

describe('phase 0 stubs', () => {
  it('operations fail with not_implemented; lifecycle, subscriptions and events are no-ops', async () => {
    const t = await createTestApp()
    cleanups.push(() => t.close())
    await expect(t.deps.settings.get()).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(t.deps.chats.list({})).rejects.toBeInstanceOf(HarnessError)
    expect(() => t.deps.registry.providers.list()).toThrow(HarnessError)
    expect(t.deps.runs.isActive('0199a8f0-0000-7000-8000-000000000001')).toBe(false)
    expect(t.deps.runs.active()).toEqual([])
    await expect(t.deps.runs.stop('0199a8f0-0000-7000-8000-000000000001')).resolves.toBe(false)
    expect((await t.deps.tools.prefs()).size).toBe(0)
    t.deps.registry.onChange(() => {}).dispose()
    t.deps.events.emit('catalog.changed', { providerId: null })
    await expect(startDeps(t.deps)).resolves.toBeUndefined()
    await expect(stopDeps(t.deps)).resolves.toBeUndefined()
  })
})

describe('testing helpers', () => {
  it('the fake keyring derives stable, distinct 32-byte subkeys', () => {
    const keyring = createFakeKeyring()
    const session = keyring.subkey('session')
    expect(session).toHaveLength(32)
    expect(keyring.subkey('session')).toEqual(session)
    expect(keyring.subkey('encryption')).not.toEqual(session)
  })

  it('the recording event bus delivers, records and closes subscribers', async () => {
    const bus = createRecordingEventBus()
    const seen: string[] = []
    let closed = false
    const subscription = bus.subscribe(event => seen.push(event.type), { onClose: () => (closed = true) })
    bus.emit('catalog.changed', { providerId: 'openai' })
    expect(seen).toEqual(['catalog.changed'])
    expect(bus.ofType('catalog.changed')[0]?.data.providerId).toBe('openai')
    subscription.dispose()
    expect(bus.subscriberCount()).toBe(0)
    bus.subscribe(() => {}, { onClose: () => (closed = true) })
    await bus.stop()
    expect(closed).toBe(true)
  })

  it('createTestApp shares a database file between two instances', async () => {
    const dataDir = tempDir()
    const databasePath = join(dataDir, 'shared.db')
    const first = await createTestApp({ dataDir, databasePath })
    await first.database.client.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('_probe', '1', 1)`)
    await first.close()
    const second = await createTestApp({ dataDir, databasePath })
    cleanups.push(() => second.close())
    const result = await second.database.client.execute(`SELECT value FROM settings WHERE key = '_probe'`)
    expect(result.rows).toHaveLength(1)
  })

  it('createTestApp requests carry node-server bindings (getConnInfo works)', async () => {
    const t = await createTestApp({ start: false })
    cleanups.push(() => t.close())
    t.app.get('/conn', c => c.json(getConnInfo(c).remote))
    expect(await (await t.request('/conn')).json()).toMatchObject({ address: '127.0.0.1', addressType: 'IPv4' })
    const remote = await (await t.request('/conn', undefined, { remoteAddress: '::1' })).json()
    expect(remote).toMatchObject({ address: '::1', addressType: 'IPv6' })
  })

  it('createTestApp exposes a typed client and parses test env vars', async () => {
    const t = await createTestApp({ env: { HF_SAFE_MODE: '1' } })
    cleanups.push(() => t.close())
    expect(await t.client.health.get()).toMatchObject({ ok: true, safeMode: true })
    await expect(t.client.settings.get()).rejects.toMatchObject({ code: 'not_implemented' })
  })
})
