// Test helpers of the credential tests (imported by `*.test.ts` only). The registry (W1.3), the providers service and the
// catalog (W1.4) are built in parallel with the credential service, so these tests run against small in-memory
// stand-ins that follow the frozen interfaces:
// - `createTestRegistry()`: a provider registry holding the real builtin definitions (plus extra test providers);
// - `createTestProviderService(deps)`: builds `ProviderSummary`s from `deps.credentials` (+ `provider_configs`) and
//   records provider tests;
// - `createRecordingCatalog()`: records `refresh()` calls.
import type { Disposable, ProviderDefinition } from '@harness-forge/plugin-sdk'
import type { CatalogModel, PluginContributions, ProviderSummary, ProviderTestResult } from '@harness-forge/shared'
import type { ModelCatalog } from '../../catalog/types.ts'
import type { ProviderService } from '../../providers/types.ts'
import type { RegisteredProvider, Registry } from '../../registry/types.ts'
import type { AppDeps } from '../../types.ts'
import { HarnessError, providerSummarySchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { PROVIDER_DEFINITIONS } from '../../builtin-plugins/core-providers/providers/index.ts'
import { providerConfigs } from '../../db/schema.ts'
import { noopDisposable, notImplementedError, rejectsNotImplemented } from '../../not-implemented.ts'

/** A provider with every credential field type, env fallbacks (one reserved `HF_*` name) and defaults. */
export const ACME_PROVIDER: ProviderDefinition = {
  id: 'acme',
  name: 'Acme AI',
  credentials: [
    { key: 'apiKey', label: 'API key', type: 'secret', required: true, envVar: ['ACME_API_KEY', 'ACME_KEY'] },
    { key: 'region', label: 'Region', type: 'select', options: ['eu', 'us'], default: 'eu' },
    { key: 'org', label: 'Organization', type: 'text' },
    { key: 'baseURL', label: 'Base URL', type: 'url', default: 'https://api.acme.test/v1', advanced: true },
    { key: 'token', label: 'Extra token', type: 'secret', envVar: 'HF_MASTER_KEY' },
  ],
  keyUrl: 'https://acme.test/keys',
  createLanguageModel: () => {
    throw new Error('The test provider has no models.')
  },
}

/** Every builtin provider (owner `core-providers`) followed by `extra` (owner `test-plugin`). */
export function testProviders(extra: readonly ProviderDefinition[] = [ACME_PROVIDER]): RegisteredProvider[] {
  return [
    ...PROVIDER_DEFINITIONS.map(definition => ({ pluginId: 'core-providers', definition })),
    ...extra.map(definition => ({ pluginId: 'test-plugin', definition })),
  ]
}

const EMPTY_CONTRIBUTIONS: PluginContributions = { providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [] }

/** A registry that knows providers only (other registrations are accepted and ignored). */
export function createTestRegistry(providers: readonly RegisteredProvider[] = testProviders()): Registry {
  const byId = new Map(providers.map(provider => [provider.definition.id, provider]))
  const ignore = (): Disposable => noopDisposable
  return {
    providers: {
      register: (pluginId, definition) => {
        if (byId.has(definition.id))
          throw new HarnessError({ code: 'conflict', message: `Provider "${definition.id}" is already registered.`, details: { reason: 'exists' } })
        byId.set(definition.id, { pluginId, definition })
        return { dispose: () => void byId.delete(definition.id) }
      },
      get: id => byId.get(id),
      list: () => [...byId.values()],
    },
    models: { register: ignore, list: () => [] },
    tools: { register: ignore, get: () => undefined, list: () => [] },
    commands: { register: ignore, get: () => undefined, list: () => [] },
    hooks: { on: ignore, list: () => [], run: async () => {} },
    mcpServers: { register: ignore, get: () => undefined, list: () => [] },
    onChange: ignore,
    contributions: () => structuredClone(EMPTY_CONTRIBUTIONS),
  }
}

export interface TestProviderService extends ProviderService {
  /** Provider ids passed to `test()`, in call order. */
  readonly tested: string[]
}

/**
 * `get()` builds a schema-valid `ProviderSummary` from the credential service (status per API.md 4.4, without the
 * catalog); `test()` records the id and answers `testResult`; everything else is not implemented.
 */
export function createTestProviderService(deps: AppDeps, testResult: ProviderTestResult = { ok: true, latencyMs: 1 }): TestProviderService {
  const tested: string[] = []

  async function get(id: string): Promise<ProviderSummary> {
    const provider = deps.registry.providers.get(id)
    if (provider === undefined)
      throw new HarnessError({ code: 'not_found', message: `Unknown provider "${id}".` })
    const { definition, pluginId } = provider
    const credentials = await deps.credentials.states(id)
    const resolved = await deps.credentials.resolve(id)
    const [config] = await deps.db.select().from(providerConfigs).where(eq(providerConfigs.providerId, id)).limit(1)
    const local = !definition.credentials.some(field => field.type === 'secret' && field.required)
    const secretSources = definition.credentials
      .filter(field => field.type === 'secret' && resolved.sources[field.key] !== undefined)
      .map(field => resolved.sources[field.key])
    const lastError = config?.lastError ?? null
    const status = resolved.missing.length > 0 && !local
      ? 'not_configured'
      : lastError?.code === 'auth_invalid' || lastError?.code === 'provider_unreachable'
        ? 'error'
        : secretSources.length > 0 && secretSources.every(source => source === 'env') ? 'env' : 'connected'
    return providerSummarySchema.parse({
      id,
      name: definition.name,
      pluginId,
      icon: null,
      enabled: config?.enabled ?? true,
      status,
      credentialFields: definition.credentials,
      credentials,
      keyUrl: definition.keyUrl ?? null,
      local,
      modelCount: 0,
      modelsFetchedAt: null,
      lastError,
      validatedAt: config?.validatedAt ?? null,
    })
  }

  return {
    tested,
    list: async () => Promise.all(deps.registry.providers.list().map(provider => get(provider.definition.id))),
    get,
    isEnabled: rejectsNotImplemented('providers.isEnabled'),
    setEnabled: rejectsNotImplemented('providers.setEnabled'),
    test: async (id) => {
      tested.push(id)
      return testResult
    },
    resolveModel: rejectsNotImplemented('providers.resolveModel'),
    resolveImageModel: rejectsNotImplemented('providers.resolveImageModel'),
    resolveTranscriptionModel: rejectsNotImplemented('providers.resolveTranscriptionModel'),
    resolveSpeechModel: rejectsNotImplemented('providers.resolveSpeechModel'),
    runtime: rejectsNotImplemented('providers.runtime'),
    mapError: () => notImplementedError('providers.mapError'),
    recordOutcome: rejectsNotImplemented('providers.recordOutcome'),
  }
}

export interface RecordingCatalog extends ModelCatalog {
  /** Provider ids passed to `refresh()`, in call order. */
  readonly refreshed: string[]
}

/** A catalog without models that records `refresh()` calls. */
export function createRecordingCatalog(): RecordingCatalog {
  const refreshed: string[] = []
  return {
    refreshed,
    start: async () => {},
    stop: async () => {},
    list: async () => [],
    get: async () => null,
    refresh: async (providerId): Promise<CatalogModel[]> => {
      refreshed.push(providerId)
      return []
    },
    updatePrefs: async () => {
      throw notImplementedError('catalog.updatePrefs')
    },
    addCustom: async () => {
      throw notImplementedError('catalog.addCustom')
    },
    removeCustom: async () => {
      throw notImplementedError('catalog.removeCustom')
    },
    markUsed: async () => {},
    stats: async () => ({ modelCount: 0, fetchedAt: null }),
  }
}
