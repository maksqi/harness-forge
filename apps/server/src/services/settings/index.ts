// Global settings over the `settings` table (API.md 4.3 `Settings`, ARCHITECTURE.md 8, W1.2-T3). Implements the frozen
// `SettingsService` (./types.ts).
//
// - Public keys: the `Settings` DTO keys, one row each; missing rows and stored values that no longer validate fall back
//   to `DEFAULT_SETTINGS` (an invalid row is logged once and ignored, never returned). Updates are validated with the
//   shared `settingsUpdateSchema` (strict, at least one key, model refs checked for format only).
// - Internal keys: prefix `_` (e.g. `_auth.sessionEpoch`), JSON values, never part of `get()` or the API.
// - No secrets: settings are plain JSON; secret values belong in the secret store (`deps.secrets`).
// - Both kinds are cached in memory; every access to the table goes through one serial queue, so the cache always
//   reflects the database (this service is the only writer of the table).
// - Observable: `onChange(listener)` reports every update that changed at least one public value (see
//   `onSettingsChange` for callers typed with the frozen interface).
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { Settings, SettingsUpdate } from '@harness-forge/shared'
import type { ZodType } from 'zod'
import type { AppDeps } from '../../types.ts'
import type { InternalSettingKey, SettingsService } from './types.ts'
import { DEFAULT_SETTINGS, HarnessError, SETTINGS_KEYS, settingsSchema, settingsUpdateSchema, validationError } from '@harness-forge/shared'
import { eq, inArray, sql } from 'drizzle-orm'
import { settings as settingsTable } from '../../db/schema.ts'

export type SettingsKey = keyof Settings

/** A committed update that changed at least one public value. */
export interface SettingsChange {
  /** Keys whose value changed, in `SETTINGS_KEYS` order. */
  keys: SettingsKey[]
  previous: Settings
  current: Settings
}

export type SettingsListener = (change: SettingsChange) => void

/** The settings service with change notifications (CCR: add `onChange` to the frozen `SettingsService`). */
export interface ObservableSettingsService extends SettingsService {
  /**
   * Called synchronously, in subscription order, after an update is persisted; a throwing listener is logged and
   * never affects the update or the other listeners.
   */
  readonly onChange: (listener: SettingsListener) => Disposable
}

/** `_` + 1-127 characters of `A-Z a-z 0-9 _ . : -`. */
const INTERNAL_KEY = /^_[\w.:-]{1,127}$/
/** Internal keys that name a secret: secrets belong in the secret store (the password hash: scope `auth`). */
const SECRET_LIKE_KEY = /passw(?:or)?d|secret|api[-_.]?key/i

const noopDisposable: Disposable = Object.freeze({ dispose: () => {} })

function isObservable(service: SettingsService): service is ObservableSettingsService {
  return typeof (service as Partial<ObservableSettingsService>).onChange === 'function'
}

/**
 * Subscribes to settings changes through the frozen `SettingsService` type (`deps.settings`). Returns a no-op
 * `Disposable` for implementations without notifications (test fakes).
 */
export function onSettingsChange(service: SettingsService, listener: SettingsListener): Disposable {
  return isObservable(service) ? service.onChange(listener) : noopDisposable
}

function assertInternalKey(key: unknown): asserts key is InternalSettingKey {
  if (typeof key !== 'string' || !INTERNAL_KEY.test(key)) {
    throw new HarnessError({
      code: 'validation_error',
      message: 'Internal setting keys start with "_" and use up to 128 characters of A-Z, a-z, 0-9, "_", ".", ":" and "-".',
    })
  }
  if (SECRET_LIKE_KEY.test(key)) {
    throw new HarnessError({
      code: 'validation_error',
      message: 'Settings never hold secrets: store passwords, secrets and API keys in the secret store.',
    })
  }
}

/** JSON text of an internal value; throws `validation_error` for values JSON cannot represent. */
function internalJson(value: unknown): string {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  }
  catch {
    text = undefined
  }
  if (text === undefined)
    throw new HarnessError({ code: 'validation_error', message: 'Internal setting values must be JSON-serializable.' })
  return text
}

/**
 * The JSON text bound as a plain SQL parameter: Drizzle would turn a JSON `null` (a valid value, e.g.
 * `defaultModelRef: null`) into SQL NULL, which the NOT NULL `value` column rejects.
 */
function jsonValue(text: string) {
  return sql`${text}`
}

