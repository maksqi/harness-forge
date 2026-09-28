import type { TestApp } from '../../testing/create-test-app.ts'
import type { SettingsChange } from './index.ts'
import { DEFAULT_SETTINGS, SETTINGS_KEYS } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings as settingsTable } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createMemorySettingsService } from '../../testing/fakes.ts'
import { createSettingsService, onSettingsChange } from './index.ts'
import { SESSION_EPOCH_KEY } from './types.ts'

let t: TestApp

beforeEach(async () => {
  t = await createTestApp({ builtins: [], start: false })
})

afterEach(async () => {
  await t.close()
})

/** A second service over the same database (cold cache): what a restart would read. */
function reopened() {
  return createSettingsService(t.deps)
}

describe('settings.get / update', () => {
  it('returns every key with its default when nothing is stored', async () => {
    const current = await t.deps.settings.get()
    expect(current).toEqual(DEFAULT_SETTINGS)
    expect(Object.keys(current).sort()).toEqual([...SETTINGS_KEYS].sort())
    expect(current.maxSteps).toBe(20)
    expect(current.defaultToolMode).toBe('ask')
  })

  it('applies a partial update, returns the full settings and persists it', async () => {
    const updated = await t.deps.settings.update({ maxSteps: 42, density: 'compact', displayName: '  Ada  ' })
    expect(updated).toEqual({ ...DEFAULT_SETTINGS, maxSteps: 42, density: 'compact', displayName: 'Ada' })
    expect(await t.deps.settings.get()).toEqual(updated)
    expect(await reopened().get()).toEqual(updated)
    const rows = await t.db.select().from(settingsTable)
    expect(rows.map(row => row.key).sort()).toEqual(['density', 'displayName', 'maxSteps'])
  })

  it('stores null model refs and restores them', async () => {
    await t.deps.settings.update({ defaultModelRef: 'ollama:llama3:8b', titleModelRef: 'openrouter:anthropic/claude-sonnet-5' })
    expect(await reopened().get()).toMatchObject({ defaultModelRef: 'ollama:llama3:8b', titleModelRef: 'openrouter:anthropic/claude-sonnet-5' })
    await t.deps.settings.update({ defaultModelRef: null })
    expect((await reopened().get()).defaultModelRef).toBeNull()
  })

  it.each([
    ['an unknown key', { theme: 'dark' }],
    ['an empty update', {}],
    ['maxSteps below 1', { maxSteps: 0 }],
    ['a fractional maxSteps', { maxSteps: 2.5 }],
    ['an invalid enum value', { sendKey: 'shift-enter' }],
    ['a model ref without a provider', { defaultModelRef: 'gpt-6' }],
    ['a displayName over 64 characters', { displayName: 'x'.repeat(65) }],
    ['a wrong type', { altShortcuts: 'yes' }],
  ])('rejects %s with validation_error', async (_label, patch) => {
    await expect(t.deps.settings.update(patch as never)).rejects.toMatchObject({ code: 'validation_error' })
    expect(await t.deps.settings.get()).toEqual(DEFAULT_SETTINGS)
    expect(await t.db.select().from(settingsTable)).toEqual([])
  })

  it('falls back to the default for a stored value that no longer validates', async () => {
    await t.db.insert(settingsTable).values([{ key: 'maxSteps', value: 'many' }, { key: 'density', value: 'compact' }])
    const service = reopened()
    expect(await service.get()).toEqual({ ...DEFAULT_SETTINGS, density: 'compact' })
    await service.get()
    const warnings = t.logs.records.filter(record => record.msg.includes('stored setting is invalid'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.setting).toBe('maxSteps')
  })

  it('treats keys set to undefined as not sent', async () => {
    await t.deps.settings.update({ maxSteps: 9 })
    expect(await t.deps.settings.update({ maxSteps: undefined })).toMatchObject({ maxSteps: 9 })
    expect(await t.deps.settings.update({ maxSteps: undefined, density: 'compact' })).toMatchObject({ maxSteps: 9, density: 'compact' })
  })

  it('returns copies (callers cannot change the cache)', async () => {
    const current = await t.deps.settings.get()
    current.maxSteps = 99
    expect((await t.deps.settings.get()).maxSteps).toBe(20)
  })

  it('applies concurrent updates in order', async () => {
    await Promise.all([
      t.deps.settings.update({ maxSteps: 5 }),
      t.deps.settings.update({ density: 'compact' }),
      t.deps.settings.update({ maxSteps: 7 }),
    ])
    expect(await t.deps.settings.get()).toMatchObject({ maxSteps: 7, density: 'compact' })
    expect(await reopened().get()).toMatchObject({ maxSteps: 7, density: 'compact' })
  })
})

describe('internal settings', () => {
  it('stores JSON values under "_" keys, never exposed by get()', async () => {
    expect(await t.deps.settings.getInternal(SESSION_EPOCH_KEY)).toBeUndefined()
    await t.deps.settings.setInternal(SESSION_EPOCH_KEY, 3)
    await t.deps.settings.setInternal('_catalog.state', { refreshedAt: 1, ids: ['a'] })
    await t.deps.settings.setInternal('_flag', null)
    expect(await t.deps.settings.getInternal(SESSION_EPOCH_KEY)).toBe(3)
    expect(await t.deps.settings.getInternal('_catalog.state')).toEqual({ refreshedAt: 1, ids: ['a'] })
    expect(await t.deps.settings.getInternal('_flag')).toBeNull()
    expect(Object.keys(await t.deps.settings.get()).some(key => key.startsWith('_'))).toBe(false)

    const other = reopened()
    expect(await other.getInternal(SESSION_EPOCH_KEY)).toBe(3)
    expect(await other.getInternal('_flag')).toBeNull()
  })

  it('removes a value with undefined', async () => {
    await t.deps.settings.setInternal(SESSION_EPOCH_KEY, 1)
    await t.deps.settings.setInternal(SESSION_EPOCH_KEY, undefined)
    expect(await t.deps.settings.getInternal(SESSION_EPOCH_KEY)).toBeUndefined()
    expect(await t.db.select().from(settingsTable).where(eq(settingsTable.key, SESSION_EPOCH_KEY))).toEqual([])
    expect(await reopened().getInternal(SESSION_EPOCH_KEY)).toBeUndefined()
  })

  it('returns copies of object values', async () => {
    await t.deps.settings.setInternal('_state', { list: [1] })
    const value = await t.deps.settings.getInternal<{ list: number[] }>('_state')
    value?.list.push(2)
    expect(await t.deps.settings.getInternal('_state')).toEqual({ list: [1] })
  })

  it('increments like a session epoch would', async () => {
    for (let index = 0; index < 3; index++) {
      const epoch = (await t.deps.settings.getInternal<number>(SESSION_EPOCH_KEY)) ?? 0
      await t.deps.settings.setInternal(SESSION_EPOCH_KEY, epoch + 1)
    }
    expect(await t.deps.settings.getInternal(SESSION_EPOCH_KEY)).toBe(3)
  })

  it.each([
    ['a public key', 'maxSteps'],
    ['a bare underscore', '_'],
    ['spaces', '_a b'],
    ['a slash', '_a/b'],
  ])('rejects %s as an internal key', async (_label, key) => {
    await expect(t.deps.settings.setInternal(key as never, 1)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(t.deps.settings.getInternal(key as never)).rejects.toMatchObject({ code: 'validation_error' })
  })

  it.each(['_auth.password', '_auth.passwordHash', '_plugin.secret', '_openai.apiKey', '_x.api_key', '_x.API-KEY'])(
    'refuses the secret-like internal key %s (secrets belong in the secret store)',
    async (key) => {
      await expect(t.deps.settings.setInternal(key as never, 'value')).rejects.toMatchObject({ code: 'validation_error' })
      expect(await t.db.select().from(settingsTable)).toEqual([])
    },
  )

  it('rejects values JSON cannot represent', async () => {
    await expect(t.deps.settings.setInternal('_fn', () => 1)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(t.deps.settings.setInternal('_big', 1n)).rejects.toMatchObject({ code: 'validation_error' })
  })
})

describe('settings changes', () => {
  it('notifies listeners with the changed keys', async () => {
    const changes: SettingsChange[] = []
    const subscription = onSettingsChange(t.deps.settings, change => changes.push(change))
    await t.deps.settings.update({ maxSteps: 30, density: 'comfortable' })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.keys).toEqual(['maxSteps'])
    expect(changes[0]?.previous.maxSteps).toBe(20)
    expect(changes[0]?.current.maxSteps).toBe(30)

    await t.deps.settings.update({ maxSteps: 30 })
    expect(changes).toHaveLength(1)

    subscription.dispose()
    await t.deps.settings.update({ maxSteps: 31 })
    expect(changes).toHaveLength(1)
  })

  it('isolates a throwing listener', async () => {
    const after = vi.fn()
    onSettingsChange(t.deps.settings, () => {
      throw new Error('listener bug')
    })
    onSettingsChange(t.deps.settings, after)
    await expect(t.deps.settings.update({ showThinking: true })).resolves.toMatchObject({ showThinking: true })
    expect(after).toHaveBeenCalledTimes(1)
    expect(t.logs.records.some(record => record.level === 'error' && record.msg.includes('listener'))).toBe(true)
  })

  it('does not notify for internal keys', async () => {
    const listener = vi.fn()
    onSettingsChange(t.deps.settings, listener)
    await t.deps.settings.setInternal(SESSION_EPOCH_KEY, 1)
    expect(listener).not.toHaveBeenCalled()
  })

  it('is a no-op for services without notifications', () => {
    expect(() => onSettingsChange(createMemorySettingsService(), () => {}).dispose()).not.toThrow()
  })
})
