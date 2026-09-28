import type { ImageModelV4, SharedV4ProviderOptions } from '@ai-sdk/provider'
import type { ProviderDefinition } from '@harness-forge/plugin-sdk'
import type { ModelCost } from '@harness-forge/shared'
import type { ProviderCallOutcome, ResolvedImageModel } from '../../providers/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { ImageGenerationInput } from './types.ts'
import { APICallError } from '@ai-sdk/provider'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { MockImageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_PLUGINS } from '../../builtin-plugins/index.ts'
import { abortableDelay } from '../../builtin-plugins/mock/common.ts'
import { mockImagePng, mockImageSize, mockImageUsage } from '../../builtin-plugins/mock/media.ts'
import { MOCK_AUTH_FAILURE, MOCK_ERROR_URL } from '../../builtin-plugins/mock/models.ts'
import { encodeSolidPng } from '../../builtin-plugins/mock/png.ts'
import { usage } from '../../db/schema.ts'
import { fakeMediaProviders } from '../../providers/testing.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { BMP, PDF, SVG } from '../files/fixtures.test-util.ts'
import { IMAGE_MAX_RETRIES, NO_IMAGE_MODEL_MESSAGE } from './index.ts'

type DoGenerate = ImageModelV4['doGenerate']
type CallOptions = Parameters<DoGenerate>[0]
type ModelResult = Awaited<ReturnType<DoGenerate>>

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'
const RED = encodeSolidPng(4, 3, [255, 0, 0])
const BLUE = encodeSolidPng(3, 4, [0, 0, 255])

/** A model answer with the given images (and optional usage / metadata). */
function answer(images: Uint8Array[], extra: Partial<ModelResult> = {}): ModelResult {
  return { images, warnings: [], response: { timestamp: new Date(0), modelId: 'image', headers: undefined }, ...extra }
}

/** The default answer: `n` mock PNGs with the usage of `mock:image`. */
const defaultAnswer: DoGenerate = async (options) => {
  const prompt = options.prompt ?? ''
  const size = mockImageSize({ size: options.size, aspectRatio: options.aspectRatio })
  return answer(Array.from({ length: options.n }, (_, index) => mockImagePng(prompt, index, size, options.files ?? [])), { usage: mockImageUsage(prompt, options.n) })
}

function apiError(statusCode: number, extra: Partial<ConstructorParameters<typeof APICallError>[0]> = {}): APICallError {
  return new APICallError({ message: `HTTP ${statusCode}`, url: 'https://images.example.com/v1/generate', requestBodyValues: {}, statusCode, isRetryable: false, ...extra })
}

let t: TestApp
/** What the `mock:image` model of the fake resolvers answers (replaced per test). */
let doGenerate: DoGenerate = defaultAnswer
const calls: CallOptions[] = []
const outcomes: Array<{ providerId: string, outcome: ProviderCallOutcome }> = []

/** `mock:image` of the fake resolvers: records every call, answers with `doGenerate`. */
const imageModel = new MockImageModelV4({
  provider: 'mock',
  modelId: 'image',
  maxImagesPerCall: LIMITS.imagesPerTurnMax,
  doGenerate: async (options) => {
    calls.push(options)
    return doGenerate(options)
  },
})

beforeAll(async () => {
  const mock = BUILTIN_PLUGINS.filter(plugin => plugin.id === 'mock')
  t = await createTestApp({
    env: { HF_MOCK_PROVIDER: '1' },
    builtins: mock,
    factories: {
      providers: (deps) => {
        const service = fakeMediaProviders({ imageModels: { 'mock:image': imageModel } })(deps)
        return {
          ...service,
          recordOutcome: async (providerId, outcome) => {
            outcomes.push({ providerId, outcome })
            await service.recordOutcome(providerId, outcome)
          },
        }
      },
    },
  })
  await t.deps.chats.ensure(CHAT_ID)
})

beforeEach(async () => {
  doGenerate = defaultAnswer
  calls.length = 0
  outcomes.length = 0
  t.logs.records.length = 0
  await t.db.delete(usage)
  await t.deps.settings.update({ imageModelRef: null })
})

afterAll(async () => {
  await t.close()
})

