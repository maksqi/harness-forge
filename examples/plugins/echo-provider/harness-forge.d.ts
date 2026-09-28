/* eslint-disable -- copy of the harness-forge.d.ts that the code plugin templates write */
// harness-forge plugin API 1.1.0: types for your editor.
//
// This file lets "// @ts-check" with JSDoc types (index.mjs) and "import type" (index.ts) resolve
// "@harness-forge/plugin-sdk" without installing anything. The host never loads it and it is not part of the trust
// hash. Reference: docs/PLUGINS.md, section 9. The libraries of ctx.ai (zod and the AI SDK) are not included here,
// so their values are typed as "any".

declare module '@harness-forge/plugin-sdk' {
  /** Version of the plugin API (not of the app). Manifests declare the supported range in engines.harness. */
  export const PLUGIN_API_VERSION: string
  /** Identity helper that types the default export of an entry module. */
  export function definePlugin(m: PluginModule): PluginModule

  // ---------- enumerations ----------

  export type PluginKind = 'declarative' | 'code'
  export type PluginSource = 'builtin' | 'created' | 'zip' | 'npm' | 'url' | 'link' | 'copy'
  export type PluginState = 'disabled' | 'untrusted' | 'incompatible' | 'loading' | 'active' | 'error'
  export type PluginPermission = 'network' | 'secrets' | 'storage' | 'hooks' | 'process'
  export type ToolMode = 'off' | 'ask' | 'auto'
  export type ToolPolicy = 'safe' | 'ask' | 'always'
  export type ReasoningEffort = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max'
  /** AI SDK top-level "reasoning" values (without "provider-default"). */
  export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  export type ApiFormat = 'openai-chat' | 'openai-responses' | 'anthropic' | 'google'
  export type ReasoningStyle = 'openai-effort' | 'anthropic-thinking' | 'google-thinking' | 'none'
  export type HarnessErrorCode
    = | 'validation_error' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'payload_too_large'
      | 'provider_not_configured' | 'auth_invalid' | 'rate_limited' | 'model_not_found' | 'context_overflow'
      | 'provider_unreachable' | 'provider_error' | 'plugin_error' | 'internal_error' | 'not_implemented'
  export type HarnessErrorAction = 'configure-provider' | 'refresh-models' | 'login' | 'retry'
  /** Kind of a model; only 'chat' (and 'image' with createImageModel) models appear in the chat picker. */
  export type ModelKind = 'chat' | 'embedding' | 'image' | 'audio' | 'transcription' | 'speech' | 'other'
  /** Aspect ratios of generated images. */
  export type ImageAspectRatio = '1:1' | '3:2' | '2:3' | '4:3' | '3:4' | '16:9' | '9:16'

  // ---------- library values (ctx.ai) ----------

  /** A value of a library from ctx.ai (zod, the AI SDK); not typed in this file. */
  export type LibraryValue = any
  /** An AI SDK model instance, e.g. ctx.ai.createOpenAICompatible({ ... }).chatModel(modelId). */
  export type LanguageModel = LibraryValue
  /** An AI SDK image model instance, e.g. ctx.ai.createOpenAI({ ... }).image(modelId). */
  export type ImageModel = LibraryValue
  /** An AI SDK transcription model instance, e.g. ctx.ai.createOpenAI({ ... }).transcription(modelId). */
  export type TranscriptionModel = LibraryValue
  /** An AI SDK speech model instance, e.g. ctx.ai.createOpenAI({ ... }).speech(modelId). */
  export type SpeechModel = LibraryValue
  /** An AI SDK model message. */
  export type ModelMessage = LibraryValue
  /** An AI SDK UI message. */
  export type UIMessage = LibraryValue
  /** AI SDK token usage. */
  export type LanguageModelUsage = LibraryValue
  /** A zod object schema (ctx.ai.z.object({ ... })) or ctx.ai.jsonSchema({ type: 'object', ... }). */
  export type InputSchema = LibraryValue
  /** An AI SDK tool result output: { type: 'text', value } or { type: 'json', value } and friends. */
  export type ToolResultOutput = LibraryValue
  /** Options per provider, e.g. { openai: { reasoningEffort: 'low' } }. */
  export type ProviderOptions = Record<string, Record<string, any>>

