// Model catalog (ARCHITECTURE.md 9, PROVIDERS.md 3 / 5 / 13, API.md 5.7). Entries per provider: the live listing (24 h
// cache in `model_cache`, last good kept on failure; seeds when there never was one) + plugin models + custom ids.
// Field precedence: custom -> live -> models.dev -> plugin models / seeds. `classify()` hides non-chat models; prefs
// come from `model_prefs`. Listing failures never break `GET /models`: the cache (else the seeds) is served and the
// error is recorded in `model_cache.error` and `provider_configs.last_error`.
//
// Phase 6 (ADR-028, ADR-029): seeds with an explicit media kind (`image`, `transcription`, `speech`) are listed even
// next to a live listing; a media model is listed only when its provider defines the matching factory
// (`createImageModel`, `createTranscriptionModel`, `createSpeechModel`), so Settings -> Media never offers a model that
// cannot be served (user custom models stay listed: the resolvers explain the error); image models are visible when
// listed, transcription and speech models hidden; `stats().modelCount` counts visible chat models.
//
// Background work (off under Vitest unless enabled through `createModelCatalogWith`): a refresh cycle shortly after
// `start()` and every 15 minutes (listings of enabled, configured providers that are stale or whose credentials
// changed; the models.dev snapshot when older than a week, never with `HF_OFFLINE=1`) and a check when a provider is
// registered. After a credential save the credentials route runs `providers.test()` + `catalog.refresh()` itself.
import type { CatalogModel, CustomModelInput, CustomModelKey, ModelInfo, ModelPrefsUpdate, ModelSource } from '@harness-forge/shared'
import type { ModelPrefRow } from '../db/schema.ts'
import type { RegisteredProvider } from '../registry/types.ts'
import type { ResolvedCredentials } from '../services/secrets/types.ts'
import type { AppDeps } from '../types.ts'
import type { ModelLayer, ModelPrefsState } from './merge.ts'
import type { ModelsDevSnapshot } from './models-dev.ts'
import type { CachedListing } from './store.ts'
import type { CatalogQuery, ModelCatalog } from './types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { BUILTIN_PLUGIN_IDS, HarnessError, modelIdSchema } from '@harness-forge/shared'
import { serverPackageRoot } from '../paths.ts'
import { createProviderConfigStore, isEnabledRow } from '../providers/configs.ts'
import { createProviderRuntime, LIST_MODELS_TIMEOUT_MS, withTimeout } from '../providers/runtime.ts'
import { isMediaModelKind, MEDIA_MODEL_KINDS, providerServesKind } from './classify.ts'
import { sanitizeListing } from './listing.ts'
import { buildCatalogModel, modelsDevLayer } from './merge.ts'
import { MODELS_DEV_URL, parseModelsDevSnapshot, serializeModelsDevSnapshot, trimModelsDev } from './models-dev.ts'
import { createCatalogStore } from './store.ts'

/** A live listing is refreshed when older than this. */
export const LISTING_TTL_MS = 24 * 60 * 60 * 1000
/** A failed listing is retried in the background no sooner than this (credential changes retry at once). */
export const LISTING_RETRY_MS = 30 * 60 * 1000
/**
 * A forced refresh right after a successful listing with the same credentials reuses it (a credential save runs a
 * provider test that lists models, then a refresh).
 */
export const REFRESH_DEDUPE_MS = 3000
/** The models.dev snapshot is refreshed when older than this. */
export const MODELS_DEV_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** A failed models.dev refresh is retried no sooner than this. */
export const MODELS_DEV_RETRY_MS = 60 * 60 * 1000
const MODELS_DEV_TIMEOUT_MS = 60_000
const MODELS_DEV_MAX_BYTES = 50 * 1024 * 1024
const BACKGROUND_INITIAL_DELAY_MS = 2000
const BACKGROUND_INTERVAL_MS = 15 * 60 * 1000
const LISTING_CONCURRENCY = 4
const PROVIDER_CHECK_DEBOUNCE_MS = 250
const REGISTRY_EVENT_DEBOUNCE_MS = 50

