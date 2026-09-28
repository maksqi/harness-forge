// Test harness of the providers / catalog / icons services (W1.4). The registry, credential service and plugin host are
// implemented by W1.3 / W1.2 in parallel, so these tests run against small in-memory fakes of their frozen interfaces:
// `createProvidersTestApp()` is `createTestApp()` with a fake registry, fake credentials (stored values in memory, env
// fallback from `env.vars`, defaults), a fake plugin host that runs the builtin plugins' `setup` against the fake
// registry, a recording event bus and the catalog without background work. Never imported by production code.
import type {
  CommandDefinition,
  Disposable,
  HookHandler,
  HookName,
  HostAi,
  KV,
  McpServerDecl,
  ModelInfo,
  PluginContext,
  ProviderDefinition,
  ToolDefinition,
} from '@harness-forge/plugin-sdk'
import type { CredentialState, CredentialValues, LogLevel, PluginContributions } from '@harness-forge/shared'
import type { ModelCatalogOptions } from '../catalog/index.ts'
import type { ServiceFactories } from '../deps.ts'
import type { PluginHost } from '../plugins/types.ts'
import type {
  RegisteredCommand,
  RegisteredHook,
  RegisteredMcpServer,
  RegisteredModels,
  RegisteredProvider,
  RegisteredTool,
  Registry,
  RegistryChange,
} from '../registry/types.ts'
import type { CredentialService, CredentialValueSource, ResolvedCredentials } from '../services/secrets/types.ts'
import type { TestApp, TestAppOptions } from '../testing/create-test-app.ts'
import type { RecordingEventBus } from '../testing/fakes.ts'
import type { AppDeps } from '../types.ts'
import type { ProviderServiceOptions } from './index.ts'
import { fileURLToPath } from 'node:url'
import { HarnessError } from '@harness-forge/shared'
import { generateText, jsonSchema, tool } from 'ai'
import { z } from 'zod'
import { createModelCatalogWith } from '../catalog/index.ts'
import { rejectsNotImplemented, throwsNotImplemented } from '../not-implemented.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createRecordingEventBus } from '../testing/fakes.ts'
import { createProviderServiceWith } from './index.ts'

/** The small models.dev snapshot used by the catalog tests. */
export const MODELS_DEV_FIXTURE = fileURLToPath(new URL('../catalog/__fixtures__/models-dev.json', import.meta.url))

function conflict(message: string): HarnessError {
  return new HarnessError({ code: 'conflict', message, details: { reason: 'exists' } })
}

// ---------- registry ----------

export interface FakeRegistry extends Registry {
  /** Every change so far. */
  readonly changes: RegistryChange[]
}