  /** The host's copies of the libraries a code plugin needs (plugins cannot install packages). */
  export interface HostAi {
    /** zod 4. */
    z: LibraryValue
    tool: LibraryValue
    jsonSchema: LibraryValue
    generateText: LibraryValue
    createOpenAICompatible: LibraryValue
    createAnthropic: LibraryValue
    createOpenAI: LibraryValue
    createGoogleGenerativeAI: LibraryValue
  }

  // ---------- data shapes ----------

  export interface HarnessErrorInit {
    code: HarnessErrorCode
    message: string
    /** HTTP status reported by an upstream service. */
    status?: number
    providerId?: string
    retryAfterMs?: number
    action?: HarnessErrorAction
    details?: unknown
  }

  export interface ModelInfo {
    /** Model id sent to the API (may contain ":" and "/"). */
    id: string
    name?: string
    /** Default 'chat'; other kinds are hidden from the chat model picker. */
    kind?: ModelKind
    contextWindow?: number
    maxOutputTokens?: number
    capabilities?: {
      tools?: boolean
      vision?: boolean
      pdf?: boolean
      reasoning?: boolean
      structuredOutput?: boolean
      /** A chat model that can return images in its reply. */
      imageOutput?: boolean
    }
    reasoningEfforts?: ReasoningEffort[]
    /** USD per 1M tokens. */
    cost?: { input?: number, output?: number, cacheRead?: number, cacheWrite?: number }
    /** Speech models: voice names to suggest (unique, at most 100). */
    voices?: string[]
  }

  export interface CredentialField {
    /** ^[a-zA-Z][a-zA-Z0-9_]{0,63}$ */
    key: string
    label: string
    type: 'secret' | 'text' | 'url' | 'select'
    required?: boolean
    default?: string
    /** Required for 'select'. */
    options?: string[]
    /** Environment variable fallbacks (code plugins only); the first non-empty one wins. */
    envVar?: string | string[]
    helpUrl?: string
    advanced?: boolean
  }

  export interface McpServerDecl {
    /** The plugin id, or the plugin id + "-" + a suffix. */
    id: string
    name: string
    /** Policy of tools without annotations (default 'ask'). */
    policy?: ToolPolicy
    /** Values may contain {{settings.<key>}} placeholders (resolved when connecting). */
    transport:
      | { type: 'http' | 'sse', url: string, headers?: Record<string, string> }
      | { type: 'stdio', command: string, args?: string[], env?: Record<string, string> }
  }

  export interface DeclarativeCommand {
    name: string
    description: string
    template: string
  }

  export interface DeclarativeProvider {
    id: string
    name: string
    icon?: string
    baseURL: string
    apiFormat: ApiFormat
    auth?: { type: 'bearer' | 'header' | 'none', header?: string }
    credentials?: CredentialField[]
    headers?: Record<string, string>
    models?: ModelInfo[]
    listModels?: boolean | { path?: string, include?: string, exclude?: string }
    reasoningStyle?: ReasoningStyle
    modelsDevId?: string
    smallModelId?: string
  }

  export type SettingsProperty = { title: string, description?: string, default?: unknown } & (
    | { type: 'string', enum?: string[], format?: 'secret' | 'url' | 'multiline', pattern?: string }
    | { type: 'number' | 'integer', minimum?: number, maximum?: number }
    | { type: 'boolean' }
    | { type: 'array', items: { type: 'string', enum?: string[] } }
  )

  export interface SettingsSchema {
    type: 'object'
    required?: string[]
    properties: Record<string, SettingsProperty>
  }

  /** The shape of plugin.json. */
  export interface PluginManifest {
    $schema?: string
    manifestVersion: 1
    id: string
    name: string
    version: string
    description?: string
    author?: string
    homepage?: string
    icon?: string
    engines: { harness: string }
    main?: string
    permissions?: PluginPermission[]
    settings?: SettingsSchema
    contributes?: {
      providers?: DeclarativeProvider[]
      models?: { providerId: string, models: ModelInfo[] }[]
      mcpServers?: McpServerDecl[]
      commands?: DeclarativeCommand[]
    }
  }

  // ---------- providers ----------

  export interface ProviderRuntime {
    /** Resolved credential values: stored value, then environment variable, then default. */
    credentials: Record<string, string>
    /** Host fetch for provider requests (aborted with the run; same-origin redirects only). */
    fetch: typeof globalThis.fetch
    signal?: AbortSignal
  }

  export interface ReasoningParams {
    reasoning?: ReasoningLevel
    providerOptions?: ProviderOptions
    maxOutputTokens?: number
  }