function signal(): AbortSignal {
  return new AbortController().signal
}

function input(overrides: Partial<ImageGenerationInput> = {}): ImageGenerationInput {
  return { modelRef: 'mock:image', prompt: 'a red fox', n: 1, signal: signal(), chatId: null, messageId: null, ...overrides }
}

/** `mock:image` resolved, with another model, provider members or catalog price. */
async function resolved(overrides: { definition?: Partial<ProviderDefinition>, cost?: ModelCost | null } = {}): Promise<ResolvedImageModel> {
  const base = await t.deps.providers.resolveImageModel('mock:image')
  return {
    ...base,
    entry: overrides.cost === undefined ? base.entry : { ...base.entry, cost: overrides.cost },
    provider: overrides.definition === undefined ? base.provider : { ...base.provider, definition: { ...base.provider.definition, ...overrides.definition } },
  }
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

async function usageRows() {
  return t.db.select().from(usage)
}

describe('image service: generation', () => {
  it('generates, stores every image, writes the usage row, records the outcome and logs no prompt', async () => {
    doGenerate = async () => answer([RED, BLUE], {
      usage: { inputTokens: 1000, outputTokens: 5000, totalTokens: 6000 },
      providerMetadata: { mock: { images: [{ revisedPrompt: 'A revised fox' }, {}] } },
    })
    const result = await t.deps.images.generate(input({
      modelRef: undefined,
      resolved: await resolved({ cost: { input: 5, output: 40 } }),
      prompt: '  a red fox  ',
      n: 2,
      aspectRatio: '16:9',
      chatId: CHAT_ID,
      messageId: 'msg_AAAAAAAAAAAAAAAA',
    }))
    expect(result).toMatchObject({
      modelRef: 'mock:image',
      usage: { inputTokens: 1000, outputTokens: 5000, totalTokens: 6000 },
      costUsd: 0.205,
      revisedPrompt: 'A revised fox',
      dropped: 0,
    })
    expect(result.images.map(image => [image.file.name, image.file.mime, image.url])).toEqual([
      ['image-1.png', 'image/png', `/api/files/${result.images[0]?.file.id}`],
      ['image-2.png', 'image/png', `/api/files/${result.images[1]?.file.id}`],
    ])
    expect((await t.deps.files.read(result.images[0]!.file.id)).data).toEqual(RED)
    expect((await t.deps.files.read(result.images[1]!.file.id)).data).toEqual(BLUE)

    expect(calls).toHaveLength(1)
    // The mock provider's imageParams passes the aspect ratio through (and as a provider option).
    expect(calls[0]).toMatchObject({ prompt: 'a red fox', n: 2, aspectRatio: '16:9', size: undefined, files: undefined, providerOptions: { mock: { aspectRatio: '16:9' } } })
    expect(calls[0]?.abortSignal).toBeInstanceOf(AbortSignal)

    expect(await usageRows()).toEqual([expect.objectContaining({
      chatId: CHAT_ID,
      messageId: 'msg_AAAAAAAAAAAAAAAA',
      purpose: 'image',
      providerId: 'mock',
      modelId: 'image',
      input: 1000,
      output: 5000,
      reasoning: 0,
      costUsd: 0.205,
    })])
    expect(outcomes).toEqual([{ providerId: 'mock', outcome: { ok: true } }])

    const line = t.logs.records.find(record => record.msg === 'image generated')
    expect(line).toMatchObject({ level: 'info', chatId: CHAT_ID, providerId: 'mock', modelId: 'image', n: 2, aspectRatio: '16:9', inputs: 0, stored: 2, dropped: 0, bytes: RED.byteLength + BLUE.byteLength, inputTokens: 1000, outputTokens: 5000, costUsd: 0.205, ms: expect.any(Number) })
    expect(t.logs.text()).not.toContain('red fox')
  })

  it('resolves modelRef, else the imageModelRef setting; neither is a validation_error', async () => {
    const none = await rejection(t.deps.images.generate(input({ modelRef: undefined })))
    expect(none.toJSON().error).toMatchObject({ code: 'validation_error', message: NO_IMAGE_MODEL_MESSAGE, details: { issues: [{ path: ['modelRef'] }] } })
    expect(calls).toEqual([])

    await t.deps.settings.update({ imageModelRef: 'mock:image' })
    const fromSettings = await t.deps.images.generate(input({ modelRef: undefined }))
    expect(fromSettings).toMatchObject({ modelRef: 'mock:image', usage: { inputTokens: 3, outputTokens: 100, totalTokens: 103 }, costUsd: 0.000203, dropped: 0 })
    expect(fromSettings.images).toHaveLength(1)
    expect('revisedPrompt' in fromSettings).toBe(false)

    // A model that is not an image model: the resolver's validation_error.
    expect((await rejection(t.deps.images.generate(input({ modelRef: 'mock:echo' })))).code).toBe('validation_error')
  })

  it('reports no usage and no cost when the provider reports no token counts (still one usage row)', async () => {
    doGenerate = async () => answer([RED])
    const result = await t.deps.images.generate(input({ chatId: CHAT_ID }))
    expect(result).toMatchObject({ usage: null, costUsd: null })
    expect(await usageRows()).toEqual([expect.objectContaining({ chatId: CHAT_ID, messageId: null, purpose: 'image', input: 0, output: 0, costUsd: null })])
  })

  it('attributes the usage row to no chat when the chat does not exist', async () => {
    await t.deps.images.generate(input({ chatId: '0199a8f0-0000-7000-8000-00000000abcd' }))
    expect(await usageRows()).toEqual([expect.objectContaining({ chatId: null, purpose: 'image' })])
  })
})

describe('image service: request mapping', () => {
  it('maps the request with imageParams to size, aspect ratio and provider options', async () => {
    const requests: unknown[] = []
    const definition: Partial<ProviderDefinition> = {
      imageParams: (request, info) => {
        requests.push({ request, model: info.id })
        return { size: '1536x1024', providerOptions: { openai: { quality: 'high' } } }
      },
    }
    await t.deps.images.generate(input({ resolved: await resolved({ definition }), aspectRatio: '3:2', n: 3 }))
    expect(requests).toEqual([{ request: { n: 3, aspectRatio: '3:2', inputs: 0 }, model: 'image' }])
    expect(calls[0]).toMatchObject({ n: 3, size: '1536x1024', aspectRatio: undefined, providerOptions: { openai: { quality: 'high' } } })
  })

  it('passes the aspect ratio as is when the provider has no imageParams, and nothing for Auto', async () => {
    await t.deps.images.generate(input({ resolved: await resolved({ definition: { imageParams: undefined } }), aspectRatio: '9:16' }))
    await t.deps.images.generate(input({ resolved: await resolved({ definition: { imageParams: undefined } }) }))
    expect(calls.map(call => [call.size, call.aspectRatio, call.providerOptions])).toEqual([[undefined, '9:16', {}], [undefined, undefined, {}]])
  })

  it('ignores a throwing imageParams and the malformed parts of its result', async () => {
    const throwing: Partial<ProviderDefinition> = {
      imageParams: () => {
        throw new Error('imageParams exploded')
      },
    }
    await t.deps.images.generate(input({ resolved: await resolved({ definition: throwing }), aspectRatio: '1:1' }))
    const malformed = { imageParams: () => ({ size: 'huge', aspectRatio: 'wide', providerOptions: { openai: 'x' } as unknown as SharedV4ProviderOptions }) } as unknown as Partial<ProviderDefinition>
    await t.deps.images.generate(input({ resolved: await resolved({ definition: malformed }), aspectRatio: '1:1' }))
    expect(calls.map(call => [call.size, call.aspectRatio, call.providerOptions])).toEqual([[undefined, undefined, {}], [undefined, undefined, {}]])
    expect(t.logs.records.some(record => record.level === 'warn' && record.msg === 'provider imageParams() failed')).toBe(true)
  })

  it('sends stored images with the prompt (an edit) and counts them as inputs', async () => {
    const uploaded = await t.deps.files.upload(new File([RED], 'input.png', { type: 'image/png' }))
    const requests: unknown[] = []
    const definition: Partial<ProviderDefinition> = {
      imageParams: (request) => {
        requests.push(request)
        return undefined
      },
    }
    await t.deps.images.generate(input({ resolved: await resolved({ definition }), prompt: 'make it blue', inputFileIds: [uploaded.id] }))
    expect(requests).toEqual([{ n: 1, inputs: 1 }])
    expect(calls[0]?.prompt).toBe('make it blue')
    expect(calls[0]?.files).toEqual([{ type: 'file', data: RED, mediaType: 'image/png' }])
    expect(t.logs.records.find(record => record.msg === 'image generated')).toMatchObject({ inputs: 1 })
  })

  it('refuses unknown, non-image and too many input files before calling the model', async () => {
    expect((await rejection(t.deps.images.generate(input({ inputFileIds: ['file_0000000000000000'] })))).code).toBe('not_found')
    const pdf = await t.deps.files.upload(new File([PDF], 'doc.pdf', { type: 'application/pdf' }))
    const svg = await t.deps.files.upload(new File([SVG], 'logo.svg', { type: 'image/svg+xml' }))
    for (const id of [pdf.id, svg.id])
      expect((await rejection(t.deps.images.generate(input({ inputFileIds: [id] })))).toJSON().error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['inputFileIds'] }] } })
    const five = Array.from<string>({ length: LIMITS.imageInputsMax + 1 }).fill(pdf.id)
    expect((await rejection(t.deps.images.generate(input({ inputFileIds: five })))).message).toBe(`At most ${LIMITS.imageInputsMax} input images.`)
    expect(calls).toEqual([])
  })
})