/** An in-memory registry with the semantics of `registry/types.ts` that the W1.4 services rely on. */
export function createFakeRegistry(): FakeRegistry {
  const providers = new Map<string, RegisteredProvider>()
  const models: RegisteredModels[] = []
  const tools = new Map<string, RegisteredTool>()
  const commands = new Map<string, RegisteredCommand>()
  const hooks: RegisteredHook[] = []
  const mcpServers = new Map<string, RegisteredMcpServer>()
  const listeners = new Set<(change: RegistryChange) => void>()
  const changes: RegistryChange[] = []

  function notify(change: RegistryChange): void {
    changes.push(change)
    for (const listener of [...listeners])
      listener(change)
  }

  function disposable(remove: () => void): Disposable {
    let disposed = false
    return {
      dispose: () => {
        if (disposed)
          return
        disposed = true
        remove()
      },
    }
  }

  return {
    changes,
    providers: {
      register: (pluginId, definition) => {
        if (providers.has(definition.id))
          throw conflict(`Provider "${definition.id}" is already registered.`)
        providers.set(definition.id, { pluginId, definition })
        notify({ kind: 'provider', action: 'added', pluginId, key: definition.id })
        return disposable(() => {
          providers.delete(definition.id)
          notify({ kind: 'provider', action: 'removed', pluginId, key: definition.id })
        })
      },
      get: id => providers.get(id),
      list: () => [...providers.values()],
    },
    models: {
      register: (pluginId, providerId, list) => {
        const registration: RegisteredModels = { pluginId, providerId, models: [...list] }
        models.push(registration)
        notify({ kind: 'models', action: 'added', pluginId, key: providerId })
        return disposable(() => {
          models.splice(models.indexOf(registration), 1)
          notify({ kind: 'models', action: 'removed', pluginId, key: providerId })
        })
      },
      list: providerId => (providers.has(providerId) ? models.filter(entry => entry.providerId === providerId) : []),
    },
    tools: {
      register: (pluginId, definition, options = {}) => {
        if (tools.has(definition.name))
          throw conflict(`Tool "${definition.name}" is already registered.`)
        tools.set(definition.name, { pluginId, definition, mcpServerId: options.mcpServerId ?? null, title: options.title ?? null })
        notify({ kind: 'tool', action: 'added', pluginId, key: definition.name })
        return disposable(() => {
          tools.delete(definition.name)
          notify({ kind: 'tool', action: 'removed', pluginId, key: definition.name })
        })
      },
      get: name => tools.get(name),
      list: () => [...tools.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name)),
    },
    commands: {
      register: (pluginId, definition) => {
        if (commands.has(definition.name))
          throw conflict(`Command "${definition.name}" is already registered.`)
        commands.set(definition.name, { pluginId, definition })
        return disposable(() => commands.delete(definition.name))
      },
      get: name => commands.get(name),
      list: () => [...commands.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name)),
    },
    hooks: {
      on: (pluginId, name, handler, options = {}) => {
        const hook = { pluginId, name, handler, priority: options.priority ?? 0 } as RegisteredHook
        hooks.push(hook)
        return disposable(() => hooks.splice(hooks.indexOf(hook), 1))
      },
      list: <K extends HookName>(name: K) => hooks.filter(hook => hook.name === name) as unknown as RegisteredHook<K>[],
      run: async () => {},
    },
    mcpServers: {
      register: (pluginId, decl) => {
        if (mcpServers.has(decl.id))
          throw conflict(`MCP server "${decl.id}" is already registered.`)
        mcpServers.set(decl.id, { pluginId, decl })
        return disposable(() => mcpServers.delete(decl.id))
      },
      get: id => mcpServers.get(id),
      list: () => [...mcpServers.values()],
    },
    onChange: (listener) => {
      listeners.add(listener)
      return disposable(() => listeners.delete(listener))
    },
    contributions: (pluginId): PluginContributions => ({
      providers: [...providers.values()].filter(entry => entry.pluginId === pluginId).map(entry => entry.definition.id),
      models: models.filter(entry => entry.pluginId === pluginId).reduce((total, entry) => total + entry.models.length, 0),
      tools: [...tools.values()].filter(entry => entry.pluginId === pluginId).map(entry => entry.definition.name),
      mcpServers: [...mcpServers.values()].filter(entry => entry.pluginId === pluginId).map(entry => entry.decl.id),
      commands: [...commands.values()].filter(entry => entry.pluginId === pluginId).map(entry => entry.definition.name),
      hooks: [...new Set(hooks.filter(entry => entry.pluginId === pluginId).map(entry => entry.name))],
    }),
  }
}

// ---------- credentials ----------

export interface FakeCredentialService extends CredentialService {
  /** Stored values by provider id (secrets and options alike). */
  readonly stored: Map<string, Record<string, string>>
}

function hintOf(value: string): string | null {
  return value.length >= 12 ? `${value.slice(0, 3)}…${value.slice(-4)}` : null
}

