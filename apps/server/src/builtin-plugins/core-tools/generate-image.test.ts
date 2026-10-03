import type { ImageGenerateOptions, ImageGenerateResult, PluginImagesApi, ToolCallContext } from '@harness-forge/plugin-sdk'
import type { GeneratedImageRef } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { Buffer } from 'node:buffer'
import { generateImageToolOutputSchema, HarnessError, LIMITS } from '@harness-forge/shared'
import { asSchema } from 'ai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { usage } from '../../db/schema.ts'
import { fakeMediaProviders } from '../../providers/testing.ts'
import { NO_IMAGE_MODEL_MESSAGE } from '../../services/images/index.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { BUILTIN_PLUGINS } from '../index.ts'
import {
  createGenerateImageTool,
  fitJsonBytes,
  GENERATE_IMAGE_MODEL_NAME_MAX_CHARS,
  GENERATE_IMAGE_REVISED_PROMPT_JSON_BYTES,
  GENERATE_IMAGE_TIMEOUT_MS,
  generatedImagesText,
  generateImageInputSchema,
  outputModelName,
} from './generate-image.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'

function context(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return { chatId: CHAT_ID, modelRef: 'mock:image-tool', toolCallId: 'call_1', messages: [], signal: new AbortController().signal, ...overrides }
}

function file(index: number): ImageGenerateResult['images'][number] {
  const fileId = `file_000000000000000${index}`
  return { fileId, url: `/api/files/${fileId}`, mediaType: 'image/png', name: `image-${index}.png`, size: 1000 + index }
}

/** The tool output reference of `file(index)`. */
function ref(index: number): GeneratedImageRef {
  const { fileId, url, name } = file(index)
  return { fileId, url, mediaType: 'image/png', name }
}

/** A fake `ctx.images` answering `result` and recording its calls. */
function fakeImages(result: Partial<ImageGenerateResult> | Error = {}): PluginImagesApi & { calls: ImageGenerateOptions[] } {
  const calls: ImageGenerateOptions[] = []
  return {
    calls,
    generate: async (options) => {
      calls.push(options)
      if (result instanceof Error)
        throw result
      return { modelRef: 'mock:image', modelName: 'Mock Image', images: [file(1)], ...result }
    },
  }
}

describe('generate_image: definition', () => {
  it('is an ask tool with a 300 s timeout and a described JSON object input', () => {
    const tool = createGenerateImageTool(fakeImages())
    expect(tool).toMatchObject({ name: 'generate_image', policy: 'ask', timeoutMs: GENERATE_IMAGE_TIMEOUT_MS })
    expect(GENERATE_IMAGE_TIMEOUT_MS).toBe(300_000)
    expect(tool.description.length).toBeLessThanOrEqual(1024)
    const schema = asSchema(tool.inputSchema).jsonSchema as { type: string, properties: Record<string, { description?: string }>, required?: string[] }
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties)).toEqual(['prompt', 'n', 'aspectRatio'])
    expect(schema.required).toEqual(['prompt'])
    for (const property of Object.values(schema.properties))
      expect(property.description).toEqual(expect.any(String))
  })

  it('validates the input like generateImageToolInputSchema', () => {
    expect(generateImageInputSchema.parse({ prompt: '  a fox  ', n: 2, aspectRatio: '16:9' })).toEqual({ prompt: 'a fox', n: 2, aspectRatio: '16:9' })
    for (const input of [{}, { prompt: ' ' }, { prompt: 'x'.repeat(LIMITS.imagePromptMaxChars + 1) }, { prompt: 'x', n: 5 }, { prompt: 'x', aspectRatio: '5:4' }])
      expect(generateImageInputSchema.safeParse(input).success, JSON.stringify(input).slice(0, 40)).toBe(false)
  })
})

