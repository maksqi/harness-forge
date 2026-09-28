/* eslint-disable ts/method-signature-style -- PLUGINS.md section 9 is authoritative and uses method signatures: they
   keep parameters bivariant, so the host can store `ToolDefinition<I, O>` values as `ToolDefinition` without casts. */
// Runtime plugin API (PLUGINS.md section 9). The plugin data shapes and enums come from `@harness-forge/shared`
// (ADR-018) and are re-exported unchanged by `index.ts`.
import type { createAnthropic } from '@ai-sdk/anthropic'
import type { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { createOpenAI } from '@ai-sdk/openai'
import type { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV3, LanguageModelV4, SharedV4ProviderOptions } from '@ai-sdk/provider'
import type {
  CredentialField,
  HarnessErrorInit,
  McpServerDecl,
  ModelInfo,
  ReasoningEffort,
  ToolMode,
  ToolPolicy,
} from '@harness-forge/shared'
import type {
  FlexibleSchema,
  generateText,
  jsonSchema,
  LanguageModel,
  LanguageModelCallOptions,
  LanguageModelUsage,
  ModelMessage,
  tool,
  Tool,
  UIMessage,
} from 'ai'
import type { z } from 'zod'

/** Same type as the AI SDK `ProviderOptions` (`ai` does not re-export it). */
export type ProviderOptions = SharedV4ProviderOptions

/**
 * AI SDK v7 top-level `reasoning` values without `provider-default`:
 * `'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`.
 */
export type ReasoningLevel = Exclude<NonNullable<LanguageModelCallOptions['reasoning']>, 'provider-default'>

// ---------- providers ----------

export interface ProviderRuntime {
  /**
   * Resolved values of every declared field: stored value -> environment variable (`envVar`, builtin and code plugins
   * only) -> `default`; unresolved optional fields are absent.
   */
  credentials: Record<string, string>
  /**
   * Host `fetch` for provider requests: aborted with the run (or the guard timeout), follows at most 5 same-origin
   * redirects (cross-origin redirects fail with `provider_error`), logs method + URL at `debug`.
   */
  fetch: typeof globalThis.fetch
  /** The run signal for `createLanguageModel`, the guard signal for `listModels` / `validate`. */
  signal?: AbortSignal
}

/** Request additions returned by `ProviderDefinition.reasoning()`. */
export interface ReasoningParams {
  /** AI SDK v7 top-level `reasoning` call option. */
  reasoning?: ReasoningLevel
  /** Deep-merged into the call's provider options (reasoning settings here win over `reasoning`). */
  providerOptions?: ProviderOptions
  /** Overrides the call value. */
  maxOutputTokens?: number
}

export interface ProviderDefinition {
  /** Builtins: models.dev keys; plugins: `<pluginId>` or `<pluginId>-<suffix>`. */
  id: string
  /** UI name (Settings -> Providers, picker group header). */
  name: string
  /** `lobe:<slug>`; default: the plugin icon, else a monogram. */
  icon?: string
  /** Fields of the key dialog; `[]` for keyless providers. */
  credentials: CredentialField[]
  /** models.dev key for metadata (default: `id`). */
  modelsDevId?: string
  /** Cheap model for chat titles and the default credential ping. */
  smallModelId?: string
  /** Used when there is no live listing and no cached listing. */
  seedModels?: ModelInfo[]
  /** "Get a key" link of the key dialog. */
  keyUrl?: string
  /**
   * Returns a provider instance model (never a string id); called per request; must not perform network I/O;
   * guarded (5 s); any model id may be requested (custom ids).
   */
  createLanguageModel(modelId: string, rt: ProviderRuntime): LanguageModelV4 | LanguageModelV3
  /** Live listing; guarded (15 s); cached 24 h; a failure keeps the last good listing. */
  listModels?(rt: ProviderRuntime): Promise<ModelInfo[]>
  /** Credential test; guarded (15 s). Default: `listModels`, else a 1-token `generateText` on `smallModelId`. */
  validate?(rt: ProviderRuntime): Promise<void>
  /**
   * Synchronous; called only when `effort !== 'auto'`, `model.capabilities.reasoning` is true and the effort is
   * offered for the model; returns request additions or `undefined`.
   */
  reasoning?(effort: ReasoningEffort, model: ModelInfo): ReasoningParams | undefined
  /** Synchronous; first chance to map an error of this provider; `undefined` falls back to the default mapping. */
  mapError?(err: unknown): HarnessErrorInit | undefined
}

// ---------- tools ----------

/**
 * The AI SDK tool result output union (`text`, `json`, `execution-denied`, `error-text`, `error-json`, `content`);
 * `ai` does not export the name, so it is derived.
 */
export type ToolResultOutput = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>

export interface ToolCallContext {
  chatId: string
  modelRef: string
  toolCallId: string
  /** Messages sent to the model for this step (read-only). */
  messages: ModelMessage[]
  /** Aborted on stop, timeout, or plugin disable. */
  signal: AbortSignal
}

/**
 * A policy function `(input, c) => ToolPolicy | 'deny'` (or a promise of it): guarded (3 s); a throw or timeout is
 * treated as `always`. Declared through a method signature so `ToolDefinition<I, O>` stays assignable to
 * `ToolDefinition`.
 */
export type ToolPolicyFunction<I = unknown> = {
  policy(input: I, c: ToolCallContext): ToolPolicy | 'deny' | Promise<ToolPolicy | 'deny'>
}['policy']

export interface ToolDefinition<I = unknown, O = unknown> {
  /** `^[a-zA-Z0-9_-]{1,64}$`, globally unique; the prefix `mcp__` is reserved. */
  name: string
  /** Sent to the model (<= 1024 characters). */
  description: string
  /** A JSON object schema: `ctx.ai.z.object(...)` or `ctx.ai.jsonSchema(...)`. */
  inputSchema: FlexibleSchema<I>
  /** Default `ask`. */
  policy?: ToolPolicy | ToolPolicyFunction<I>
  /** Default 60_000, max 600_000. */
  timeoutMs?: number
  /** The output must be JSON-serializable; capped at 64 KB of serialized JSON. */
  execute(input: I, c: ToolCallContext): Promise<O>
  /** Converts the stored output for the model; fast and deterministic (guarded, 3 s). */
  toModelOutput?(output: O, c: { toolCallId: string, input: I }): ToolResultOutput | Promise<ToolResultOutput>
}

// ---------- commands ----------

export interface CommandRunInput {
  /** Text after `/name ` (trimmed). */
  input: string
  chatId: string
  signal: AbortSignal
}

/** `prompt`: replaces the text sent to the model; `reply`: written as the assistant message without a model call. */
export type CommandRunResult = { type: 'prompt', text: string } | { type: 'reply', markdown: string }

export interface CommandDefinition {
  /** `^[a-z][a-z0-9-]{0,31}$`; not a client-only command. */
  name: string
  description: string
  /** Exactly one of `template` / `run`; every `{{input}}` is replaced with the text after `/name `. */
  template?: string
  /** Guarded (30 s). */
  run?(i: CommandRunInput): Promise<CommandRunResult>
}

// ---------- hooks ----------

/** Input fields shared by every hook. */
export interface HookChatContext {
  chatId: string
  modelRef: string
}

/** Hook name -> `[input, output]`; handlers mutate the output draft in place (the input is frozen). */
export interface HookMap {
  'chat.params': [
    HookChatContext & { model: ModelInfo, reasoningEffort: ReasoningEffort, toolMode: ToolMode },
    {
      instructions: string
      temperature?: number
      maxOutputTokens?: number
      maxSteps: number
      reasoning?: ReasoningLevel
      providerOptions: ProviderOptions
    },
  ]
  'chat.headers': [HookChatContext, { headers: Record<string, string> }]
  'chat.messages': [HookChatContext, { messages: ModelMessage[] }]
  'tool.approve': [HookChatContext & { tool: string, toolCallId: string, input: unknown }, { decision?: 'allow' | 'ask' | 'deny' }]
  /** A throw blocks the call. */
  'tool.before': [HookChatContext & { tool: string, toolCallId: string }, { input: unknown }]
  'tool.after': [HookChatContext & { tool: string, toolCallId: string, input: unknown }, { output: unknown }]
  'message.completed': [
    HookChatContext & { message: UIMessage, usage: LanguageModelUsage, costUsd?: number, aborted: boolean },
    void,
  ]
}
export type HookName = keyof HookMap

/** A hook handler; return values are ignored. */
export type HookHandler<K extends HookName> = (...args: HookMap[K]) => unknown

// ---------- context ----------

export interface Disposable {
  dispose(): void
}

export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

export interface KV<V = unknown> {
  get<T extends V = V>(key: string): Promise<T | undefined>
  set(key: string, value: V): Promise<void>
  delete(key: string): Promise<void>
  /** Keys only. */
  list(prefix?: string): Promise<string[]>
}

/** Host copies of the libraries a code plugin needs (one AI SDK and one zod in the process). */
export interface HostAi {
  z: typeof z
  tool: typeof tool
  jsonSchema: typeof jsonSchema
  generateText: typeof generateText
  createOpenAICompatible: typeof createOpenAICompatible
  createAnthropic: typeof createAnthropic
  createOpenAI: typeof createOpenAI
  /** Alias of `createGoogle` of `@ai-sdk/google`. */
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI
}

export interface PluginContext {
  plugin: {
    id: string
    version: string
    /** Absolute realpath of the plugin directory. */
    dir: string
    /** `data/plugins/.data/<id>/` (mode 0700): survives updates, removed on uninstall unless `keepData`. */
    dataDir: string
  }
  /** Per-plugin ring buffer (last 500 entries) + process log; each entry is published as a `plugin.log` event. */
  logger: Logger
  /** Aborted on disable / reload / uninstall / shutdown. */
  signal: AbortSignal
  settings: {
    /** Stored values over defaults, secrets decrypted; synchronous (cached in memory). */
    get<T = Record<string, unknown>>(): T
    /** Called with the full new values after a successful save (guarded, 3 s). */
    onChange(cb: (values: Record<string, unknown>) => void | Promise<void>): Disposable
  }
  /** Encrypted plugin-scoped strings; keys `^[A-Za-z0-9._:-]{1,128}$`, values <= 16 KB. */
  secrets: KV<string>
  /** Plugin-scoped JSON values; <= 256 KB each, <= 10 MB per plugin. */
  storage: KV
  providers: {
    /** Validates `d`, then adds the provider; a duplicate id throws `conflict`. */
    register(d: ProviderDefinition): Disposable
  }
  models: {
    /** Adds models / metadata to any provider (held until the provider exists). */
    register(providerId: string, models: ModelInfo[]): Disposable
    /** A model instance for `providerId:modelId` with the user's credentials (use with `ai.generateText`). */
    resolve(ref: string): Promise<Exclude<LanguageModel, string>>
  }
  tools: {
    /** Validates name, schema and policy; a duplicate or `mcp__`-prefixed name throws `conflict`. */
    register<I, O>(d: ToolDefinition<I, O>): Disposable
  }
  mcp: {
    /** Same rules as `contributes.mcpServers`. */
    register(d: McpServerDecl): Disposable
  }
  commands: {
    /** Exactly one of `template` / `run`; a duplicate name throws `conflict`. */
    register(d: CommandDefinition): Disposable
  }
  hooks: {
    /** Higher `priority` first (default 0), then plugin load order, then registration order. */
    on<K extends HookName>(name: K, fn: HookHandler<K>, options?: { priority?: number }): Disposable
  }
  ai: HostAi
  /** Global `fetch` combined with `signal` and a default `User-Agent`; no SSRF guard; no default timeout. */
  fetch: typeof globalThis.fetch
}

/** The default export of a code plugin's entry module. */
export interface PluginModule {
  /** Registers contributions through `ctx`; must resolve within 10 s (module evaluation + setup). */
  setup(ctx: PluginContext): void | Promise<void>
  /** Releases resources not created through `ctx` (5 s). */
  dispose?(): void | Promise<void>
}