describe('image service: input checks', () => {
  it('refuses an empty or too long prompt, a bad count and an unknown aspect ratio', async () => {
    const cases: Array<[Partial<ImageGenerationInput>, string]> = [
      [{ prompt: '   ' }, 'prompt'],
      [{ prompt: 'x'.repeat(LIMITS.imagePromptMaxChars + 1) }, 'prompt'],
      [{ n: 0 }, 'n'],
      [{ n: LIMITS.imagesPerTurnMax + 1 }, 'n'],
      [{ n: 1.5 }, 'n'],
      [{ aspectRatio: '5:4' as never }, 'aspectRatio'],
    ]
    for (const [overrides, path] of cases) {
      const error = await rejection(t.deps.images.generate(input(overrides)))
      expect(error.toJSON().error, path).toMatchObject({ code: 'validation_error', details: { issues: [{ path: [path] }] } })
    }
    // The limit counts characters, not UTF-16 code units.
    await t.deps.images.generate(input({ prompt: '\u{1F98A}'.repeat(LIMITS.imagePromptMaxChars) }))
    expect(calls).toHaveLength(1)
  })
})

describe('image service: dropped images', () => {
  it('counts the images saveGenerated refuses in dropped and keeps the others', async () => {
    const huge = new Uint8Array(LIMITS.generatedImageBytes + 1)
    huge.set(RED)
    const kept = encodeSolidPng(5, 5, [1, 2, 3])
    // SVG markup is labelled image/png by the SDK (unknown signature): its bytes do not match; BMP is not an allowed type.
    doGenerate = async () => answer([SVG, kept, BMP, huge], { usage: { inputTokens: 3, outputTokens: 400, totalTokens: 403 } })
    const result = await t.deps.images.generate(input({ n: 4, chatId: CHAT_ID }))
    expect(result.dropped).toBe(3)
    expect(result.images.map(image => image.file.name)).toEqual(['image-2.png'])
    expect(t.logs.records.filter(record => record.msg === 'generated image dropped').map(record => record.reason)).toEqual(['validation_error', 'validation_error', 'payload_too_large'])
    expect(t.logs.records.find(record => record.msg === 'image generated')).toMatchObject({ stored: 1, dropped: 3 })
    expect(await usageRows()).toHaveLength(1)
  })

  it('returns an empty image list when every image was refused', async () => {
    doGenerate = async () => answer([SVG])
    expect(await t.deps.images.generate(input())).toMatchObject({ images: [], dropped: 1 })
  })
})