describe('generate_image: execute', () => {
  it('calls ctx.images with the input, the chat and the call signal; returns file references and the model name', async () => {
    const images = fakeImages({ images: [file(1), file(2)], costUsd: 0.08, revisedPrompt: 'A fox, watercolor' })
    const tool = createGenerateImageTool(images)
    const c = context()
    const output = await tool.execute({ prompt: 'a fox', n: 2, aspectRatio: '1:1' }, c)
    expect(images.calls).toEqual([{ prompt: 'a fox', n: 2, aspectRatio: '1:1', chatId: CHAT_ID, signal: c.signal }])
    expect(output).toEqual({
      modelRef: 'mock:image',
      modelName: 'Mock Image',
      images: [
        { fileId: 'file_0000000000000001', url: '/api/files/file_0000000000000001', mediaType: 'image/png', name: 'image-1.png' },
        { fileId: 'file_0000000000000002', url: '/api/files/file_0000000000000002', mediaType: 'image/png', name: 'image-2.png' },
      ],
      costUsd: 0.08,
      revisedPrompt: 'A fox, watercolor',
    })
    expect(generateImageToolOutputSchema.parse(output)).toEqual(output)
  })

  it('omits an unknown cost and a missing revised prompt', async () => {
    const output = await createGenerateImageTool(fakeImages()).execute({ prompt: 'a fox' }, context())
    expect(output).toEqual({ modelRef: 'mock:image', modelName: 'Mock Image', images: [ref(1)] })
  })

  it('trims the model name, cuts it to 200 characters and omits a blank or missing one', async () => {
    const run = async (modelName: unknown) => createGenerateImageTool(fakeImages({ modelName } as Partial<ImageGenerateResult>)).execute({ prompt: 'a fox' }, context())
    expect((await run('  GPT Image 1  ')).modelName).toBe('GPT Image 1')
    const long = await run('\u{1F98A}'.repeat(150))
    expect(long.modelName).toBe('\u{1F98A}'.repeat(100))
    expect(long.modelName!.length).toBe(GENERATE_IMAGE_MODEL_NAME_MAX_CHARS)
    expect(generateImageToolOutputSchema.safeParse(long).success).toBe(true)
    expect((await run('x'.repeat(201))).modelName).toBe('x'.repeat(200))
    for (const blank of ['', '   ', undefined, null, 42])
      expect('modelName' in await run(blank), String(blank)).toBe(false)
    expect(outputModelName(' a ')).toBe('a')
  })

  it('keeps the output far below the 64 KB tool output cap, even with a long revised prompt', async () => {
    const revisedPrompt = '狐'.repeat(LIMITS.imagePromptMaxChars)
    const output = await createGenerateImageTool(fakeImages({ images: [file(1), file(2), file(3), file(4)], revisedPrompt })).execute({ prompt: 'a fox', n: 4 }, context())
    expect(Buffer.byteLength(JSON.stringify(output.revisedPrompt), 'utf8')).toBeLessThanOrEqual(GENERATE_IMAGE_REVISED_PROMPT_JSON_BYTES)
    expect(output.revisedPrompt!.length).toBeGreaterThan(5000)
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeLessThan(LIMITS.toolOutputBytes / 2)
    expect(generateImageToolOutputSchema.safeParse(output).success).toBe(true)
  })

  it('fails when the image service fails or returns no image', async () => {
    const missing = new HarnessError({ code: 'validation_error', message: NO_IMAGE_MODEL_MESSAGE })
    await expect(createGenerateImageTool(fakeImages(missing)).execute({ prompt: 'a fox' }, context())).rejects.toBe(missing)
    await expect(createGenerateImageTool(fakeImages({ images: [] })).execute({ prompt: 'a fox' }, context())).rejects.toMatchObject({ code: 'provider_error', message: 'The image model returned no image.' })
    const odd = fakeImages({ images: [{ ...file(1), mediaType: 'image/svg+xml' }] })
    await expect(createGenerateImageTool(odd).execute({ prompt: 'a fox' }, context())).rejects.toMatchObject({ code: 'internal_error' })
  })
})

describe('generate_image: model output', () => {
  it('names the model by its display name in the short text the model gets instead of the JSON output', async () => {
    const tool = createGenerateImageTool(fakeImages())
    const two = { modelRef: 'openai:gpt-image-1', modelName: 'GPT Image 1', images: [ref(1), ref(2)], costUsd: 0.1 }
    expect(await tool.toModelOutput!(two, { toolCallId: 'call_1', input: { prompt: 'a fox' } })).toEqual({
      type: 'text',
      value: 'Generated 2 images with GPT Image 1; they are shown to the user below this call.',
    })
    const one = { modelRef: 'mock:image', modelName: 'Mock Image', images: [ref(1)] }
    expect(await tool.toModelOutput!(one, { toolCallId: 'call_1', input: { prompt: 'a fox' } })).toEqual({
      type: 'text',
      value: 'Generated 1 image with Mock Image; it is shown to the user below this call.',
    })
  })

  it('names the model ref for an output stored before Phase 7 (no modelName)', async () => {
    const tool = createGenerateImageTool(fakeImages())
    const two = { modelRef: 'openai:gpt-image-1', images: [ref(1), ref(2)], costUsd: 0.1 }
    expect(await tool.toModelOutput!(two, { toolCallId: 'call_1', input: { prompt: 'a fox' } })).toEqual({
      type: 'text',
      value: 'Generated 2 images with openai:gpt-image-1; they are shown to the user below this call.',
    })
    const one = { modelRef: 'mock:image', images: [ref(1)] }
    expect(await tool.toModelOutput!(one, { toolCallId: 'call_1', input: { prompt: 'a fox' } })).toEqual({
      type: 'text',
      value: 'Generated 1 image with mock:image; it is shown to the user below this call.',
    })
    expect(generatedImagesText(4, 'xai:grok-imagine-image')).toBe('Generated 4 images with xai:grok-imagine-image; they are shown to the user below this call.')
  })

  it('falls back to the JSON of an unexpected output', async () => {
    const tool = createGenerateImageTool(fakeImages())
    expect(await tool.toModelOutput!({ changed: true } as never, { toolCallId: 'call_1', input: { prompt: 'a fox' } })).toEqual({ type: 'json', value: { changed: true } })
  })

  it('cuts text to a JSON byte budget on a code point boundary', () => {
    expect(fitJsonBytes('hello', 100)).toBe('hello')
    expect(fitJsonBytes('hello world', 7)).toBe('hello')
    const cut = fitJsonBytes('\u{1F98A}'.repeat(10), 16)
    expect(cut).toBe('\u{1F98A}'.repeat(3))
    expect(Buffer.byteLength(JSON.stringify(cut), 'utf8')).toBe(14)
    // Escapes count with their escaped size: `\"` is 2 bytes, a control character 6 (`\u0001`).
    expect(fitJsonBytes('"a"b', 6)).toBe('"a')
    expect(fitJsonBytes('\u0001\u0001', 9)).toBe('\u0001')
  })
})

