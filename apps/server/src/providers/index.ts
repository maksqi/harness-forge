// Provider service (ARCHITECTURE.md 6.6, PROVIDERS.md, API.md 5.5): registered providers joined with
// `provider_configs`, credentials (W1.2 `CredentialService`, env fallback) and the catalog; model resolution
// (`modelRef` -> `LanguageModel` with the user's credentials), provider tests, error mapping and call outcomes.
import type { ProviderDefinition, ProviderRuntime } from '@harness-forge/plugin-sdk'
import type { CredentialState, HarnessErrorInit, IconRef, ProviderStatus, ProviderSummary, ProviderTestResult } from '@harness-forge/shared'
import type { ProviderConfigRow } from '../db/schema.ts'
import type { RegisteredProvider } from '../registry/types.ts'
import type { ResolvedCredentials } from '../services/secrets/types.ts'
import type { AppDeps } from '../types.ts'
import type { LanguageModelInstance, ProviderService, ResolvedModel, ResolveModelOptions } from './types.ts'
import { performance } from 'node:perf_hooks'
import { HarnessError, harnessErrorInitSchema, isHarnessError, parseModelRef } from '@harness-forge/shared'
import { generateText } from 'ai'
import { sanitizeListing } from '../catalog/listing.ts'
import { catalogModelInfo } from '../catalog/merge.ts'
import { createProviderConfigStore, isEnabledRow } from './configs.ts'
import { defaultProviderError } from './errors.ts'
import { createProviderRuntime, VALIDATE_TIMEOUT_MS, withTimeout } from './runtime.ts'

/** Error codes that put a provider into status `error` (API.md 4.4) and that calls record as `lastError`. */
const STATUS_ERROR_CODES: ReadonlySet<string> = new Set(['auth_invalid', 'provider_unreachable'])

/** Output budget of the credential ping (the OpenAI Responses API rejects less than 16). */
const PING_MAX_OUTPUT_TOKENS = 16

export interface ProviderServiceOptions {
  now?: () => number
  /** Base fetch handed to provider code (default `globalThis.fetch`, read at call time). */
  fetch?: typeof globalThis.fetch
  /** `POST /providers/:id/test` timeout; default 15 s. */
  testTimeoutMs?: number
}

/** No required secret field ("Local — no key"). */
export function isLocalProvider(definition: ProviderDefinition): boolean {
  return !definition.credentials.some(field => field.type === 'secret' && field.required === true)
}

/**
 * `ProviderStatus` (API.md 4.4, first match): required fields unresolved and not local -> `not_configured`; last error
 * `auth_invalid` / `provider_unreachable` -> `error`; every resolved secret from env -> `env`; otherwise `connected`.
 * `credentials` null means they could not be resolved (reported as not configured).
 */