/** Runs async tasks one at a time; a failed task does not block the next one. */
function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task)
    tail = result.then(() => {}, () => {})
    return result
  }
}

export function createSettingsService(deps: AppDeps): ObservableSettingsService {
  const { db, logger } = deps
  const serial = createSerialQueue()
  const listeners = new Set<SettingsListener>()
  /** Public settings, loaded on first use. */
  let cache: Settings | undefined
  /** Internal values by key; `null` = known to be unset. */
  const internalCache = new Map<InternalSettingKey, { value: unknown } | null>()
  /** Stored public values already reported as invalid. */
  const reportedInvalid = new Set<string>()

  async function loadPublic(): Promise<Settings> {
    const rows = await db
      .select({ key: settingsTable.key, value: settingsTable.value })
      .from(settingsTable)
      .where(inArray(settingsTable.key, [...SETTINGS_KEYS]))
    const loaded: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    for (const row of rows) {
      const key = row.key as SettingsKey
      const schema = settingsSchema.shape[key] as ZodType
      const parsed = schema.safeParse(row.value)
      if (parsed.success) {
        loaded[key] = parsed.data
      }
      else if (!reportedInvalid.has(key)) {
        reportedInvalid.add(key)
        // (A field named `key` would be masked by the redactor.)
        logger.warn('stored setting is invalid, using its default', { setting: key })
      }
    }
    return loaded as Settings
  }

  async function current(): Promise<Settings> {
    cache ??= await loadPublic()
    return cache
  }

  function notify(change: SettingsChange): void {
    for (const listener of [...listeners]) {
      try {
        listener({ keys: [...change.keys], previous: { ...change.previous }, current: { ...change.current } })
      }
      catch (error) {
        logger.error('settings change listener failed', { err: error })
      }
    }
  }

  async function get(): Promise<Settings> {
    if (cache !== undefined)
      return { ...cache }
    return serial(async () => ({ ...(await current()) }))
  }

  async function update(patch: SettingsUpdate): Promise<Settings> {
    const parsed = settingsUpdateSchema.safeParse(patch)
    if (!parsed.success)
      throw validationError(parsed.error)
    const entries = Object.entries(parsed.data).filter(([, value]) => value !== undefined) as [SettingsKey, unknown][]
    return serial(async () => {
      const previous = await current()
      if (entries.length === 0)
        return { ...previous }
      const updatedAt = Date.now()
      await db
        .insert(settingsTable)
        .values(entries.map(([key, value]) => ({ key, value: jsonValue(JSON.stringify(value)), updatedAt })))
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: sql.raw('excluded.value'), updatedAt: sql.raw('excluded.updated_at') },
        })
      const next = settingsSchema.parse({ ...previous, ...Object.fromEntries(entries) })
      cache = next
      const keys = SETTINGS_KEYS.filter(key => !Object.is(previous[key], next[key]))
      if (keys.length > 0)
        notify({ keys, previous, current: next })
      return { ...next }
    })
  }

  async function getInternal<T = unknown>(key: InternalSettingKey): Promise<T | undefined> {
    assertInternalKey(key)
    const read = (): T | undefined => {
      const entry = internalCache.get(key)
      return entry ? structuredClone(entry.value) as T : undefined
    }
    if (internalCache.has(key))
      return read()
    return serial(async () => {
      if (!internalCache.has(key)) {
        const [row] = await db
          .select({ value: settingsTable.value })
          .from(settingsTable)
          .where(eq(settingsTable.key, key))
          .limit(1)
        internalCache.set(key, row === undefined ? null : { value: row.value })
      }
      return read()
    })
  }

  async function setInternal(key: InternalSettingKey, value: unknown): Promise<void> {
    assertInternalKey(key)
    const text = value === undefined ? undefined : internalJson(value)
    await serial(async () => {
      if (text === undefined) {
        await db.delete(settingsTable).where(eq(settingsTable.key, key))
        internalCache.set(key, null)
        return
      }
      const updatedAt = Date.now()
      await db
        .insert(settingsTable)
        .values({ key, value: jsonValue(text), updatedAt })
        .onConflictDoUpdate({ target: settingsTable.key, set: { value: jsonValue(text), updatedAt } })
      internalCache.set(key, { value: JSON.parse(text) as unknown })
    })
  }

  function onChange(listener: SettingsListener): Disposable {
    listeners.add(listener)
    return { dispose: () => void listeners.delete(listener) }
  }

  return { get, update, getInternal, setInternal, onChange }
}