describe('generate_image in the plugin host (real image service, fake resolvers)', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp({
      env: { HF_MOCK_PROVIDER: '1' },
      builtins: BUILTIN_PLUGINS.filter(plugin => plugin.id === 'core-tools' || plugin.id === 'mock'),
      factories: { providers: fakeMediaProviders() },
    })
    await t.deps.chats.ensure(CHAT_ID)
  })

  afterAll(async () => {
    await t.close()
  })

  it('is registered by core-tools even without an image model and then fails with the settings hint', async () => {
    const registered = t.deps.registry.tools.get('generate_image')
    expect(registered).toMatchObject({ pluginId: 'core-tools', mcpServerId: null, definition: { policy: 'ask', timeoutMs: 300_000 } })
    expect((await t.deps.settings.get()).imageModelRef).toBeNull()
    await expect(registered!.definition.execute({ prompt: 'a lighthouse' }, context())).rejects.toMatchObject({ code: 'validation_error', message: 'Choose an image model in Settings → Media.' })
  })

  it('generates with the imageModelRef setting, stores the files and records the usage of the chat', async () => {
    await t.deps.settings.update({ imageModelRef: 'mock:image' })
    try {
      const definition = t.deps.registry.tools.get('generate_image')!.definition
      const output = generateImageToolOutputSchema.parse(await definition.execute({ prompt: 'a lighthouse at dusk', n: 2, aspectRatio: '16:9' }, context()))
      expect(output.modelRef).toBe('mock:image')
      // The catalog name, passed from the image service through ctx.images (plugin API 1.2.0).
      expect(output.modelName).toBe('Mock Image')
      expect(output.images).toHaveLength(2)
      for (const image of output.images) {
        expect(image).toMatchObject({ url: `/api/files/${image.fileId}`, mediaType: 'image/png', name: expect.stringMatching(/^image-\d\.png$/) })
        expect((await t.deps.files.get(image.fileId))?.mime).toBe('image/png')
      }
      // mock:image prices (USD 1 / 2 per 1M tokens): 4 prompt words in, 2 x 100 tokens out.
      expect(output.costUsd).toBe(0.000404)
      expect(output.revisedPrompt).toBe('Mock: a lighthouse at dusk')
      const rows = await t.db.select().from(usage)
      expect(rows).toEqual([expect.objectContaining({ chatId: CHAT_ID, messageId: null, purpose: 'image', providerId: 'mock', modelId: 'image', input: 4, output: 200 })])
      expect(await definition.toModelOutput!(output, { toolCallId: 'call_1', input: { prompt: 'a lighthouse at dusk' } })).toEqual({
        type: 'text',
        value: 'Generated 2 images with Mock Image; they are shown to the user below this call.',
      })
    }
    finally {
      await t.deps.settings.update({ imageModelRef: null })
    }
  })

  it('fails with provider_not_configured when the image model\'s provider is unknown (Phase 7)', async () => {
    await t.deps.settings.update({ imageModelRef: 'nope:paint' })
    try {
      const definition = t.deps.registry.tools.get('generate_image')!.definition
      await expect(definition.execute({ prompt: 'a lighthouse' }, context())).rejects.toMatchObject({
        code: 'provider_not_configured',
        action: 'configure-provider',
        providerId: 'nope',
        message: 'The provider "nope" is not available. Pick another model or install the provider.',
      })
    }
    finally {
      await t.deps.settings.update({ imageModelRef: null })
    }
  })
})
