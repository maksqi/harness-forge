// In-memory fakes of the cross-agent services, so each agent can test against the frozen interfaces while the real
// implementations land in parallel: `createTestApp({ overrides: { events: createRecordingEventBus() } })`.
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { IconRef, LobeIconList, ServerEvent, Settings, SettingsUpdate } from '@harness-forge/shared'
import type { IconService } from '../providers/types.ts'
import type { Keyring, SubkeyName } from '../security/types.ts'
import type { EventBus, EventSubscribeOptions, ServerEventListener } from '../services/events/types.ts'
import type { SecretEntry, SecretScope, SecretStore } from '../services/secrets/types.ts'
import type { InternalSettingKey, SettingsService } from '../services/settings/types.ts'
import { createHash, hkdfSync } from 'node:crypto'
import { createServerEvent, DEFAULT_SETTINGS, settingsSchema, settingsUpdateSchema, validationError } from '@harness-forge/shared'
import { secretHint } from '../services/secrets/hint'

/** Deterministic keyring: HKDF-SHA256 subkeys of `sha256(seed)` (same derivation parameters as the real keyring). */
export function createFakeKeyring(seed = 'harness-forge-test-master-key'): Keyring {
  const master = createHash('sha256').update(seed).digest()
  const cache = new Map<SubkeyName, Uint8Array>()
  return {
    keyVersion: 1,
    subkey: (name) => {
      let key = cache.get(name)
      if (key === undefined) {
        key = new Uint8Array(hkdfSync('sha256', master, 'harness-forge/v1', name, 32))
        cache.set(name, key)
      }
      return key
    },
  }
}

export interface RecordingEventBus extends EventBus {
  /** Every event emitted so far. */
  readonly events: ServerEvent[]
  /** Events of one type. */
  readonly ofType: <T extends ServerEvent['type']>(type: T) => Extract<ServerEvent, { type: T }>[]
  readonly clear: () => void
}

/** A working in-memory event bus that also records every event. */
export function createRecordingEventBus(): RecordingEventBus {
  const events: ServerEvent[] = []
  const subscribers = new Map<ServerEventListener, EventSubscribeOptions>()
  let stopped = false

  function publish(event: ServerEvent): void {
    if (stopped)
      return
    events.push(event)
    for (const listener of [...subscribers.keys()]) {
      try {
        listener(event)
      }
      catch {
        // A throwing listener never breaks the producer.
      }
    }
  }

  return {
    events,
    ofType: type => events.filter(event => event.type === type) as never,
    clear: () => {
      events.length = 0
    },
    emit: (type, data) => publish(createServerEvent(type, data)),
    publish,
    subscribe: (listener, options = {}): Disposable => {
      subscribers.set(listener, options)
      return { dispose: () => void subscribers.delete(listener) }
    },
    subscriberCount: () => subscribers.size,
    stop: async () => {
      stopped = true
      for (const options of subscribers.values())
        options.onClose?.()
      subscribers.clear()
    },
  }
}

/** Hint of the fakes: the real rule of `services/secrets/hint.ts`, so fakes and the service agree. */
export function fakeSecretHint(value: string): string | null {
  return secretHint(value)
}

/** Plaintext in-memory secret store (tests only). */
export function createMemorySecretStore(): SecretStore {
  const rows = new Map<string, { scope: SecretScope, name: string, value: string, updatedAt: number }>()
  const keyOf = (scope: SecretScope, name: string): string => `${scope}\u0000${name}`
  return {
    get: async (scope, name) => rows.get(keyOf(scope, name))?.value ?? null,
    set: async (scope, name, value) => {
      rows.set(keyOf(scope, name), { scope, name, value, updatedAt: Date.now() })
    },
    delete: async (scope, name) => rows.delete(keyOf(scope, name)),
    deleteScope: async (scope) => {
      let count = 0
      for (const [key, row] of rows) {
        if (row.scope === scope) {
          rows.delete(key)
          count += 1
        }
      }
      return count
    },
    list: async (scope) => {
      const entries: SecretEntry[] = []
      for (const row of rows.values()) {
        if (row.scope === scope)
          entries.push({ scope, name: row.name, hint: fakeSecretHint(row.value), keyVersion: 1, updatedAt: row.updatedAt })
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name))
    },
  }
}

/** In-memory settings validated with the shared schemas. */
export function createMemorySettingsService(initial: Partial<Settings> = {}): SettingsService {
  let current: Settings = settingsSchema.parse({ ...DEFAULT_SETTINGS, ...initial })
  const internal = new Map<InternalSettingKey, unknown>()
  return {
    get: async () => ({ ...current }),
    update: async (patch: SettingsUpdate) => {
      const parsed = settingsUpdateSchema.safeParse(patch)
      if (!parsed.success)
        throw validationError(parsed.error)
      current = settingsSchema.parse({ ...current, ...parsed.data })
      return { ...current }
    },
    getInternal: async <T>(key: InternalSettingKey) => internal.get(key) as T | undefined,
    setInternal: async (key, value) => {
      if (value === undefined)
        internal.delete(key)
      else
        internal.set(key, value)
    },
  }
}

/**
 * Icon service that knows every mono slug and no color variant: `lobeRef('lobe:<slug>')` ->
 * `{ mono: '/api/icons/lobe/<slug>?v=test' }`; a `{ color, mono }` pair maps each `lobe:` slug as given.
 */
export function createFakeIconService(): IconService {
  const list: LobeIconList = { items: [], version: 'test' }
  const url = (slug: string): string => `/api/icons/lobe/${slug}?v=test`
  const slugOf = (spec: string | undefined): string | null => spec?.startsWith('lobe:') ? spec.slice('lobe:'.length) : null
  return {
    version: 'test',
    list: async () => list,
    read: async slug => `<svg xmlns="http://www.w3.org/2000/svg" data-slug="${slug}"></svg>`,
    lobeRef: (icon): IconRef => {
      if (typeof icon === 'string') {
        const slug = slugOf(icon)
        return slug === null ? null : { mono: url(slug.replace(/-color$/, '')) }
      }
      const color = slugOf(icon.color)
      const mono = slugOf(icon.mono)
      if (color === null && mono === null)
        return null
      return { ...(color === null ? {} : { color: url(color) }), ...(mono === null ? {} : { mono: url(mono) }) }
    },
  }
}