/** In-memory credentials with the resolution order of W1.2: override -> stored -> env var (first non-empty) -> default. */
export function createFakeCredentialService(deps: AppDeps): FakeCredentialService {
  const stored = new Map<string, Record<string, string>>()

  function definitionOf(providerId: string): ProviderDefinition {
    const registered = deps.registry.providers.get(providerId)
    if (registered === undefined)
      throw new HarnessError({ code: 'not_found', message: `Unknown provider "${providerId}".` })
    return registered.definition
  }

  function envValue(envVar: string | string[] | undefined): string | undefined {
    const names = envVar === undefined ? [] : Array.isArray(envVar) ? envVar : [envVar]
    for (const name of names) {
      const value = deps.env.vars[name]?.trim()
      if (value)
        return value
    }
    return undefined
  }

  function resolve(providerId: string, overrides: Record<string, string> = {}): ResolvedCredentials {
    const definition = definitionOf(providerId)
    const values: Record<string, string> = {}
    const sources: Record<string, CredentialValueSource> = {}
    const missing: string[] = []
    const own = stored.get(providerId) ?? {}
    for (const field of definition.credentials) {
      const override = overrides[field.key]
      const storedValue = override !== undefined ? (override.trim() || undefined) : own[field.key]
      const env = envValue(field.envVar)
      if (storedValue !== undefined) {
        values[field.key] = storedValue
        sources[field.key] = 'stored'
      }
      else if (env !== undefined) {
        values[field.key] = env
        sources[field.key] = 'env'
      }
      else if (field.default !== undefined) {
        values[field.key] = field.default
        sources[field.key] = 'default'
      }
      else if (field.required === true) {
        missing.push(field.key)
      }
    }
    return { values, sources, missing }
  }

  return {
    stored,
    resolve: async (providerId, overrides) => resolve(providerId, overrides),
    states: async (providerId) => {
      const definition = definitionOf(providerId)
      const resolved = resolve(providerId)
      const states: Record<string, CredentialState> = {}
      for (const field of definition.credentials) {
        const value = resolved.values[field.key]
        const source = resolved.sources[field.key]
        const set = value !== undefined && source !== 'default'
        const state: CredentialState = { set, hint: set && field.type === 'secret' ? hintOf(value) : null, source: set ? (source === 'env' ? 'env' : 'stored') : null }
        if (field.type !== 'secret' && value !== undefined)
          state.value = value
        states[field.key] = state
      }
      return states
    },
    set: async (providerId, values: CredentialValues) => {
      const definition = definitionOf(providerId)
      const own = { ...stored.get(providerId) }
      for (const [key, value] of Object.entries(values)) {
        if (!definition.credentials.some(field => field.key === key))
          throw new HarnessError({ code: 'validation_error', message: `Unknown credential field "${key}".` })
        if (value === '')
          delete own[key]
        else
          own[key] = value
      }
      stored.set(providerId, own)
    },
    clear: async (providerId) => {
      definitionOf(providerId)
      stored.delete(providerId)
    },
  }
}

// ---------- plugin host ----------

export interface FakePluginHost extends PluginHost {
  /** Plugin log entries written through `log()`. */
  readonly logEntries: { pluginId: string, level: LogLevel, message: string }[]
}

function memoryKv<V>(): KV<V> {
  const values = new Map<string, V>()
  return {
    get: async <T extends V = V>(key: string) => values.get(key) as T | undefined,
    set: async (key, value) => {
      values.set(key, value)
    },
    delete: async (key) => {
      values.delete(key)
    },
    list: async prefix => [...values.keys()].filter(key => prefix === undefined || key.startsWith(prefix)),
  }
}

