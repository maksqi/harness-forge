// The per-plugin `PluginContext` (PLUGINS.md 9 "PluginContext"). Owner: W1.3 (W1.3-T4); `ctx.images` W6.4 (ADR-028);
// `ctx.agents` / `ctx.skills` W10.7 (plugin API 1.4.0, ADR-045); `ctx.outputStyles` (plugin API 1.5.0, ADR-051): a
// P11-0a seam that validates the definition and registers nothing yet (W11.7 wires it to `registry.styles`).
//
// Every `register` goes through the registry with the plugin id as owner and is tracked in the plugin's
// `DisposableStore`; disposing the runtime unregisters everything, and `abort()` aborts `ctx.signal` (disable, reload,
// uninstall, shutdown). After disposal every registration, `ctx.storage`, `ctx.secrets` and `ctx.images` call throws.
// The first use of a capability the manifest does not declare (`network`, `secrets`, `storage`, `hooks`, `process`)
// writes one `warn` entry (permissions are advisory: code runs in-process).
//
// `ctx.images.generate(o)` (plugin API 1.1.0) checks `o`, then calls the image service with `o.modelRef` (the service
// falls back to the `imageModelRef` setting), `n` (default 1), the aspect ratio, `o.chatId` (usage row) and a signal
// that `ctx.signal` and `o.signal` both abort; it maps the stored images to `GeneratedImageFile`s (`costUsd` omitted
// when unknown), passes `modelName` (plugin API 1.2.0: the catalog name, else the model id) and fails with
// `provider_error` when the provider returned no image that could be stored. An unknown provider is
// `provider_not_configured` (plugin API 1.2.0; the resolver's error).
import type {
  AgentDefinition,
  CommandDefinition,
  Disposable,
  HookHandler,
  HookName,
  HostAi,
  ImageGenerateOptions,
  ImageGenerateResult,
  KV,
  McpServerDecl,
  ModelInfo,
  OutputStyleDefinition,
  PluginContext,
  PluginManifest,
  PluginPermission,
  ProviderDefinition,
  SkillDefinition,
  ToolDefinition,
} from '@harness-forge/plugin-sdk'
import type { LogLevel } from '@harness-forge/shared'
import type { LanguageModelInstance } from '../providers/types.ts'
import type { Registry } from '../registry/types.ts'
import type { Redactor } from '../security/types.ts'
import type { ImageGenerationInput, ImageGenerationResult } from '../services/images/types.ts'
import type { SecretScope, SecretStore } from '../services/secrets/types.ts'
import type { PluginStorage } from './state.ts'
import { Buffer } from 'node:buffer'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  declarativeOutputStyleSchema,
  generateImageToolInputSchema,
  HarnessError,
  mcpServerDeclSchema,
  mcpServerDeclSettingsKeys,
  modelRefSchema,
  safeParseModelRef,
  validationError,
} from '@harness-forge/shared'
import { generateText, jsonSchema, tool } from 'ai'
import { z } from 'zod'
import { DisposableStore, toDisposable } from '../registry/disposable.ts'
import { resultModelName } from '../services/images/generation.ts'

/** The host's copies of the libraries a code plugin needs (`ctx.ai`, PLUGINS.md 8). */
export const HOST_AI: HostAi = Object.freeze({
  z,
  tool,
  jsonSchema,
  generateText,
  createOpenAICompatible,
  createAnthropic,
  createOpenAI,
  createGoogleGenerativeAI,
})

/** `ctx.secrets` keys. */
export const SECRET_KEY_PATTERN = /^[\w.:-]{1,128}$/
/** Maximum UTF-8 bytes of one `ctx.secrets` value. */
export const SECRET_VALUE_MAX_BYTES = 16_384
/** Secret names of `ctx.secrets` entries inside the `plugin:<id>` scope (settings use `settings.<key>`). */
export const SECRET_KV_PREFIX = 'kv.'

/** Options of `ctx.images.generate`: the `generate_image` tool input plus the model, the chat and a signal. */
export const imageGenerateOptionsSchema = generateImageToolInputSchema.extend({
  modelRef: modelRefSchema.optional(),
  chatId: z.string().min(1).max(128).optional(),
  signal: z.instanceof(AbortSignal).optional(),
})

/** The message of `ctx.images.generate` when every generated image was refused by `files.saveGenerated`. */
export const NO_STORED_IMAGE_MESSAGE = 'The image model returned no image that could be stored: only PNG, JPEG, WebP and GIF images of at most 20 MB are kept.'