const BUILTIN_PLUGINS: ReadonlySet<string> = new Set(BUILTIN_PLUGIN_IDS)

export interface ModelCatalogOptions {
  /** Clock (tests). */
  now?: () => number
  /** Fetch of the models.dev refresh (default `globalThis.fetch`, read at call time). */
  fetch?: typeof globalThis.fetch
  /** Fetch handed to provider code through `ProviderRuntime.fetch` (default `globalThis.fetch`). */
  providerFetch?: typeof globalThis.fetch
  /** Default: `assets/catalog/models-dev.json` of the server package. */
  bundledSnapshotPath?: string
  /** Default: `<data>/cache/models-dev.json`. */
  cacheSnapshotPath?: string
  /** Background refreshes (timers, checks of newly registered providers). Default: on, except under Vitest. */
  background?: boolean
  initialDelayMs?: number
  intervalMs?: number
  /** Default `REFRESH_DEDUPE_MS`. */
  refreshDedupeMs?: number
}

type ListingOutcome = { ok: true, models: ModelInfo[] } | { ok: false, error: HarnessError }

/** Default location of the bundled snapshot. */
export function bundledSnapshotPath(): string {
  return join(serverPackageRoot(), 'assets', 'catalog', 'models-dev.json')
}

function isVitest(): boolean {
  return process.env.VITEST !== undefined
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** Credentials identity of a listing attempt (memory only, never logged or stored). */
function fingerprintOf(values: Readonly<Record<string, string>>): string {
  const sorted = Object.keys(values).sort().map(key => [key, values[key]])
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}

function notFound(message: string): HarnessError {
  return new HarnessError({ code: 'not_found', message })
}

function prefsState(row: ModelPrefRow | undefined): ModelPrefsState | undefined {
  if (row === undefined)
    return undefined
  return { hidden: row.hidden, favorite: row.favorite, alias: row.alias, custom: row.custom, lastUsedAt: row.lastUsedAt }
}

function isValidModelId(id: unknown): id is string {
  return modelIdSchema.safeParse(id).success
}

function compareNames(a: CatalogModel, b: CatalogModel): number {
  return a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Reads a body up to `maxBytes` (a larger body throws). */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error(`The response is larger than ${maxBytes} bytes.`)
  if (response.body === null)
    return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`The response is larger than ${maxBytes} bytes.`)
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** Runs `task` over `items` with at most `limit` in flight. */
async function mapLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const item = items[next++] as T
      await task(item).catch(() => {})
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** The catalog plus hooks for tests (not part of the frozen `ModelCatalog` interface). */
export interface ModelCatalogInternals extends ModelCatalog {
  /** Runs one background cycle now (stale listings, models.dev). */
  readonly runBackgroundCycle: () => Promise<void>
  /** The models.dev snapshot in use. */
  readonly modelsDevSnapshot: () => Promise<ModelsDevSnapshot | null>
}

export function createModelCatalog(deps: AppDeps): ModelCatalog {
  return createModelCatalogWith(deps, {})
}

/** `createModelCatalog` with injectable clock, fetch, snapshot paths and background switch (tests). */
export function createModelCatalogWith(deps: AppDeps, options: ModelCatalogOptions): ModelCatalogInternals {
  const now = options.now ?? Date.now
  const store = createCatalogStore(deps.db, now)
  const configs = createProviderConfigStore(deps.db, now)
  const background = options.background ?? !isVitest()
  const logger = deps.logger.child({ component: 'catalog' })

  let snapshot: ModelsDevSnapshot | null = null
  const listings = new Map<string, CachedListing>()
  /** Providers whose `model_cache` row must be (re)read before use (unregistered, then registered again). */
  const unloaded = new Set<string>()
  /** Running listings with the fingerprint of the credentials they use. */
  const inFlight = new Map<string, { fingerprint: string, run: Promise<ListingOutcome> }>()
  const fingerprints = new Map<string, string>()
  const providerCheckTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingRegistryEvents = new Set<string>()
  let registryEventTimer: ReturnType<typeof setTimeout> | undefined
  let cycleTimer: ReturnType<typeof setTimeout> | undefined
  let modelsDevAttemptedAt: number | null = null
  let modelsDevRefresh: Promise<void> | null = null
  let loading: Promise<void> | null = null
  let started = false
  let stopped = false
  const stopController = new AbortController()
  const disposables: { dispose: () => void }[] = []

  // ---------- loading ----------

  async function readSnapshot(path: string): Promise<ModelsDevSnapshot | null> {
    try {
      return parseModelsDevSnapshot(JSON.parse(await readFile(path, 'utf8')) as unknown)
    }
    catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT')
        logger.warn('cannot read a models.dev snapshot', { path, err: error })
      return null
    }
  }

  /** The newest of the bundled and the refreshed snapshot; a newer bundled one keeps the other refreshed providers. */
  function pickSnapshot(bundled: ModelsDevSnapshot | null, cached: ModelsDevSnapshot | null): ModelsDevSnapshot | null {
    if (cached === null)
      return bundled
    if (bundled === null || cached.fetchedAt >= bundled.fetchedAt)
      return cached
    return { ...bundled, complete: cached.complete, providers: { ...cached.providers, ...bundled.providers } }
  }

  function cachePath(): string {
    return options.cacheSnapshotPath ?? join(deps.env.paths.cache, 'models-dev.json')
  }

  function ensureLoaded(): Promise<void> {
    loading ??= (async () => {
      const [bundled, cached, rows] = await Promise.all([
        readSnapshot(options.bundledSnapshotPath ?? bundledSnapshotPath()),
        readSnapshot(cachePath()),
        store.listings().catch((error: unknown) => {
          logger.warn('cannot read the model cache', { err: error })
          return new Map<string, CachedListing>()
        }),
      ])
      snapshot = pickSnapshot(bundled, cached)
      for (const [providerId, listing] of rows) {
        if (!listings.has(providerId))
          listings.set(providerId, { ...listing, models: sanitizeListing(listing.models) })
      }
    })()
    return loading
  }

  /** Re-reads the cache rows of providers that were unregistered in between (the row may have been purged). */
  async function ensureListings(providerIds: Iterable<string>): Promise<void> {
    for (const providerId of providerIds) {
      if (!unloaded.has(providerId))
        continue
      unloaded.delete(providerId)
      const row = await store.listing(providerId).catch(() => null)
      if (row === null)
        listings.delete(providerId)
      else
        listings.set(providerId, { ...row, models: sanitizeListing(row.models) })
    }
  }

  // ---------- registry ----------

  function registeredProviders(): RegisteredProvider[] {
    try {
      return deps.registry.providers.list()
    }
    catch (error) {
      logger.warn('cannot list the registered providers', { err: error })
      return []
    }
  }

  function registeredProvider(providerId: string): RegisteredProvider | undefined {
    try {
      return deps.registry.providers.get(providerId)
    }
    catch {
      return undefined
    }
  }

  function pluginModels(providerId: string): ModelInfo[] {
    try {
      return deps.registry.models.list(providerId).flatMap(registration => [...registration.models])
    }
    catch {
      return []
    }
  }

  // ---------- entries ----------

  function indexById(models: readonly ModelInfo[]): Map<string, ModelInfo> {
    const map = new Map<string, ModelInfo>()
    for (const model of models) {
      if (isValidModelId(model.id) && !map.has(model.id))
        map.set(model.id, model)
    }
    return map
  }

  /**
   * Every entry of a provider (hidden included), or only `onlyId`. Ids: the live listing (else the seeds) plus the
   * seeds with an explicit media kind, plugin models and custom ids; media models of a kind the provider has no factory
   * for are left out unless the user added them.
   */
  function buildEntries(registered: RegisteredProvider, prefsRows: readonly ModelPrefRow[], onlyId?: string): CatalogModel[] {
    const definition = registered.definition
    const providerId = definition.id
    const listing = listings.get(providerId)
    const live = listing !== undefined && listing.fetchedAt !== null ? indexById(listing.models) : null
    const seeds = indexById(definition.seedModels ?? [])
    const served = new Set(MEDIA_MODEL_KINDS.filter(kind => providerServesKind(definition, kind)))
    const plugin = new Map<string, ModelLayer[]>()
    for (const model of pluginModels(providerId)) {
      if (!isValidModelId(model.id))
        continue
      const layers = plugin.get(model.id) ?? []
      layers.push(model)
      plugin.set(model.id, layers)
    }
    const prefs = new Map(prefsRows.map(row => [row.modelId, row]))
    const devModels = snapshot?.providers[definition.modelsDevId ?? providerId]

    const ids: string[] = []
    const seen = new Set<string>()
    const add = (id: string): void => {
      if (seen.has(id) || (onlyId !== undefined && id !== onlyId))
        return
      seen.add(id)
      ids.push(id)
    }
    for (const id of (live ?? seeds).keys())
      add(id)
    if (live !== null) {
      // Media seeds exist whatever the provider's `/models` endpoint returns.
      for (const [id, seed] of seeds) {
        if (isMediaModelKind(seed.kind))
          add(id)
      }
    }
    for (const id of plugin.keys())
      add(id)
    for (const row of prefsRows) {
      if (row.custom && isValidModelId(row.modelId))
        add(row.modelId)
    }

    const entries = ids.map((id) => {
      const pref = prefs.get(id)
      const custom = pref?.custom === true
      const dev = devModels?.[id]
      const source: ModelSource = custom ? 'custom' : live?.has(id) ? 'live' : plugin.has(id) ? 'plugin' : 'seed'
      return buildCatalogModel({
        providerId,
        id,
        layers: [
          custom ? (pref?.info ?? { id }) : undefined,
          live?.get(id),
          modelsDevLayer(dev),
          ...(plugin.get(id) ?? []),
          seeds.get(id),
        ],
        modalities: dev === undefined ? undefined : { input: dev.input, output: dev.output },
        prefs: prefsState(pref),
        source,
        imageModels: served.has('image'),
      })
    })
    return entries.filter(entry => entry.custom || !isMediaModelKind(entry.kind) || served.has(entry.kind))
  }

  async function prefsByProvider(providerId?: string): Promise<Map<string, ModelPrefRow[]>> {
    const rows = await store.prefs(providerId)
    const grouped = new Map<string, ModelPrefRow[]>()
    for (const row of rows) {
      const list = grouped.get(row.providerId) ?? []
      list.push(row)
      grouped.set(row.providerId, list)
    }
    return grouped
  }

  async function providerEntries(registered: RegisteredProvider, onlyId?: string): Promise<CatalogModel[]> {
    await ensureLoaded()
    await ensureListings([registered.definition.id])
    const rows = await store.prefs(registered.definition.id)
    return buildEntries(registered, rows, onlyId)
  }

  function requireProvider(providerId: string): RegisteredProvider {
    const registered = registeredProvider(providerId)
    if (registered === undefined)
      throw notFound(`Unknown provider "${providerId}".`)
    return registered
  }

  async function entryOf(providerId: string, modelId: string): Promise<CatalogModel | null> {
    const registered = registeredProvider(providerId)
    if (registered === undefined)
      return null
    return (await providerEntries(registered, modelId))[0] ?? null
  }

  // ---------- events ----------

  async function emitProviderChanged(providerId: string): Promise<void> {
    try {
      const provider = await deps.providers.get(providerId).catch(() => null)
      deps.events.emit('provider.changed', { id: providerId, provider })
    }
    catch (error) {
      logger.warn('cannot emit provider.changed', { providerId, err: error })
    }
  }

  function emitCatalogChanged(providerId: string | null): void {
    try {
      deps.events.emit('catalog.changed', { providerId })
    }
    catch (error) {
      logger.warn('cannot emit catalog.changed', { providerId, err: error })
    }
  }

  function pluginLog(pluginId: string, message: string): void {
    try {
      deps.plugins.log(pluginId, 'warn', message)
    }
    catch {
      // The plugin log is best effort.
    }
  }

  // ---------- live listings ----------

  function disabledError(providerId: string): HarnessError {
    return new HarnessError({
      code: 'provider_not_configured',
      message: `The provider "${providerId}" is disabled.`,
      providerId,
      action: 'configure-provider',
    })
  }

  function notConfiguredError(providerId: string, missing: readonly string[]): HarnessError {
    return new HarnessError({
      code: 'provider_not_configured',
      message: `The provider "${providerId}" is not configured (missing: ${missing.join(', ')}).`,
      providerId,
      action: 'configure-provider',
    })
  }

  /**
   * Fetches, stores and announces a listing; a failure keeps the last good listing and is recorded as the provider's
   * last error unless `recordProviderError` is false. A call made while a listing with the same credentials runs shares
   * it; with other credentials it waits for it and lists again.
   */
  async function runListing(registered: RegisteredProvider, credentials: ResolvedCredentials, recordProviderError = true): Promise<ListingOutcome> {
    const providerId = registered.definition.id
    const fingerprint = fingerprintOf(credentials.values)
    for (let running = inFlight.get(providerId); running !== undefined; running = inFlight.get(providerId)) {
      if (running.fingerprint === fingerprint)
        return running.run
      await running.run
    }
    const run = (async (): Promise<ListingOutcome> => {
      const definition = registered.definition
      const listModels = definition.listModels
      if (listModels === undefined)
        return { ok: true, models: [] }
      await ensureLoaded()
      await ensureListings([providerId])
      fingerprints.set(providerId, fingerprint)
      const attemptedAt = now()
      const previous = listings.get(providerId) ?? null
      try {
        const listed = await withTimeout(LIST_MODELS_TIMEOUT_MS, signal => listModels.call(definition, createProviderRuntime({
          definition,
          values: credentials.values,
          signal,
          logger: deps.logger,
          redactor: deps.redactor,
          fetch: options.providerFetch,
        })), stopController.signal)
        if (stopped)
          return { ok: false, error: new HarnessError({ code: 'provider_error', message: 'The catalog was stopped.', providerId }) }
        const models = sanitizeListing(listed)
        const listing: CachedListing = { providerId, models, fetchedAt: attemptedAt, attemptedAt, error: null }
        await store.saveListing(listing)
        listings.set(providerId, listing)
        // A listing error recorded as the provider's last error is cleared by the next good listing.
        if (previous?.error) {
          const config = await configs.get(providerId)
          if (config?.lastError && sameJson(config.lastError, previous.error))
            await configs.update(providerId, { lastError: null })
        }
        emitCatalogChanged(providerId)
        await emitProviderChanged(providerId)
        return { ok: true, models }
      }
      catch (error) {
        const mapped = deps.providers.mapError(providerId, error)
        if (stopped)
          return { ok: false, error: mapped }
        const init = mapped.toJSON().error
        const listing: CachedListing = {
          providerId,
          models: previous?.models ?? [],
          fetchedAt: previous?.fetchedAt ?? null,
          attemptedAt,
          error: init,
        }
        try {
          await store.saveListing(listing)
          listings.set(providerId, listing)
          if (recordProviderError)
            await configs.update(providerId, { lastError: init })
        }
        catch (storeError) {
          logger.warn('cannot record a listing failure', { providerId, err: storeError })
        }
        if (recordProviderError) {
          logger.warn('model listing failed', { providerId, code: init.code, status: init.status })
          pluginLog(registered.pluginId, `Model listing of "${providerId}" failed: ${init.message}`)
          await emitProviderChanged(providerId)
        }
        else {
          // A provider nobody configured (a local server that is not running): not worth a warning every cycle.
          logger.debug('model listing failed', { providerId, code: init.code, status: init.status })
        }
        return { ok: false, error: mapped }
      }
    })().finally(() => {
      if (inFlight.get(providerId)?.run === run)
        inFlight.delete(providerId)
    })
    inFlight.set(providerId, { fingerprint, run })
    return run
  }

  /**
   * Refreshes a provider's listing in the background when due: enabled, `listModels`, credentials complete, and either
   * the credentials changed since the last attempt of this process or the listing is stale (not retried within
   * `LISTING_RETRY_MS` of a failure). A provider configured only by defaults (a local server nobody set up) does not get
   * a provider error for a failed background listing.
   */
  async function considerRefresh(providerId: string): Promise<void> {
    if (stopped)
      return
    const registered = registeredProvider(providerId)
    if (registered?.definition.listModels === undefined || inFlight.has(providerId))
      return
    const config = await configs.get(providerId)
    if (!isEnabledRow(config))
      return
    const credentials = await deps.credentials.resolve(providerId)
    if (credentials.missing.length > 0)
      return
    await ensureLoaded()
    await ensureListings([providerId])
    const recorded = fingerprints.get(providerId)
    const changed = recorded !== undefined && recorded !== fingerprintOf(credentials.values)
    const listing = listings.get(providerId)
    const time = now()
    const stale = listing === undefined || listing.fetchedAt === null || time - listing.fetchedAt >= LISTING_TTL_MS
    const backingOff = listing?.error != null && time - listing.attemptedAt < LISTING_RETRY_MS
    if (changed || (stale && !backingOff)) {
      const explicit = Object.values(credentials.sources).some(source => source === 'stored' || source === 'env')
      await runListing(registered, credentials, explicit)
    }
  }

  function scheduleProviderCheck(providerId: string): void {
    if (!background || stopped)
      return
    clearTimeout(providerCheckTimers.get(providerId))
    const timer = setTimeout(() => {
      providerCheckTimers.delete(providerId)
      considerRefresh(providerId).catch((error: unknown) => logger.debug('provider listing check failed', { providerId, err: error }))
    }, PROVIDER_CHECK_DEBOUNCE_MS)
    timer.unref?.()
    providerCheckTimers.set(providerId, timer)
  }

  // ---------- models.dev ----------

  /** Plugin providers whose models.dev key the (partial, bundled) snapshot does not have. */
  function missingPluginKeys(current: ModelsDevSnapshot): string[] {
    if (current.complete)
      return []
    return registeredProviders()
      .filter(registered => !BUILTIN_PLUGINS.has(registered.pluginId))
      .map(registered => registered.definition.modelsDevId ?? registered.definition.id)
      .filter(key => current.providers[key] === undefined)
  }

  function modelsDevDue(): boolean {
    if (deps.env.offline)
      return false
    const time = now()
    if (modelsDevAttemptedAt !== null && time - modelsDevAttemptedAt < MODELS_DEV_RETRY_MS)
      return false
    return snapshot === null || time - snapshot.fetchedAt >= MODELS_DEV_MAX_AGE_MS || missingPluginKeys(snapshot).length > 0
  }

  function refreshModelsDev(): Promise<void> {
    modelsDevRefresh ??= (async () => {
      modelsDevAttemptedAt = now()
      try {
        const fetchImpl = options.fetch ?? globalThis.fetch
        const response = await fetchImpl(MODELS_DEV_URL, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.any([stopController.signal, AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS)]),
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw new Error(`models.dev answered HTTP ${response.status}.`)
        }
        const refreshed = trimModelsDev(JSON.parse(await readLimited(response, MODELS_DEV_MAX_BYTES)) as unknown, { fetchedAt: now() })
        if (stopped)
          return
        const target = cachePath()
        await mkdir(dirname(target), { recursive: true })
        const temporary = `${target}.${process.pid}.tmp`
        await writeFile(temporary, serializeModelsDevSnapshot(refreshed), 'utf8')
        await rename(temporary, target)
        snapshot = refreshed
        logger.info('models.dev snapshot refreshed', { providers: Object.keys(refreshed.providers).length })
        emitCatalogChanged(null)
      }
      catch (error) {
        if (!stopped)
          logger.warn('models.dev refresh failed', { err: error })
      }
    })().finally(() => {
      modelsDevRefresh = null
    })
    return modelsDevRefresh
  }

  // ---------- background ----------

  async function backgroundCycle(): Promise<void> {
    if (stopped)
      return
    await ensureLoaded()
    const due: string[] = []
    for (const registered of registeredProviders()) {
      if (registered.definition.listModels !== undefined)
        due.push(registered.definition.id)
    }
    const listingsDone = mapLimited(due, LISTING_CONCURRENCY, providerId => considerRefresh(providerId))
    const modelsDevDone = modelsDevDue() ? refreshModelsDev() : Promise.resolve()
    await Promise.all([listingsDone, modelsDevDone])
  }

  function scheduleCycle(delayMs: number): void {
    if (stopped)
      return
    cycleTimer = setTimeout(() => {
      backgroundCycle()
        .catch((error: unknown) => logger.warn('catalog background refresh failed', { err: error }))
        .finally(() => scheduleCycle(options.intervalMs ?? BACKGROUND_INTERVAL_MS))
    }, delayMs)
    cycleTimer.unref?.()
  }

  function onRegistryChange(kind: string, action: string, key: string): void {
    if (kind !== 'provider' && kind !== 'models')
      return
    if (kind === 'provider' && action === 'removed') {
      listings.delete(key)
      unloaded.add(key)
      fingerprints.delete(key)
    }
    pendingRegistryEvents.add(key)
    if (registryEventTimer === undefined && !stopped) {
      registryEventTimer = setTimeout(() => {
        registryEventTimer = undefined
        const keys = [...pendingRegistryEvents]
        pendingRegistryEvents.clear()
        emitCatalogChanged(keys.length === 1 ? (keys[0] ?? null) : null)
      }, REGISTRY_EVENT_DEBOUNCE_MS)
      registryEventTimer.unref?.()
    }
    if (kind === 'provider' && action === 'added' && started)
      scheduleProviderCheck(key)
  }

  // ---------- service ----------

  return {
    runBackgroundCycle: backgroundCycle,

    modelsDevSnapshot: async () => {
      await ensureLoaded()
      return snapshot
    },

    start: async () => {
      if (started || stopped)
        return
      started = true
      try {
        await ensureLoaded()
      }
      catch (error) {
        logger.warn('catalog warm-up failed', { err: error })
      }
      try {
        disposables.push(deps.registry.onChange(change => onRegistryChange(change.kind, change.action, change.key)))
      }
      catch (error) {
        logger.warn('cannot observe the registry', { err: error })
      }
      if (background)
        scheduleCycle(options.initialDelayMs ?? BACKGROUND_INITIAL_DELAY_MS)
    },

    stop: async () => {
      if (stopped)
        return
      stopped = true
      clearTimeout(cycleTimer)
      clearTimeout(registryEventTimer)
      for (const timer of providerCheckTimers.values())
        clearTimeout(timer)
      providerCheckTimers.clear()
      for (const disposable of disposables.splice(0)) {
        try {
          disposable.dispose()
        }
        catch {
          // Already disposed.
        }
      }
      stopController.abort(new DOMException('The catalog stopped.', 'AbortError'))
      await Promise.allSettled([...[...inFlight.values()].map(running => running.run), modelsDevRefresh ?? Promise.resolve()])
    },

    list: async (query: CatalogQuery = {}) => {
      await ensureLoaded()
      let providers = registeredProviders()
      if (query.providerId !== undefined) {
        const registered = requireProvider(query.providerId)
        providers = [registered]
      }
      const configMap = await configs.all()
      const enabled = providers.filter(registered => isEnabledRow(configMap.get(registered.definition.id)))
      await ensureListings(enabled.map(registered => registered.definition.id))
      const prefs = await prefsByProvider(query.providerId)
      const order = new Map(registeredProviders().map((registered, index) => [registered.definition.id, index]))
      const entries = enabled.flatMap(registered => buildEntries(registered, prefs.get(registered.definition.id) ?? []))
      const visible = query.includeHidden === true ? entries : entries.filter(entry => !entry.hidden)
      const group = (entry: CatalogModel): number => (entry.favorite ? 0 : entry.lastUsedAt !== null ? 1 : 2)
      return visible.sort((a, b) => {
        const byGroup = group(a) - group(b)
        if (byGroup !== 0)
          return byGroup
        if (group(a) === 1 && a.lastUsedAt !== b.lastUsedAt)
          return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
        const byProvider = (order.get(a.providerId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.providerId) ?? Number.MAX_SAFE_INTEGER)
        return byProvider !== 0 ? byProvider : compareNames(a, b)
      })
    },

    get: async (providerId, modelId) => entryOf(providerId, modelId),

    refresh: async (providerId) => {
      const registered = requireProvider(providerId)
      if (!isEnabledRow(await configs.get(providerId)))
        throw disabledError(providerId)
      if (registered.definition.listModels !== undefined) {
        const credentials = await deps.credentials.resolve(providerId)
        if (credentials.missing.length > 0)
          throw notConfiguredError(providerId, credentials.missing)
        await ensureLoaded()
        await ensureListings([providerId])
        const listing = listings.get(providerId)
        const reusable = listing !== undefined && listing.error === null && listing.fetchedAt !== null
          && fingerprints.get(providerId) === fingerprintOf(credentials.values)
          && now() - listing.fetchedAt < (options.refreshDedupeMs ?? REFRESH_DEDUPE_MS)
        if (!reusable) {
          const outcome = await runListing(registered, credentials)
          if (!outcome.ok)
            throw outcome.error
        }
      }
      return (await providerEntries(registered)).sort(compareNames)
    },

    updatePrefs: async (update: ModelPrefsUpdate) => {
      requireProvider(update.providerId)
      if (await entryOf(update.providerId, update.modelId) === null)
        throw notFound(`Unknown model "${update.providerId}:${update.modelId}".`)
      await store.upsertPref(update.providerId, update.modelId, {
        ...(update.favorite === undefined ? {} : { favorite: update.favorite }),
        ...(update.hidden === undefined ? {} : { hidden: update.hidden }),
        ...(update.alias === undefined ? {} : { alias: update.alias }),
      })
      emitCatalogChanged(update.providerId)
      const entry = await entryOf(update.providerId, update.modelId)
      if (entry === null)
        throw notFound(`Unknown model "${update.providerId}:${update.modelId}".`)
      return entry
    },

    addCustom: async (input: CustomModelInput) => {
      requireProvider(input.providerId)
      const info: ModelInfo = { id: input.modelId, kind: input.kind ?? 'chat' }
      if (input.name !== undefined)
        info.name = input.name
      if (input.contextWindow !== undefined)
        info.contextWindow = input.contextWindow
      if (input.maxOutputTokens !== undefined)
        info.maxOutputTokens = input.maxOutputTokens
      if (input.capabilities !== undefined)
        info.capabilities = { ...input.capabilities }
      if (input.reasoningEfforts !== undefined)
        info.reasoningEfforts = [...input.reasoningEfforts]
      if (input.cost !== undefined)
        info.cost = { ...input.cost }
      await store.upsertPref(input.providerId, input.modelId, { custom: true, info })
      emitCatalogChanged(input.providerId)
      const entry = await entryOf(input.providerId, input.modelId)
      if (entry === null)
        throw notFound(`Unknown model "${input.providerId}:${input.modelId}".`)
      return entry
    },

    removeCustom: async (key: CustomModelKey) => {
      const row = await store.pref(key.providerId, key.modelId)
      if (row === null || !row.custom)
        throw notFound(`No custom model "${key.providerId}:${key.modelId}".`)
      const keepsPrefs = row.favorite || row.hidden !== null || row.alias !== null || row.lastUsedAt !== null
      if (keepsPrefs)
        await store.upsertPref(key.providerId, key.modelId, { custom: false, info: null })
      else
        await store.deletePref(key.providerId, key.modelId)
      emitCatalogChanged(key.providerId)
    },

    markUsed: async (providerId, modelId, at) => {
      await store.upsertPref(providerId, modelId, { lastUsedAt: at ?? now() })
    },

    stats: async (providerId) => {
      const registered = registeredProvider(providerId)
      if (registered === undefined)
        return { modelCount: 0, fetchedAt: null }
      const entries = await providerEntries(registered)
      return {
        // Visible chat models (API.md 4.4): visible image models are not counted.
        modelCount: entries.filter(entry => !entry.hidden && entry.kind === 'chat').length,
        fetchedAt: listings.get(providerId)?.fetchedAt ?? null,
      }
    },
  }
}