  /** What an image request asks for (input of imageParams). */
  export interface ImageParamsRequest {
    /** Images to generate, 1..4. */
    n: number
    /** Omitted: the provider default. */
    aspectRatio?: ImageAspectRatio
    /** Input images sent with the prompt (an edit); 0 for a new image. */
    inputs: number
  }

  /** Call additions returned by imageParams. */
  export interface ImageParamsResult {
    /** Image models: the image size, e.g. '1536x1024'. */
    size?: `${number}x${number}`
    /** Image models: the aspect ratio, e.g. '16:9'. */
    aspectRatio?: `${number}:${number}`
    /** Merged into the provider options of the call (also for chat models with image output). */
    providerOptions?: ProviderOptions
  }

  /** Hints of a transcription request (input of transcriptionOptions). */
  export interface TranscriptionHints {
    /** ISO 639 code of the spoken language; absent: detect automatically. */
    language?: string
  }

  export interface ProviderDefinition {
    /** The plugin id, or the plugin id + "-" + a suffix. Model refs look like "<id>:<model id>". */
    id: string
    name: string
    /** 'lobe:<slug>', or { color, mono } LobeHub slugs; default: the plugin icon. */
    icon?: string | { color?: string, mono?: string }
    /** Fields of the key dialog; [] for keyless providers. */
    credentials: CredentialField[]
    modelsDevId?: string
    smallModelId?: string
    /** Models shown when there is no live or cached listing. */
    seedModels?: ModelInfo[]
    /** "Get a key" link of the key dialog. */
    keyUrl?: string
    /** Returns a model instance (never a string id); called per request; no network I/O (5 s). */
    createLanguageModel(modelId: string, rt: ProviderRuntime): LanguageModel
    /** Live model listing (15 s, cached 24 h). */
    listModels?(rt: ProviderRuntime): Promise<ModelInfo[]>
    /** Credential test (15 s); default: listModels. */
    validate?(rt: ProviderRuntime): Promise<void>
    /** Request additions for a reasoning effort (synchronous). */
    reasoning?(effort: ReasoningEffort, model: ModelInfo): ReasoningParams | undefined
    /** Maps an error of this provider; undefined falls back to the default mapping. */
    mapError?(err: unknown): HarnessErrorInit | undefined
    /** Image models (kind 'image'): an image model instance; no network I/O (5 s). */
    createImageModel?(modelId: string, rt: ProviderRuntime): ImageModel
    /** Maps an image request to call options (synchronous). */
    imageParams?(request: ImageParamsRequest, model: ModelInfo): ImageParamsResult | undefined
    /** Transcription models (kind 'transcription'): a transcription model instance (5 s). */
    createTranscriptionModel?(modelId: string, rt: ProviderRuntime): TranscriptionModel
    /** Speech models (kind 'speech'): a speech model instance (5 s). */
    createSpeechModel?(modelId: string, rt: ProviderRuntime): SpeechModel
    /** Turns transcription hints into provider options (synchronous). */
    transcriptionOptions?(hints: TranscriptionHints): ProviderOptions | undefined
  }

  // ---------- tools ----------

  export interface ToolCallContext {
    chatId: string
    modelRef: string
    toolCallId: string
    /** Messages sent to the model for this step (read-only). */
    messages: ModelMessage[]
    /** Aborted on stop, timeout, or plugin disable. */
    signal: AbortSignal
  }

  /** Guarded (3 s); a throw or timeout counts as 'always'. */
  export type ToolPolicyFunction<I = any> = (input: I, c: ToolCallContext) => ToolPolicy | 'deny' | Promise<ToolPolicy | 'deny'>

  export interface ToolDefinition<I = any, O = any> {
    /** ^[a-zA-Z0-9_-]{1,64}$, globally unique; the prefix mcp__ is reserved. */
    name: string
    /** Sent to the model (<= 1024 characters). */
    description: string
    /** A JSON object schema: ctx.ai.z.object({ ... }) or ctx.ai.jsonSchema({ ... }). */
    inputSchema: InputSchema
    /** Default 'ask'. */
    policy?: ToolPolicy | ToolPolicyFunction<I>
    /** Default 60000, max 600000. */
    timeoutMs?: number
    /** The output must be JSON-serializable (capped at 64 KB). */
    execute(input: I, c: ToolCallContext): Promise<O>
    /** Converts the stored output for the model (fast and deterministic, 3 s). */
    toModelOutput?(output: O, c: { toolCallId: string, input: I }): ToolResultOutput | Promise<ToolResultOutput>
  }

