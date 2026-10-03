/* eslint-disable ts/method-signature-style -- PLUGINS.md section 9 is authoritative and uses method signatures: they
   keep parameters bivariant, so the host can store `ToolDefinition<I, O>` values as `ToolDefinition` without casts. */
// Runtime plugin API (PLUGINS.md section 9). The plugin data shapes and enums come from `@harness-forge/shared`
// (ADR-018) and are re-exported unchanged by `index.ts`.
import type { createAnthropic } from '@ai-sdk/anthropic'
import type { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { createOpenAI } from '@ai-sdk/openai'
import type { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type {
  ImageModelV3,
  ImageModelV4,
  LanguageModelV3,
  LanguageModelV4,
  SharedV4ProviderOptions,
  SpeechModelV3,
  SpeechModelV4,
  TranscriptionModelV3,
  TranscriptionModelV4,
} from '@ai-sdk/provider'
import type {
  CredentialField,
  HarnessErrorInit,
  ImageAspectRatio,
  McpServerDecl,
  ModelInfo,
  ReasoningEffort,
  ToolMode,
  ToolPolicy,
  WorkspaceAccess,
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

/** What an image request asks for: the input of `ProviderDefinition.imageParams()` (plugin API 1.1.0, ADR-028). */
export interface ImageParamsRequest {
  /** Images to generate, 1..4 (always 1 for a chat model with image output). */
  n: number
  /** Omitted = the provider default ("Auto" in the composer). */
  aspectRatio?: ImageAspectRatio
  /** Input images sent with the prompt (an edit); 0 for a new image. */
  inputs: number
}

/** Call additions returned by `ProviderDefinition.imageParams()`. */
export interface ImageParamsResult {
  /** `generateImage({ size })` of an image model, e.g. `1536x1024` for a landscape OpenAI image. */
  size?: `${number}x${number}`
  /** `generateImage({ aspectRatio })` of an image model, e.g. `16:9`. */
  aspectRatio?: `${number}:${number}`
  /**
   * Deep-merged into the provider options of the call: `generateImage` for an image model, `streamText` for a chat
   * model with `capabilities.imageOutput` (e.g. `{ google: { responseModalities: ['TEXT', 'IMAGE'] } }`).
   */
  providerOptions?: ProviderOptions
}

/** Hints of a transcription request: the input of `ProviderDefinition.transcriptionOptions()` (ADR-029). */
export interface TranscriptionHints {
  /** ISO 639 code of the spoken language; absent = detect automatically. */
  language?: string
}

export interface ProviderDefinition {
  /** Builtins: models.dev keys; plugins: `<pluginId>` or `<pluginId>-<suffix>`. */
  id: string
  /** UI name (Settings -> Providers, picker group header). */
  name: string
  /**
   * `lobe:<slug>` (or a plugin-relative file), or an explicit pair when the mono and color slugs differ
   * (e.g. `{ color: 'lobe:zhipu-color', mono: 'lobe:zai' }`). For a single `lobe:<x>-color` string the host also
   * offers `lobe:<x>` as the mono variant when it exists. Default: the plugin icon, else a monogram.
   */
  icon?: string | { color?: string, mono?: string }
  /** Fields of the key dialog; `[]` for keyless providers. */
  credentials: CredentialField[]
  /** models.dev key for metadata (default: `id`). */
  modelsDevId?: string
  /** Cheap model for chat titles and the default credential ping. */
  smallModelId?: string
  /**
   * Listed when the provider has no live listing (none was ever fetched or cached). Seeds with an explicit media kind
   * (`image`, `transcription`, `speech`) are listed next to a live listing too, when the provider defines the matching
   * factory (Phase 6, ADR-028 / ADR-029). Seed fields also fill the gaps of listed models with the same id (the lowest
   * metadata layer, after models.dev and plugin models).
   */
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
  /**
   * Plugin API 1.1.0 (ADR-028): an image model instance for `generateImage` (models of `kind: 'image'`); same rules as
   * `createLanguageModel` (never a string id, no network I/O, guarded 5 s). Without it the provider's image models are
   * not offered.
   */
  createImageModel?(modelId: string, rt: ProviderRuntime): ImageModelV4 | ImageModelV3
  /**
   * Synchronous (ADR-028); maps an image request to call options: `size`, `aspectRatio` and `providerOptions` for an
   * image model, only `providerOptions` for a chat model with `capabilities.imageOutput`; `undefined` = no additions.
   */
  imageParams?(request: ImageParamsRequest, model: ModelInfo): ImageParamsResult | undefined
  /**
   * Plugin API 1.1.0 (ADR-029): a transcription model instance for `transcribe` (models of `kind: 'transcription'`);
   * same rules as `createLanguageModel`.
   */
  createTranscriptionModel?(modelId: string, rt: ProviderRuntime): TranscriptionModelV4 | TranscriptionModelV3
  /** Plugin API 1.1.0 (ADR-029): a speech model instance for `generateSpeech` (models of `kind: 'speech'`). */
  createSpeechModel?(modelId: string, rt: ProviderRuntime): SpeechModelV4 | SpeechModelV3
  /**
   * Synchronous (ADR-029); turns transcription hints into provider options (e.g. `{ openai: { language: 'de' } }`);
   * `undefined` = none (the provider detects the language).
   */
  transcriptionOptions?(hints: TranscriptionHints): ProviderOptions | undefined
}

// ---------- tools ----------

/**
 * The AI SDK tool result output union (`text`, `json`, `execution-denied`, `error-text`, `error-json`, `content`);
 * `ai` does not export the name, so it is derived.
 */
export type ToolResultOutput = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>

/** What a tool does with the project folder of a chat (plugin API 1.2.0, ADR-032): `read`, `write` or `execute`. */
export type ToolWorkspaceAccess = WorkspaceAccess

/** The project folder of a chat, as the tools of a run see it (plugin API 1.2.0, ADR-031 / ADR-032). Frozen. */
export interface ToolWorkspace {
  /** `prj_` + 16 characters. */
  readonly projectId: string
  /** Project name. */
  readonly name: string
  /**
   * Canonical realpath of the project folder, verified when the run started. Resolve every path against it and keep
   * the result inside it (realpath containment): the folder can change on disk during a run.
   */
  readonly root: string
}

export interface ToolCallContext {
  chatId: string
  modelRef: string
  toolCallId: string
  /** Messages sent to the model for this step (read-only). */
  messages: ModelMessage[]
  /** Aborted on stop, timeout, or plugin disable. */
  signal: AbortSignal
  /**
   * Plugin API 1.2.0 (ADR-032): the project folder of the chat; set for every tool of a run in a chat whose project
   * folder opened, absent otherwise (no project, or the folder is not available).
   */
  workspace?: ToolWorkspace
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
  /**
   * Plugin API 1.2.0 (ADR-032): what the tool does with the project folder of the chat. A tool that declares it is
   * offered only in chats whose project folder opened (`c.workspace` is then set), and an `execute` tool only while
   * `HF_WORKSPACE_SHELL` is not `0` (ADR-033). In the Accept edits mode (`ToolMode` `edits`) a `write` tool whose
   * policy resolves to `ask` runs without asking; every other tool follows its policy as in `ask` mode. Omitted = the
   * tool does not use the workspace and is offered in every chat.
   */
  workspace?: ToolWorkspaceAccess
  /**
   * The output must be JSON-serializable; capped at 64 KB of serialized JSON. Plugin API 1.3.0 (ADR-043): `execute` may
   * also return the output directly, or be an async generator (`async *execute(input, c) { ... }`): each yielded value
   * is a preliminary output shown in the UI while the tool runs (throttled to one per 250 ms, the latest wins), and the
   * last yielded value is the final output (stored, passed to `toModelOutput` and to the `tool.after` hook). The timeout
   * and `c.signal` cover the whole iteration.
   */
  execute(input: I, c: ToolCallContext): Promise<O> | O | AsyncIterable<O>
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

/** Options of `ctx.images.generate()` (plugin API 1.1.0, ADR-028). */
export interface ImageGenerateOptions {
  /** 1..32000 characters. */
  prompt: string
  /** An image model (`kind: 'image'`); default: the `imageModelRef` setting (neither -> `validation_error`). */
  modelRef?: string
  /** Images to generate, 1..4; default 1. */
  n?: number
  aspectRatio?: ImageAspectRatio
  /** The chat the images are made for (usage rows). */
  chatId?: string
  signal?: AbortSignal
}

/** One image generated by `ctx.images.generate()`, stored as a file. */
export interface GeneratedImageFile {
  fileId: string
  /** `/api/files/<fileId>`, usable as the `url` of a UI `file` part. */
  url: string
  /** `image/png`, `image/jpeg`, `image/webp` or `image/gif`. */
  mediaType: string
  /** File name, e.g. `image-1.png`. */
  name: string
  /** Bytes. */
  size: number
}

/** Result of `ctx.images.generate()`. */
export interface ImageGenerateResult {
  /** The image model used. */
  modelRef: string
  /** Display name of the image model: the catalog name, else the model id (plugin API 1.2.0). */
  modelName: string
  images: GeneratedImageFile[]
  /** Estimated cost (catalog prices), when known. */
  costUsd?: number
  /** The prompt as rewritten by the provider, when it reports one. */
  revisedPrompt?: string
}

/** `ctx.images` (plugin API 1.1.0, ADR-028). */
export interface PluginImagesApi {
  /**
   * Generates images with an image model, stores them as files and records a usage row (purpose `image`). Errors are
   * `HarnessError`s (provider errors mapped as for chats); an unknown, disabled or unconfigured provider is
   * `provider_not_configured` (plugin API 1.2.0; 1.1.0 answered `not_found` for an unknown provider).
   */
  generate(options: ImageGenerateOptions): Promise<ImageGenerateResult>
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
    /**
     * A model instance for `providerId:modelId` with the user's credentials (use with `ai.generateText`); an unknown,
     * disabled or unconfigured provider is a `provider_not_configured` `HarnessError` (plugin API 1.2.0).
     */
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
  /** Image generation through the user's image models, stored as files (plugin API 1.1.0). */
  images: PluginImagesApi
}

/** The default export of a code plugin's entry module. */
export interface PluginModule {
  /** Registers contributions through `ctx`; must resolve within 10 s (module evaluation + setup). */
  setup(ctx: PluginContext): void | Promise<void>
  /** Releases resources not created through `ctx` (5 s). */
  dispose?(): void | Promise<void>
}