describe('image service: abort', () => {
  it('rejects with the abort reason, records no outcome and writes no usage row', async () => {
    doGenerate = async (options) => {
      await abortableDelay(30_000, options.abortSignal)
      return answer([RED])
    }
    const controller = new AbortController()
    const pending = t.deps.images.generate(input({ signal: controller.signal, chatId: CHAT_ID }))
    await new Promise(resolve => setTimeout(resolve, 20))
    const reason = new DOMException('Stopped by the user.', 'AbortError')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(outcomes).toEqual([])
    expect(await usageRows()).toEqual([])
  })

  it('never calls the model with an already aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(t.deps.images.generate(input({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toEqual([])
  })

  it('writes the usage row but stores nothing when the model answers after the abort', async () => {
    const controller = new AbortController()
    doGenerate = async () => {
      controller.abort()
      return answer([RED], { usage: { inputTokens: 3, outputTokens: 100, totalTokens: 103 } })
    }
    await expect(t.deps.images.generate(input({ signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' })
    expect(await usageRows()).toEqual([expect.objectContaining({ purpose: 'image', input: 3, output: 100 })])
    expect(outcomes).toEqual([])
  })
})

describe('image service: errors', () => {
  it('maps provider errors with the provider mapping and records them as the provider outcome', async () => {
    doGenerate = async () => {
      throw apiError(429, { responseHeaders: { 'retry-after': '3' } })
    }
    const limited = await rejection(t.deps.images.generate(input({ chatId: CHAT_ID })))
    expect(limited.toJSON().error).toMatchObject({ code: 'rate_limited', providerId: 'mock', status: 429, retryAfterMs: 3000, action: 'retry' })
    expect(outcomes).toEqual([{ providerId: 'mock', outcome: { ok: false, error: expect.objectContaining({ code: 'rate_limited' }) } }])
    expect(await usageRows()).toEqual([])
    const line = t.logs.records.find(record => record.msg === 'image generation failed')
    expect(line).toMatchObject({ level: 'warn', providerId: 'mock', modelId: 'image', code: 'rate_limited', status: 429 })
    expect(t.logs.text()).not.toContain('red fox')
  })

  it('lets the provider definition map its own errors first', async () => {
    doGenerate = async () => {
      throw new APICallError({ message: 'bad key', url: MOCK_ERROR_URL, requestBodyValues: {}, statusCode: 401, isRetryable: false })
    }
    const error = await rejection(t.deps.images.generate(input()))
    expect(error.toJSON().error).toMatchObject({ code: 'auth_invalid', message: MOCK_AUTH_FAILURE, providerId: 'mock', action: 'configure-provider' })
    expect(outcomes[0]?.outcome).toMatchObject({ ok: false, error: { code: 'auth_invalid' } })
  })

  it('answers provider_error when the provider returns no image', async () => {
    doGenerate = async () => answer([], { isRetryable: false })
    const error = await rejection(t.deps.images.generate(input()))
    expect(error.toJSON().error).toMatchObject({ code: 'provider_error', message: 'Mock (dev only) returned no image.', providerId: 'mock', action: 'retry' })
    expect(outcomes[0]?.outcome).toMatchObject({ ok: false, error: { code: 'provider_error' } })
  })

  it(`retries a retryable failure ${IMAGE_MAX_RETRIES} time`, async () => {
    let attempts = 0
    doGenerate = async (options) => {
      attempts += 1
      if (attempts === 1)
        throw apiError(503, { isRetryable: true, responseHeaders: { 'retry-after-ms': '1' } })
      return defaultAnswer(options)
    }
    expect((await t.deps.images.generate(input())).images).toHaveLength(1)
    expect(attempts).toBe(2)

    attempts = 0
    doGenerate = async () => {
      attempts += 1
      throw apiError(503, { isRetryable: true, responseHeaders: { 'retry-after-ms': '1' } })
    }
    expect((await rejection(t.deps.images.generate(input()))).toJSON().error).toMatchObject({ code: 'provider_error', status: 503 })
    expect(attempts).toBe(1 + IMAGE_MAX_RETRIES)
  })

  it('does not record resolver and input errors as provider outcomes', async () => {
    await rejection(t.deps.images.generate(input({ modelRef: 'mock:nope' })))
    await rejection(t.deps.images.generate(input({ prompt: '' })))
    expect(outcomes).toEqual([])
  })
})