  // ---------- commands ----------

  export interface CommandRunInput {
    /** Text after "/name " (trimmed). */
    input: string
    chatId: string
    signal: AbortSignal
  }

  /** 'prompt' replaces the text sent to the model; 'reply' is shown without calling the model. */
  export type CommandRunResult = { type: 'prompt', text: string } | { type: 'reply', markdown: string }

  export interface CommandDefinition {
    /** ^[a-z][a-z0-9-]{0,31}$; typed as /name. */
    name: string
    description: string
    /** Exactly one of template / run; every {{input}} is replaced with the text after "/name ". */
    template?: string
    /** Guarded (30 s). */
    run?(i: CommandRunInput): Promise<CommandRunResult>
  }

  // ---------- hooks ----------

  export interface HookChatContext {
    chatId: string
    modelRef: string
  }

  /** Hook name -> [input, output]; handlers change the output in place (the input is frozen). */
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

  /** Options of ctx.images.generate. */
  export interface ImageGenerateOptions {
    /** 1..32000 characters. */
    prompt: string
    /** An image model; default: the image model chosen in Settings. */
    modelRef?: string
    /** Images to generate, 1..4 (default 1). */
    n?: number
    aspectRatio?: ImageAspectRatio
    /** The chat the images are made for. */
    chatId?: string
    signal?: AbortSignal
  }

  /** One image generated by ctx.images.generate, stored as a file. */
  export interface GeneratedImageFile {
    fileId: string
    /** '/api/files/<fileId>'. */
    url: string
    mediaType: string
    name: string
    /** Bytes. */
    size: number
  }

  export interface ImageGenerateResult {
    /** The image model used. */
    modelRef: string
    images: GeneratedImageFile[]
    costUsd?: number
    revisedPrompt?: string
  }

  export interface PluginImagesApi {
    /** Generates images with an image model, stores them as files and records usage. */
    generate(options: ImageGenerateOptions): Promise<ImageGenerateResult>
  }

  export interface PluginContext {
    plugin: {
      id: string
      version: string
      /** Absolute path of the plugin directory. */
      dir: string
      /** Private data directory: survives updates, removed on uninstall. */
      dataDir: string
    }
    /** Entries appear in the Logs tab (last 500) and the server log. */
    logger: Logger
    /** Aborted on disable, reload, uninstall and shutdown. */
    signal: AbortSignal
    settings: {
      /** Stored values over defaults, secrets decrypted. */
      get<T = Record<string, unknown>>(): T
      /** Called with every value after a successful save (3 s). */
      onChange(cb: (values: Record<string, unknown>) => void | Promise<void>): Disposable
    }
    /** Encrypted strings: keys ^[A-Za-z0-9._:-]{1,128}$, values <= 16 KB. */
    secrets: KV<string>
    /** JSON values: <= 256 KB each, <= 10 MB per plugin. */
    storage: KV
    providers: {
      register(d: ProviderDefinition): Disposable
    }
    models: {
      /** Adds models to any provider (held until it exists). */
      register(providerId: string, models: ModelInfo[]): Disposable
      /** A model instance for "providerId:modelId" (use it with ctx.ai.generateText). */
      resolve(ref: string): Promise<LanguageModel>
    }
    tools: {
      register<I = any, O = any>(d: ToolDefinition<I, O>): Disposable
    }
    mcp: {
      register(d: McpServerDecl): Disposable
    }
    commands: {
      register(d: CommandDefinition): Disposable
    }
    hooks: {
      /** Higher priority runs first (default 0). */
      on<K extends HookName>(name: K, fn: HookHandler<K>, options?: { priority?: number }): Disposable
    }
    ai: HostAi
    /** Global fetch combined with ctx.signal and a plugin User-Agent (no timeout). */
    fetch: typeof globalThis.fetch
    /** Image generation with the user's image models (stored as files). */
    images: PluginImagesApi
  }

  /** The default export of the entry module. */
  export interface PluginModule {
    /** Registers contributions through ctx; must finish within 10 s. */
    setup(ctx: PluginContext): void | Promise<void>
    /** Releases resources not created through ctx (5 s). */
    dispose?(): void | Promise<void>
  }
}