/** Runs each builtin's `setup` against the (fake) registry; no guard, state machine or user plugins. */
export function createFakePluginHost(deps: AppDeps): FakePluginHost {
  const logEntries: FakePluginHost['logEntries'] = []
  const registrations: Disposable[] = []
  const controller = new AbortController()

  function track(entry: Disposable): Disposable {
    registrations.push(entry)
    return entry
  }

  function contextOf(pluginId: string, version: string): PluginContext {
    const noop = (): void => {}
    return {
      plugin: { id: pluginId, version, dir: deps.env.dataDir, dataDir: deps.env.paths.pluginData },
      logger: { debug: noop, info: noop, warn: noop, error: noop },
      signal: controller.signal,
      settings: { get: <T>() => ({}) as T, onChange: () => ({ dispose: noop }) },
      secrets: memoryKv<string>(),
      storage: memoryKv<unknown>(),
      providers: { register: (definition: ProviderDefinition) => track(deps.registry.providers.register(pluginId, definition)) },
      models: {
        register: (providerId: string, list: ModelInfo[]) => track(deps.registry.models.register(pluginId, providerId, list)),
        resolve: async (ref: string) => (await deps.providers.resolveModel(ref)).model,
      },
      tools: { register: <I, O>(definition: ToolDefinition<I, O>) => track(deps.registry.tools.register(pluginId, definition as ToolDefinition)) },
      mcp: { register: (decl: McpServerDecl) => track(deps.registry.mcpServers.register(pluginId, decl)) },
      commands: { register: (definition: CommandDefinition) => track(deps.registry.commands.register(pluginId, definition)) },
      hooks: {
        on: <K extends HookName>(name: K, handler: HookHandler<K>, options?: { priority?: number }) =>
          track(deps.registry.hooks.on(pluginId, name, handler, options)),
      },
      ai: { z, tool, jsonSchema, generateText } as unknown as HostAi,
      fetch: globalThis.fetch,
    }
  }

  return {
    logEntries,
    start: async () => {
      for (const builtin of deps.builtins)
        await builtin.module.setup(contextOf(builtin.id, builtin.manifest.version))
    },
    stop: async () => {
      controller.abort()
      for (const registration of registrations.splice(0).reverse())
        registration.dispose()
    },
    list: rejectsNotImplemented('fake plugins.list'),
    get: rejectsNotImplemented('fake plugins.get'),
    summary: rejectsNotImplemented('fake plugins.summary'),
    record: async () => null,
    state: () => 'active',
    isActive: () => true,
    directory: async () => null,
    enable: rejectsNotImplemented('fake plugins.enable'),
    disable: rejectsNotImplemented('fake plugins.disable'),
    reload: rejectsNotImplemented('fake plugins.reload'),
    uninstall: rejectsNotImplemented('fake plugins.uninstall'),
    trust: rejectsNotImplemented('fake plugins.trust'),
    getSettings: rejectsNotImplemented('fake plugins.getSettings'),
    updateSettings: rejectsNotImplemented('fake plugins.updateSettings'),
    settingsValues: async () => ({}),
    logs: async () => [],
    icon: async (id) => {
      throw new HarnessError({ code: 'not_found', message: `Plugin "${id}" has no icon.` })
    },
    guard: async (_pluginId, fn) => fn(new AbortController().signal),
    log: (pluginId, level, message) => {
      logEntries.push({ pluginId, level, message })
    },
    inspectDirectory: rejectsNotImplemented('fake plugins.inspectDirectory'),
    saveRecord: rejectsNotImplemented('fake plugins.saveRecord'),
    load: rejectsNotImplemented('fake plugins.load'),
    unload: async () => {},
    forget: async () => {},
    compile: rejectsNotImplemented('fake plugins.compile'),
    withoutWatch: async (_id, fn) => fn(),
    declarativeProvider: throwsNotImplemented('fake plugins.declarativeProvider'),
  }
}

// ---------- test app ----------

export interface ProvidersTestAppOptions extends TestAppOptions {
  /** Options of the catalog (default: no background work, the fixture snapshot, no refresh dedupe). */
  catalog?: ModelCatalogOptions
  /** Options of the provider service. */
  providerService?: ProviderServiceOptions
}

export interface ProvidersTestApp extends TestApp {
  events: RecordingEventBus
  registry: FakeRegistry
  credentials: FakeCredentialService
  plugins: FakePluginHost
}

/** `createTestApp()` wired with the fakes above and the real W1.4 services. */
export async function createProvidersTestApp(options: ProvidersTestAppOptions = {}): Promise<ProvidersTestApp> {
  const events = createRecordingEventBus()
  const registry = createFakeRegistry()
  const factories: Partial<ServiceFactories> = {
    credentials: createFakeCredentialService,
    plugins: createFakePluginHost,
    catalog: deps => createModelCatalogWith(deps, { background: false, bundledSnapshotPath: MODELS_DEV_FIXTURE, refreshDedupeMs: 0, ...options.catalog }),
    providers: deps => createProviderServiceWith(deps, options.providerService ?? {}),
    ...options.factories,
  }
  const t = await createTestApp({ ...options, overrides: { events, registry, ...options.overrides }, factories })
  return {
    ...t,
    events,
    registry,
    credentials: t.deps.credentials as FakeCredentialService,
    plugins: t.deps.plugins as FakePluginHost,
  }
}