export function providerStatus(
  definition: ProviderDefinition,
  credentials: ResolvedCredentials | null,
  lastError: HarnessErrorInit | null,
): ProviderStatus {
  const local = isLocalProvider(definition)
  if (!local && (credentials === null || credentials.missing.length > 0))
    return 'not_configured'
  if (lastError !== null && STATUS_ERROR_CODES.has(lastError.code))
    return 'error'
  if (credentials !== null) {
    const secrets = definition.credentials
      .filter(field => field.type === 'secret' && (credentials.values[field.key] ?? '') !== '')
      .map(field => field.key)
    if (secrets.length > 0 && secrets.every(key => credentials.sources[key] === 'env'))
      return 'env'
  }
  return 'connected'
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function isLanguageModel(value: unknown): value is LanguageModelInstance {
  if (typeof value !== 'object' || value === null)
    return false
  const model = value as Record<string, unknown>
  return (model.specificationVersion === 'v4' || model.specificationVersion === 'v3' || model.specificationVersion === 'v2')
    && typeof model.doStream === 'function' && typeof model.doGenerate === 'function'
}

export function createProviderService(deps: AppDeps): ProviderService {
  return createProviderServiceWith(deps, {})
}

/** `createProviderService` with an injectable clock, fetch and test timeout (tests). */
export function createProviderServiceWith(deps: AppDeps, options: ProviderServiceOptions): ProviderService {
  const now = options.now ?? Date.now
  const configs = createProviderConfigStore(deps.db, now)
  const logger = deps.logger.child({ component: 'providers' })

  function registered(providerId: string): RegisteredProvider | undefined {
    try {
      return deps.registry.providers.get(providerId)
    }
    catch {
      return undefined
    }
  }

  function requireRegistered(providerId: string): RegisteredProvider {
    const provider = registered(providerId)
    if (provider === undefined)
      throw new HarnessError({ code: 'not_found', message: `Unknown provider "${providerId}".` })
    return provider
  }

  function notConfigured(providerId: string, message: string): HarnessError {
    return new HarnessError({ code: 'provider_not_configured', message, providerId, action: 'configure-provider' })
  }

  function runtimeFor(provider: RegisteredProvider, credentials: ResolvedCredentials, signal?: AbortSignal): ProviderRuntime {
    return createProviderRuntime({
      definition: provider.definition,
      values: credentials.values,
      signal,
      logger: deps.logger,
      redactor: deps.redactor,
      fetch: options.fetch,
    })
  }

  function pluginLog(pluginId: string, message: string): void {
    try {
      deps.plugins.log(pluginId, 'warn', message)
    }
    catch {
      // The plugin log is best effort.
    }
  }

  /** Guarded `createLanguageModel`: a throw or a non-model value is a `plugin_error` of the owner plugin. */
  function createModel(provider: RegisteredProvider, modelId: string, rt: ProviderRuntime): LanguageModelInstance {
    const providerId = provider.definition.id
    let model: unknown
    try {
      model = provider.definition.createLanguageModel(modelId, rt)
    }
    catch (error) {
      if (isHarnessError(error))
        throw error
      logger.warn('createLanguageModel failed', { providerId, modelId, err: error })
      pluginLog(provider.pluginId, `createLanguageModel("${modelId}") of "${providerId}" threw an error.`)
      throw new HarnessError(
        { code: 'plugin_error', message: `The provider "${providerId}" failed to create the model "${modelId}".`, providerId, details: { pluginId: provider.pluginId } },
        { cause: error },
      )
    }
    if (!isLanguageModel(model)) {
      pluginLog(provider.pluginId, `createLanguageModel("${modelId}") of "${providerId}" did not return a language model instance.`)
      throw new HarnessError({
        code: 'plugin_error',
        message: `The provider "${providerId}" returned an invalid model for "${modelId}".`,
        providerId,
        details: { pluginId: provider.pluginId },
      })
    }
    return model
  }

  // ---------- summaries ----------

  async function iconOf(provider: RegisteredProvider): Promise<IconRef> {
    const icon = provider.definition.icon
    if (icon !== undefined) {
      try {
        const ref = deps.icons.lobeRef(icon)
        if (ref !== null)
          return ref
      }
      catch (error) {
        logger.debug('cannot resolve a provider icon', { providerId: provider.definition.id, err: error })
      }
    }
    // Default: the plugin icon, else the monogram (null).
    try {
      const pluginIcon = await deps.plugins.icon(provider.pluginId)
      if (pluginIcon.kind === 'lobe')
        return deps.icons.lobeRef(`lobe:${pluginIcon.slug}`)
      return { color: `/api/plugins/${encodeURIComponent(provider.pluginId)}/icon?v=${encodeURIComponent(pluginIcon.version)}` }
    }
    catch {
      return null
    }
  }

  async function summarize(provider: RegisteredProvider, config: ProviderConfigRow | null | undefined): Promise<ProviderSummary> {
    const definition = provider.definition
    const providerId = definition.id
    const [credentials, states, stats, icon] = await Promise.all([
      deps.credentials.resolve(providerId).catch((error: unknown) => {
        logger.warn('cannot resolve provider credentials', { providerId, err: error })
        return null
      }),
      deps.credentials.states(providerId).catch((error: unknown): Record<string, CredentialState> => {
        logger.warn('cannot read provider credential states', { providerId, err: error })
        return {}
      }),
      deps.catalog.stats(providerId).catch((error: unknown) => {
        logger.warn('cannot read provider model stats', { providerId, err: error })
        return { modelCount: 0, fetchedAt: null }
      }),
      iconOf(provider),
    ])
    const lastError = config?.lastError ?? null
    const credentialStates: ProviderSummary['credentials'] = {}
    for (const field of definition.credentials)
      credentialStates[field.key] = states[field.key] ?? { set: false, hint: null, source: null }
    return {
      id: providerId,
      name: definition.name,
      pluginId: provider.pluginId,
      icon,
      enabled: isEnabledRow(config),
      status: providerStatus(definition, credentials, lastError),
      credentialFields: definition.credentials.map(field => ({ ...field })),
      credentials: credentialStates,
      keyUrl: definition.keyUrl ?? null,
      local: isLocalProvider(definition),
      modelCount: stats.modelCount,
      modelsFetchedAt: stats.fetchedAt,
      lastError,
      validatedAt: config?.validatedAt ?? null,
    }
  }

  async function get(providerId: string): Promise<ProviderSummary> {
    const provider = requireRegistered(providerId)
    return summarize(provider, await configs.get(providerId))
  }

  async function emitProviderChanged(providerId: string): Promise<void> {
    try {
      const provider = await get(providerId).catch(() => null)
      deps.events.emit('provider.changed', { id: providerId, provider })
    }
    catch (error) {
      logger.warn('cannot emit provider.changed', { providerId, err: error })
    }
  }

  // ---------- errors ----------

  function mapError(providerId: string, error: unknown): HarnessError {
    try {
      if (isHarnessError(error))
        return error instanceof HarnessError ? error : HarnessError.from(error)
      const provider = registered(providerId)
      const definition = provider?.definition
      if (definition?.mapError !== undefined) {
        let custom: unknown
        try {
          custom = definition.mapError(error)
        }
        catch (mapError) {
          logger.warn('provider mapError threw', { providerId, err: mapError })
        }
        const parsed = custom === undefined ? undefined : harnessErrorInitSchema.safeParse(custom)
        if (parsed?.success) {
          const init = parsed.data
          return new HarnessError({ ...init, message: deps.redactor.redactText(init.message), providerId: init.providerId ?? providerId }, { cause: error })
        }
      }
      const init = defaultProviderError(error, {
        providerId,
        providerName: definition?.name ?? providerId,
        redactText: text => deps.redactor.redactText(text),
        now: now(),
      })
      return new HarnessError(init, { cause: error })
    }
    catch {
      return new HarnessError({ code: 'provider_error', message: 'The provider returned an error.', providerId }, { cause: error })
    }
  }

  // ---------- tests ----------

  async function firstCatalogModelId(providerId: string): Promise<string | undefined> {
    const models = await deps.catalog.list({ providerId, includeHidden: false }).catch(() => [])
    return models[0]?.id
  }

  /** Runs the credential test; resolves with the listed model count when the test listed models. */
  async function validate(provider: RegisteredProvider, credentials: ResolvedCredentials, signal: AbortSignal, persist: boolean): Promise<number | undefined> {
    const definition = provider.definition
    const providerId = definition.id
    const rt = runtimeFor(provider, credentials, signal)
    if (definition.validate !== undefined) {
      await definition.validate(rt)
      return undefined
    }
    if (definition.listModels !== undefined) {
      if (persist && isEnabledRow(await configs.get(providerId))) {
        // Stored credentials: the listing becomes the catalog listing (no second request).
        await deps.catalog.refresh(providerId)
        return (await deps.catalog.stats(providerId)).modelCount
      }
      return sanitizeListing(await definition.listModels(rt)).length
    }
    const modelId = definition.smallModelId ?? definition.seedModels?.[0]?.id ?? await firstCatalogModelId(providerId)
    if (modelId === undefined)
      throw new HarnessError({ code: 'provider_error', message: `The provider "${providerId}" has no model to test the credentials with.`, providerId })
    await generateText({
      model: createModel(provider, modelId, rt),
      prompt: 'ping',
      maxOutputTokens: PING_MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      abortSignal: signal,
    })
    return undefined
  }

  function unknownCredentialKeys(definition: ProviderDefinition, values: Record<string, string>): HarnessError | null {
    const known = new Set(definition.credentials.map(field => field.key))
    const unknown = Object.keys(values).filter(key => !known.has(key))
    if (unknown.length === 0)
      return null
    return new HarnessError({
      code: 'validation_error',
      message: `values.${unknown[0]}: Unknown credential field.`,
      details: { issues: unknown.map(key => ({ path: ['values', key], message: 'Unknown credential field.', code: 'unrecognized_keys' })) },
    })
  }

  async function test(providerId: string, values?: Record<string, string>): Promise<ProviderTestResult> {
    const provider = requireRegistered(providerId)
    if (values !== undefined) {
      const invalid = unknownCredentialKeys(provider.definition, values)
      if (invalid !== null)
        throw invalid
    }
    const persist = values === undefined
    const credentials = await deps.credentials.resolve(providerId, values)
    if (credentials.missing.length > 0) {
      const error = notConfigured(providerId, `The provider "${providerId}" is not configured (missing: ${credentials.missing.join(', ')}).`)
      return { ok: false, latencyMs: 0, error: error.toJSON().error }
    }
    const started = performance.now()
    const elapsed = (): number => Math.max(0, Math.round(performance.now() - started))
    let result: ProviderTestResult
    try {
      const modelCount = await withTimeout(options.testTimeoutMs ?? VALIDATE_TIMEOUT_MS, signal => validate(provider, credentials, signal, persist))
      result = { ok: true, latencyMs: elapsed(), ...(modelCount === undefined ? {} : { modelCount }) }
    }
    catch (error) {
      result = { ok: false, latencyMs: elapsed(), error: mapError(providerId, error).toJSON().error }
    }
    if (persist) {
      try {
        const lastError = result.error ?? null
        await configs.update(providerId, {
          lastError,
          status: providerStatus(provider.definition, credentials, lastError),
          ...(result.ok ? { validatedAt: now() } : {}),
        })
      }
      catch (error) {
        logger.warn('cannot store a provider test result', { providerId, err: error })
      }
      await emitProviderChanged(providerId)
    }
    return result
  }

  // ---------- service ----------

  return {
    list: async () => {
      const providers = deps.registry.providers.list()
      const configMap = await configs.all()
      return Promise.all(providers.map(provider => summarize(provider, configMap.get(provider.definition.id))))
    },

    get,

    isEnabled: async (providerId) => {
      if (registered(providerId) === undefined)
        return false
      return isEnabledRow(await configs.get(providerId))
    },

    setEnabled: async (providerId, enabled) => {
      requireRegistered(providerId)
      await configs.update(providerId, { enabled })
      const summary = await get(providerId)
      deps.events.emit('provider.changed', { id: providerId, provider: summary })
      deps.events.emit('catalog.changed', { providerId })
      return summary
    },

    test,

    resolveModel: async (modelRef, resolveOptions: ResolveModelOptions = {}): Promise<ResolvedModel> => {
      const { providerId, modelId } = parseModelRef(modelRef)
      const provider = registered(providerId)
      if (provider === undefined)
        throw new HarnessError({ code: 'not_found', message: `Unknown provider "${providerId}".`, providerId })
      if (!isEnabledRow(await configs.get(providerId)))
        throw notConfigured(providerId, `The provider "${provider.definition.name}" is disabled.`)
      const credentials = await deps.credentials.resolve(providerId)
      if (credentials.missing.length > 0)
        throw notConfigured(providerId, `The provider "${provider.definition.name}" is not configured (missing: ${credentials.missing.join(', ')}).`)
      const entry = await deps.catalog.get(providerId, modelId)
      if (entry === null) {
        throw new HarnessError({
          code: 'model_not_found',
          message: `The model "${modelId}" is not in the catalog of "${provider.definition.name}". Refresh the model list or pick another model.`,
          providerId,
          action: 'refresh-models',
        })
      }
      const model = createModel(provider, modelId, runtimeFor(provider, credentials, resolveOptions.signal))
      return { modelRef: `${providerId}:${modelId}`, providerId, modelId, model, info: catalogModelInfo(entry), entry, provider }
    },

    runtime: async (providerId, runtimeOptions = {}) => {
      const provider = requireRegistered(providerId)
      const credentials = await deps.credentials.resolve(providerId)
      return runtimeFor(provider, credentials, runtimeOptions.signal)
    },

    mapError,

    recordOutcome: async (providerId, outcome) => {
      const config = await configs.get(providerId)
      const before = config?.lastError ?? null
      let after: HarnessErrorInit | null = before
      if (outcome.ok)
        after = null
      else if (STATUS_ERROR_CODES.has(outcome.error.code))
        after = { ...outcome.error, providerId: outcome.error.providerId ?? providerId }
      if (sameJson(before, after))
        return
      await configs.update(providerId, { lastError: after })
      await emitProviderChanged(providerId)
    },
  }
}