/** `ctx.images.generate` result of an image service result. */
export function toImageGenerateResult(result: ImageGenerationResult): ImageGenerateResult {
  return {
    modelRef: result.modelRef,
    // Plugin API 1.2.0: the catalog name the image service reports, else the model id of `modelRef`.
    modelName: resultModelName(result),
    images: result.images.map(({ file, url }) => ({ fileId: file.id, url, mediaType: file.mime, name: file.name, size: file.size })),
    ...(result.costUsd === null ? {} : { costUsd: result.costUsd }),
    ...(result.revisedPrompt === undefined ? {} : { revisedPrompt: result.revisedPrompt }),
  }
}

export interface PluginRuntimeServices {
  readonly registry: Registry
  readonly secrets: SecretStore
  /** `ctx.storage` backend of this plugin (`createPluginStorage`). */
  readonly storage: PluginStorage
  readonly redactor: Redactor
  /** The plugin log (bound to the plugin id). */
  readonly log: (level: LogLevel, message: string, data?: unknown) => void
  /** `ctx.models.resolve` (`ProviderService.resolveModel`). */
  readonly resolveModel: (ref: string, signal: AbortSignal) => Promise<LanguageModelInstance>
  /** `ctx.images.generate` (`ImageService.generate`, ADR-028). */
  readonly generateImages: (input: ImageGenerationInput) => Promise<ImageGenerationResult>
  /** Default `User-Agent` of `ctx.fetch`: `harness-forge/<appVersion> plugin/<id>`. */
  readonly userAgent: string
  /** Default `globalThis.fetch` (tests inject a fake). */
  readonly fetch?: typeof globalThis.fetch
}

export interface PluginRuntimeOptions {
  readonly manifest: PluginManifest
  /** Absolute realpath of the plugin directory (builtins: their source directory). */
  readonly dir: string
  /** `data/plugins/.data/<id>/` (created by the host before `setup`). */
  readonly dataDir: string
  /** Initial settings: stored values over defaults, secrets decrypted. */
  readonly settings: Record<string, unknown>
  readonly services: PluginRuntimeServices
}

/** Runs one `settings.onChange` callback (the host guards it: 3 s). */
export type SettingsCallbackRunner = (callback: (values: Record<string, unknown>) => void | Promise<void>, values: Record<string, unknown>) => Promise<void>

/** A loaded plugin's context and its lifecycle handles. */
export interface PluginRuntime {
  readonly pluginId: string
  readonly ctx: PluginContext
  readonly signal: AbortSignal
  readonly isDisposed: boolean
  /** Current settings (defaults + stored + decrypted secrets). */
  readonly settings: () => Record<string, unknown>
  /** Replaces the settings, runs every `onChange` callback and re-registers MCP servers that use `{{settings.*}}`. */
  readonly updateSettings: (values: Record<string, unknown>, run: SettingsCallbackRunner) => Promise<void>
  /** Unregisters every contribution; later registrations throw. Does not abort `ctx.signal`. */
  readonly disposeContributions: () => void
  /** Aborts `ctx.signal` (after `disposeContributions`). */
  readonly abort: (reason?: unknown) => void
}

/** Re-registrable MCP server declaration: settings changes re-register it so the MCP manager reconnects. */
class McpRegistration implements Disposable {
  #current: Disposable | null

  constructor(private readonly registry: Registry, private readonly pluginId: string, readonly decl: McpServerDecl) {
    this.#current = registry.mcpServers.register(pluginId, decl)
  }

  get usesSettings(): boolean {
    return mcpServerDeclSettingsKeys(this.decl).length > 0
  }

  refresh(): void {
    if (this.#current === null)
      return
    this.#current.dispose()
    this.#current = this.registry.mcpServers.register(this.pluginId, this.decl)
  }

  dispose(): void {
    this.#current?.dispose()
    this.#current = null
  }
}

function disposedError(pluginId: string): HarnessError {
  return new HarnessError({
    code: 'plugin_error',
    message: `The plugin "${pluginId}" is no longer loaded: its ctx cannot be used anymore.`,
    details: { pluginId, phase: 'setup' },
  })
}

function invalidInput(message: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message })
}

