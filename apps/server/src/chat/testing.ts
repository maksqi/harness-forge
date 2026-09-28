// Test helpers of the chat pipeline (route and unit tests): request bodies, SSE parsing and partial reads; the media
// test app of image turns (ADR-028): the C11 fakes for `ImageService`, `saveGenerated` and the media resolvers, a
// `core-tools` builtin without its own `generate_image` (tests register a stand-in with `registerImageTool`), a catalog
// that reports `imageOutput` for the image-output models, and the `mediakit` test provider.
import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { Disposable, ModelInfo, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { CatalogModel, ChatRequestBody, GenerateImageToolInput, GenerateImageToolOutput, HarnessUIMessage, ServerEvent } from '@harness-forge/shared'
import type { UIMessageChunk } from 'ai'
import type { ModelCatalog } from '../catalog/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeImageService, FakeImageServiceOptions } from '../testing/fake-media.ts'
import type { AppDeps } from '../types.ts'
import type { ChatRunnerInternal, ChatRunnerOptions } from './index.ts'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { createMessageId, GENERATE_IMAGE_TOOL_NAME, generateImageToolInputSchema } from '@harness-forge/shared'
import { getBuiltinPlugins } from '../builtin-plugins/index.ts'
import { createModelCatalog } from '../catalog/index.ts'
import { createFakeImageModel, fakeMediaProviders } from '../providers/testing.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeImageService } from '../testing/fake-media.ts'
import { createFakeFilesService } from '../testing/fakes.ts'
import { createChatRunnerWith } from './index.ts'

export function testChatId(n: number): string {
  return `0199a8f0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
}

export function userMessage(text: string, id: string = createMessageId()): HarnessUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

export function chatBody(chatId: string, text: string, overrides: Partial<ChatRequestBody> = {}): ChatRequestBody {
  return {
    chatId,
    message: userMessage(text),
    trigger: 'submit-message',
    modelRef: 'mock:echo',
    reasoningEffort: 'auto',
    toolMode: 'ask',
    ...overrides,
  }
}

export function postChat(t: TestApp, body: unknown): Promise<Response> {
  return t.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

export interface SseResult {
  chunks: UIMessageChunk[]
  done: boolean
}

/** Parses `data: <json>\n\n` events (`[DONE]` sets `done`). */
export function parseSse(text: string): SseResult {
  const chunks: UIMessageChunk[] = []
  let done = false
  for (const block of text.split('\n\n')) {
    const line = block.trim()
    if (!line.startsWith('data: '))
      continue
    const data = line.slice('data: '.length)
    if (data === '[DONE]') {
      done = true
      continue
    }
    chunks.push(JSON.parse(data) as UIMessageChunk)
  }
  return { chunks, done }
}

export async function readSse(response: Response): Promise<SseResult> {
  return parseSse(await response.text())
}

/** Reads until `predicate` matches the chunks so far (or the stream ends), then cancels the reader (a disconnect). */
export async function readUntil(response: Response, predicate: (chunks: UIMessageChunk[]) => boolean): Promise<SseResult> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    text += decoder.decode(value, { stream: true })
    const parsed = parseSse(text.slice(0, text.lastIndexOf('\n\n') + 2))
    if (predicate(parsed.chunks)) {
      await reader.cancel()
      return parsed
    }
  }
  return parseSse(text)
}

/** Concatenated `text-delta`s. */
export function streamedText(chunks: readonly UIMessageChunk[]): string {
  return chunks.flatMap(chunk => (chunk.type === 'text-delta' ? [chunk.delta] : [])).join('')
}

/** Text of a stored message's text parts. */
export function messageText(message: HarnessUIMessage | undefined): string {
  return message?.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('') ?? ''
}

export function runnerOf(t: TestApp): ChatRunnerInternal {
  return t.deps.runs as ChatRunnerInternal
}

/** Resolves with the next event of `type` matching `predicate` (subscribe before triggering it). */
export function nextEvent<T extends ServerEvent['type']>(
  t: TestApp,
  type: T,
  predicate: (event: Extract<ServerEvent, { type: T }>) => boolean = () => true,
  timeoutMs = 5000,
): Promise<Extract<ServerEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const subscription = t.deps.events.subscribe((event) => {
      if (event.type === type && predicate(event as Extract<ServerEvent, { type: T }>)) {
        clearTimeout(timer)
        subscription.dispose()
        resolve(event as Extract<ServerEvent, { type: T }>)
      }
    })
    timer = setTimeout(() => {
      subscription.dispose()
      reject(new Error(`No ${type} event within ${timeoutMs} ms`))
    }, timeoutMs)
  })
}

/** `n` words (`w1 w2 ...`), for long mock streams (25 ms per word). */
export function words(n: number, prefix = 'w'): string {
  return Array.from({ length: n }, (_value, index) => `${prefix}${index + 1}`).join(' ')
}

// ---------- media test app (ADR-028) ----------

/** Chat models that report `capabilities.imageOutput` in the media test app (until the catalog derives it itself). */
export const IMAGE_OUTPUT_REFS: ReadonlySet<string> = new Set(['mock:image-chat', 'mediakit:painter'])

/** The catalog with `imageOutput` set for `IMAGE_OUTPUT_REFS`. */
export function withImageOutput(catalog: ModelCatalog): ModelCatalog {
  const patch = (model: CatalogModel): CatalogModel => (IMAGE_OUTPUT_REFS.has(model.ref) && !model.capabilities.imageOutput
    ? { ...model, capabilities: { ...model.capabilities, imageOutput: true } }
    : model)
  return {
    ...catalog,
    get: async (providerId, modelId) => {
      const model = await catalog.get(providerId, modelId)
      return model === null ? null : patch(model)
    },
    list: async query => (await catalog.list(query)).map(patch),
  }
}

/** The text the `generate_image` stand-in sends to the model (like the real tool: no image bytes). */
export function imageToolText(output: GenerateImageToolOutput): string {
  const count = output.images.length
  return `Generated ${count} ${count === 1 ? 'image' : 'images'} with ${output.modelRef}; they are shown to the user below this call.`
}

/**
 * A stand-in of the builtin `generate_image` tool (policy `ask`): `deps.images.generate` with the image model
 * `mock:image`, the tool call's chat and signal and no message id; the stored images as file references.
 */
export function imageToolStandIn(deps: () => AppDeps): ToolDefinition<GenerateImageToolInput, GenerateImageToolOutput> {
  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    description: 'Generates images from a prompt (test stand-in).',
    inputSchema: generateImageToolInputSchema,
    policy: 'ask',
    timeoutMs: 300_000,
    execute: async (input, c) => {
      const result = await deps().images.generate({
        modelRef: 'mock:image',
        prompt: input.prompt,
        n: input.n ?? 1,
        ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
        signal: c.signal,
        chatId: c.chatId,
        messageId: null,
      })
      return {
        modelRef: result.modelRef,
        images: result.images.map(({ file, url }) => ({ fileId: file.id, url, mediaType: file.mime as 'image/png', name: file.name })),
        ...(result.costUsd === null ? {} : { costUsd: result.costUsd }),
        ...(result.revisedPrompt === undefined ? {} : { revisedPrompt: result.revisedPrompt }),
      }
    },
    toModelOutput: output => ({ type: 'text', value: imageToolText(output) }),
  }
}

function mediakitModel(id: string, name: string, capabilities: Partial<NonNullable<ModelInfo['capabilities']>>, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name,
    contextWindow: 32_000,
    capabilities: { tools: false, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false, ...capabilities },
    cost: { input: 1, output: 2 },
    ...extra,
  }
}

export interface MediaTestApp extends TestApp {
  /** The fake image service (`calls`). */
  images: FakeImageService
  /** Options of the fake image service, read on every call: tests change them (reset them in `beforeEach`). */
  imageOptions: FakeImageServiceOptions
  /** Every server event since the app started (tests clear it). */
  events: ServerEvent[]
  /** Scripted chat models of `mediakit` by model id: `painter` (image output), `seer` (vision). */
  scripted: Map<string, LanguageModelV4>
  /** Registers the `generate_image` stand-in as a tool of `pluginId` (default `core-tools`). */
  registerImageTool: (pluginId?: string) => Disposable
}

/**
 * `createTestApp` for image turns (`HF_MOCK_PROVIDER=1`): fake image service, fake files service (`saveGenerated`), the
 * fake media resolvers, `withImageOutput`, a `core-tools` builtin that registers nothing, and the provider `mediakit`
 * (no credentials, no `smallModelId`): `painter` (image output) and `seer` (vision) answer from `scripted`, `pix` is an
 * image model.
 */
export async function createMediaTestApp(runner: ChatRunnerOptions = {}): Promise<MediaTestApp> {
  const imageOptions: FakeImageServiceOptions = {}
  let images: FakeImageService | undefined
  const scripted = new Map<string, LanguageModelV4>()
  const builtins = getBuiltinPlugins({ mockProvider: true }).map(builtin => (builtin.id === 'core-tools'
    ? { ...builtin, module: definePlugin({ setup() {} }) }
    : builtin))
  const t = await createTestApp({
    env: { HF_MOCK_PROVIDER: '1' },
    builtins,
    factories: {
      images: (deps) => {
        images = createFakeImageService(deps, imageOptions)
        return images
      },
      files: createFakeFilesService,
      providers: fakeMediaProviders(),
      catalog: deps => withImageOutput(createModelCatalog(deps)),
      runs: deps => createChatRunnerWith(deps, runner),
    },
  })
  const events: ServerEvent[] = []
  t.deps.events.subscribe(event => events.push(event))
  t.deps.registry.providers.register('mock', {
    id: 'mediakit',
    name: 'Media kit',
    credentials: [],
    seedModels: [
      mediakitModel('painter', 'Painter', { imageOutput: true }, { kind: 'chat' }),
      mediakitModel('seer', 'Seer', { vision: true }),
      { id: 'pix', name: 'Pix', kind: 'image', capabilities: { tools: false, vision: true, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false } },
    ],
    createLanguageModel: (modelId) => {
      const model = scripted.get(modelId)
      if (model === undefined)
        throw new Error(`No scripted model "${modelId}".`)
      return model
    },
    createImageModel: modelId => createFakeImageModel(modelId, 'mediakit'),
    imageParams: request => (request.aspectRatio === undefined ? undefined : { providerOptions: { mediakit: { aspectRatio: request.aspectRatio } } }),
  })
  if (images === undefined)
    throw new Error('The fake image service was not created.')
  const deps = t.deps
  return {
    ...t,
    images,
    imageOptions,
    events,
    scripted,
    registerImageTool: (pluginId = 'core-tools') => deps.registry.tools.register(pluginId, imageToolStandIn(() => deps) as ToolDefinition),
  }
}

/** Counts the stored messages whose parts hold a `data:` URL (must stay 0: ADR-028). */
export async function messagesWithDataUrls(t: TestApp): Promise<number> {
  const result = await t.database.client.execute('SELECT count(*) AS n FROM messages WHERE parts LIKE \'%data:%\'')
  return Number(result.rows[0]?.n ?? 0)
}

/** Every URL of the streamed chunks. */
export function chunkUrls(chunks: readonly UIMessageChunk[]): string[] {
  return chunks.flatMap(chunk => ('url' in chunk && typeof chunk.url === 'string' ? [chunk.url] : []))
}