/** Builds the context of one load of a plugin. */
export function createPluginRuntime(options: PluginRuntimeOptions): PluginRuntime {
  const { manifest, services } = options
  const pluginId = manifest.id
  const { registry } = services
  const controller = new AbortController()
  const store = new DisposableStore(error => services.log('warn', 'A registration failed to dispose.', { error }))
  const settingsCallbacks = new Set<(values: Record<string, unknown>) => void | Promise<void>>()
  const mcpRegistrations = new Set<McpRegistration>()
  const declared = new Set<PluginPermission>(manifest.permissions ?? [])
  const warned = new Set<PluginPermission>()
  const secretScope: SecretScope = `plugin:${pluginId}`
  const settingsKeys = new Set(Object.keys(manifest.settings?.properties ?? {}))
  let settings = structuredClone(options.settings)

  const assertLive = (): void => {
    if (store.isDisposed)
      throw disposedError(pluginId)
  }
  const uses = (permission: PluginPermission, what: string): void => {
    if (declared.has(permission) || warned.has(permission))
      return
    warned.add(permission)
    services.log('warn', `The plugin uses ${what} without declaring the "${permission}" permission in plugin.json.`)
  }
  const track = (registration: Disposable): Disposable => store.add(registration)

  const logger: PluginContext['logger'] = {
    debug: (message, data) => services.log('debug', String(message), data),
    info: (message, data) => services.log('info', String(message), data),
    warn: (message, data) => services.log('warn', String(message), data),
    error: (message, data) => services.log('error', String(message), data),
  }

  const secretsKv = {
    get: async (key: string) => {
      assertLive()
      uses('secrets', 'ctx.secrets')
      checkSecretKey(key)
      const value = await services.secrets.get(secretScope, `${SECRET_KV_PREFIX}${key}`)
      if (value === null)
        return undefined
      services.redactor.addSecret(value)
      return value
    },
    set: async (key: string, value: string) => {
      assertLive()
      uses('secrets', 'ctx.secrets')
      checkSecretKey(key)
      if (typeof value !== 'string')
        throw invalidInput('Secret values must be strings.')
      if (Buffer.byteLength(value, 'utf8') > SECRET_VALUE_MAX_BYTES)
        throw new HarnessError({ code: 'payload_too_large', message: 'A secret value is limited to 16 KB.', details: { limitBytes: SECRET_VALUE_MAX_BYTES } })
      services.redactor.addSecret(value)
      await services.secrets.set(secretScope, `${SECRET_KV_PREFIX}${key}`, value)
    },
    delete: async (key: string) => {
      assertLive()
      uses('secrets', 'ctx.secrets')
      checkSecretKey(key)
      await services.secrets.delete(secretScope, `${SECRET_KV_PREFIX}${key}`)
    },
    list: async (prefix?: string) => {
      assertLive()
      uses('secrets', 'ctx.secrets')
      const entries = await services.secrets.list(secretScope)
      return entries
        .map(entry => entry.name)
        .filter(name => name.startsWith(SECRET_KV_PREFIX))
        .map(name => name.slice(SECRET_KV_PREFIX.length))
        .filter(key => prefix === undefined || key.startsWith(prefix))
        .sort()
    },
  } as KV<string>

  const storageKv = {
    get: async (key: string) => {
      assertLive()
      uses('storage', 'ctx.storage')
      return services.storage.get(key)
    },
    set: async (key: string, value: unknown) => {
      assertLive()
      uses('storage', 'ctx.storage')
      await services.storage.set(key, value)
    },
    delete: async (key: string) => {
      assertLive()
      uses('storage', 'ctx.storage')
      await services.storage.delete(key)
    },
    list: async (prefix?: string) => {
      assertLive()
      uses('storage', 'ctx.storage')
      return services.storage.list(prefix)
    },
  } as KV

  const baseFetch = services.fetch ?? globalThis.fetch
  const pluginFetch: typeof globalThis.fetch = async (input, init) => {
    uses('network', 'ctx.fetch')
    const request = input instanceof Request ? input : undefined
    const headers = new Headers(init?.headers ?? request?.headers)
    if (!headers.has('user-agent'))
      headers.set('user-agent', services.userAgent)
    const callerSignal = init?.signal ?? request?.signal
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal
    return baseFetch(input, { ...init, headers, signal })
  }

  const ctx: PluginContext = {
    plugin: Object.freeze({ id: pluginId, version: manifest.version, dir: options.dir, dataDir: options.dataDir }),
    logger: Object.freeze(logger),
    signal: controller.signal,
    settings: Object.freeze({
      get: <T = Record<string, unknown>>() => structuredClone(settings) as T,
      onChange: (callback: (values: Record<string, unknown>) => void | Promise<void>) => {
        assertLive()
        if (typeof callback !== 'function')
          throw invalidInput('settings.onChange needs a function.')
        settingsCallbacks.add(callback)
        return track(toDisposable(() => {
          settingsCallbacks.delete(callback)
        }))
      },
    }),
    secrets: Object.freeze(secretsKv),
    storage: Object.freeze(storageKv),
    providers: Object.freeze({
      register: (definition: ProviderDefinition) => {
        assertLive()
        return track(registry.providers.register(pluginId, definition))
      },
    }),
    models: Object.freeze({
      register: (providerId: string, models: ModelInfo[]) => {
        assertLive()
        return track(registry.models.register(pluginId, providerId, models))
      },
      resolve: async (ref: string) => {
        assertLive()
        return services.resolveModel(ref, controller.signal)
      },
    }),
    tools: Object.freeze({
      register: <I, O>(definition: ToolDefinition<I, O>) => {
        assertLive()
        return track(registry.tools.register(pluginId, definition as ToolDefinition))
      },
    }),
    mcp: Object.freeze({
      register: (decl: McpServerDecl) => {
        assertLive()
        const parsed = mcpServerDeclSchema.safeParse(decl)
        if (parsed.success) {
          for (const key of mcpServerDeclSettingsKeys(parsed.data)) {
            if (!settingsKeys.has(key))
              throw invalidInput(`MCP server "${parsed.data.id}": "{{settings.${key}}}" refers to an undefined setting.`)
          }
          if (parsed.data.transport.type === 'stdio')
            uses('process', `the stdio MCP server "${parsed.data.id}"`)
        }
        const registration = new McpRegistration(registry, pluginId, parsed.success ? parsed.data : decl)
        mcpRegistrations.add(registration)
        const handle = track(registration)
        return toDisposable(() => {
          mcpRegistrations.delete(registration)
          handle.dispose()
        })
      },
    }),
    commands: Object.freeze({
      register: (definition: CommandDefinition) => {
        assertLive()
        return track(registry.commands.register(pluginId, definition))
      },
    }),
    // Plugin API 1.4.0 (ADR-045): agent types and skills, validated by the registry (`validation_error` naming the
    // field; a name another plugin registered throws `conflict`) and owned by this plugin.
    agents: Object.freeze({
      register: (definition: AgentDefinition): Disposable => {
        assertLive()
        return track(registry.agents.register(pluginId, definition))
      },
    }),
    skills: Object.freeze({
      register: (definition: SkillDefinition): Disposable => {
        assertLive()
        return track(registry.skills.register(pluginId, definition))
      },
    }),
    // Plugin API 1.5.0 (ADR-051): output styles, validated like `contributes.outputStyles` (`validation_error` naming the
    // field). P11-0a seam: nothing is registered yet; W11.7 registers them in `registry.styles` (a `conflict` for a name
    // another plugin registered).
    outputStyles: Object.freeze({
      register: (definition: OutputStyleDefinition): Disposable => {
        assertLive()
        const parsed = declarativeOutputStyleSchema.safeParse(definition)
        if (!parsed.success)
          throw validationError(parsed.error)
        return track(toDisposable(() => {}))
      },
    }),
    hooks: Object.freeze({
      on: <K extends HookName>(name: K, handler: HookHandler<K>, hookOptions?: { priority?: number }) => {
        assertLive()
        uses('hooks', 'ctx.hooks')
        return track(registry.hooks.on(pluginId, name, handler, hookOptions))
      },
    }),
    ai: HOST_AI,
    fetch: pluginFetch,
    // Plugin API 1.1.0 (ADR-028).
    images: Object.freeze({
      generate: async (options: ImageGenerateOptions) => {
        assertLive()
        const parsed = imageGenerateOptionsSchema.safeParse(options)
        if (!parsed.success)
          throw validationError(parsed.error)
        const { prompt, modelRef, n, aspectRatio, chatId, signal } = parsed.data
        const result = await services.generateImages({
          ...(modelRef === undefined ? {} : { modelRef }),
          prompt,
          n: n ?? 1,
          ...(aspectRatio === undefined ? {} : { aspectRatio }),
          signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
          chatId: chatId ?? null,
          messageId: null,
        })
        if (result.images.length === 0) {
          const providerId = safeParseModelRef(result.modelRef)?.providerId
          throw new HarnessError({ code: 'provider_error', message: NO_STORED_IMAGE_MESSAGE, ...(providerId === undefined ? {} : { providerId }) })
        }
        return toImageGenerateResult(result)
      },
    }),
  }

  return {
    pluginId,
    ctx: Object.freeze(ctx),
    signal: controller.signal,
    get isDisposed() {
      return store.isDisposed
    },
    settings: () => settings,
    updateSettings: async (values, run) => {
      settings = structuredClone(values)
      for (const callback of [...settingsCallbacks])
        await run(callback, structuredClone(values))
      for (const registration of [...mcpRegistrations]) {
        if (!registration.usesSettings)
          continue
        try {
          registration.refresh()
        }
        catch (error) {
          services.log('warn', `The MCP server "${registration.decl.id}" could not be re-registered after a settings change.`, { error })
        }
      }
    },
    disposeContributions: () => {
      store.dispose()
      settingsCallbacks.clear()
      mcpRegistrations.clear()
    },
    abort: (reason) => {
      if (!controller.signal.aborted)
        controller.abort(reason)
    },
  }
}

function checkSecretKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !SECRET_KEY_PATTERN.test(key))
    throw invalidInput('Secret keys use 1-128 characters of A-Z, a-z, 0-9, ".", "_", ":" and "-".')
}
