// Image, transcription and speech support of the builtin providers (PROVIDERS.md section 13): which providers define
// which members, the seeds, the request mappings (`imageParams`, `transcriptionOptions`) and what reaches the wire
// through the AI SDK calls the host makes (`generateImage`, `generateText`, `transcribe`, `generateSpeech`), answered by
// a fake `fetch`.
import type { ModelInfo, ProviderDefinition } from '@harness-forge/plugin-sdk'
import type { FakeRoute, RecordedFile, RecordedRequest } from '../testing.ts'
import { Buffer } from 'node:buffer'
import { modelInfoSchema } from '@harness-forge/plugin-sdk'
import { IMAGE_ASPECT_RATIOS } from '@harness-forge/shared'
import { generateImage, generateSpeech, generateText, transcribe } from 'ai'
import { describe, expect, it } from 'vitest'
import { chatCompletion, fakeRuntime, jsonResponse } from '../testing.ts'
import { GEMINI_TTS_VOICES } from './google.ts'
import { PROVIDER_DEFINITIONS } from './index.ts'
import { OPENAI_GPT_TTS_VOICES, OPENAI_TTS_VOICES, openaiImageSize } from './openai.ts'
import { XAI_VOICES } from './xai.ts'

type MediaKind = 'image' | 'transcription' | 'speech'

function provider(id: string): ProviderDefinition {
  const definition = PROVIDER_DEFINITIONS.find(candidate => candidate.id === id)
  if (!definition)
    throw new Error(`Unknown provider "${id}"`)
  return definition
}

/** The members of a definition, failing the test when one is missing. */
function need<K extends keyof ProviderDefinition>(definition: ProviderDefinition, key: K): NonNullable<ProviderDefinition[K]> {
  const member = definition[key]
  if (member === undefined)
    throw new Error(`${definition.id} has no ${key}`)
  return member as NonNullable<ProviderDefinition[K]>
}

// PROVIDERS.md section 13, "Support by provider": the `provider` of each created model instance.
interface Support {
  image?: string
  transcription?: string
  speech?: string
  imageParams?: true
  transcriptionOptions?: true
}
const SUPPORT: Record<string, Support> = {
  openai: { image: 'openai.image', transcription: 'openai.transcription', speech: 'openai.speech', imageParams: true, transcriptionOptions: true },
  google: { transcription: 'google.generative-ai.transcription', speech: 'google.generative-ai.speech', imageParams: true, transcriptionOptions: true },
  xai: { image: 'xai.image', transcription: 'xai.transcription', speech: 'xai.speech', imageParams: true, transcriptionOptions: true },
  mistral: { transcription: 'mistral.transcription', speech: 'mistral.speech', transcriptionOptions: true },
  groq: { transcription: 'groq.transcription', transcriptionOptions: true },
  openrouter: { imageParams: true },
}

// PROVIDERS.md section 13, "Seeds" (explicit kinds, always listed).
const MEDIA_SEEDS: Record<string, Partial<Record<MediaKind, string[]>>> = {
  openai: {
    image: ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5'],
    transcription: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
    speech: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
  },
  xai: { image: ['grok-imagine-image'], transcription: ['stt'], speech: ['tts'] },
  google: { speech: ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'] },
  mistral: { transcription: ['voxtral-mini-latest'], speech: ['voxtral-mini-tts-latest'] },
  groq: { transcription: ['whisper-large-v3-turbo', 'whisper-large-v3'] },
}

const FACTORIES = {
  image: 'createImageModel',
  transcription: 'createTranscriptionModel',
  speech: 'createSpeechModel',
} as const satisfies Record<MediaKind, keyof ProviderDefinition>

function seedsOf(definition: ProviderDefinition, kind: MediaKind): ModelInfo[] {
  return (definition.seedModels ?? []).filter(seed => seed.kind === kind)
}

/** A 1x1 transparent PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'))

/** A short silent 16-bit mono WAV (8 kHz). */
function wav(samples = 800): Uint8Array {
  const data = samples * 2
  const buffer = Buffer.alloc(44 + data)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + data, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8000, 24)
  buffer.writeUInt32LE(16_000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(data, 40)
  return new Uint8Array(buffer)
}

/** MP3-looking bytes (an ID3 tag header, zero padded). */
const MP3_BYTES = new Uint8Array(64)
MP3_BYTES.set([0x49, 0x44, 0x33, 0x04])

function binaryResponse(bytes: Uint8Array, type: string): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': type } })
}

/** Answers by exact URL; any other request fails the test. */
function routes(table: Record<string, FakeRoute>): FakeRoute {
  return (request) => {
    const handler = table[request.url]
    if (!handler)
      throw new Error(`Unexpected request: ${request.method} ${request.url}`)
    return handler(request)
  }
}

function only(requests: readonly RecordedRequest[]): RecordedRequest {
  expect(requests).toHaveLength(1)
  return requests[0] as RecordedRequest
}

function fields(request: RecordedRequest): Record<string, unknown> {
  return request.body as Record<string, unknown>
}

describe('media members (PROVIDERS.md 13)', () => {
  it.each(PROVIDER_DEFINITIONS.map(definition => [definition.id, definition] as const))('%s defines exactly the documented members', (id, definition) => {
    const support = SUPPORT[id] ?? {}
    expect(typeof definition.createImageModel === 'function', 'createImageModel').toBe(support.image !== undefined)
    expect(typeof definition.createTranscriptionModel === 'function', 'createTranscriptionModel').toBe(support.transcription !== undefined)
    expect(typeof definition.createSpeechModel === 'function', 'createSpeechModel').toBe(support.speech !== undefined)
    expect(typeof definition.imageParams === 'function', 'imageParams').toBe(support.imageParams === true)
    expect(typeof definition.transcriptionOptions === 'function', 'transcriptionOptions').toBe(support.transcriptionOptions === true)
  })

  it.each(Object.entries(SUPPORT))('%s creates media model instances without network access', (id, support) => {
    const definition = provider(id)
    const { rt, requests } = fakeRuntime({ apiKey: 'test-key' })
    for (const kind of ['image', 'transcription', 'speech'] as const) {
      const expected = support[kind]
      if (expected === undefined)
        continue
      const factory = need(definition, FACTORIES[kind]) as (modelId: string, runtime: typeof rt) => { specificationVersion: string, provider: string, modelId: string }
      for (const modelId of [...seedsOf(definition, kind).map(seed => seed.id), 'custom-model']) {
        const model = factory(modelId, rt)
        expect(model.specificationVersion, `${kind} ${modelId}`).toBe('v4')
        expect(model.provider, `${kind} ${modelId}`).toBe(expected)
        // xAI serves one speech-to-text and one text-to-speech endpoint: its factories take no model id.
        expect(model.modelId, `${kind} ${modelId}`).toBe(id === 'xai' && kind !== 'image' ? '' : modelId)
      }
    }
    expect(requests).toEqual([])
  })

  it('honors a base URL override and an unresolved key without throwing', () => {
    const { rt } = fakeRuntime({ baseURL: 'https://proxy.example.com/v1/' })
    for (const [id, support] of Object.entries(SUPPORT)) {
      const definition = provider(id)
      if (support.image)
        expect(need(definition, 'createImageModel')('some-image-model', rt).specificationVersion).toBe('v4')
      if (support.transcription)
        expect(need(definition, 'createTranscriptionModel')('some-stt-model', rt).specificationVersion).toBe('v4')
      if (support.speech)
        expect(need(definition, 'createSpeechModel')('some-tts-model', rt).specificationVersion).toBe('v4')
    }
  })
})

describe('media seeds (PROVIDERS.md 13)', () => {
  it.each(PROVIDER_DEFINITIONS.map(definition => [definition.id, definition] as const))('%s seeds the documented media models with explicit kinds', (id, definition) => {
    const expected = MEDIA_SEEDS[id] ?? {}
    for (const kind of ['image', 'transcription', 'speech'] as const) {
      const seeds = seedsOf(definition, kind)
      expect(seeds.map(seed => seed.id), kind).toEqual(expected[kind] ?? [])
      for (const seed of seeds) {
        expect(modelInfoSchema.safeParse(seed).success, seed.id).toBe(true)
        // Every media seed can be served: the provider defines the matching factory.
        expect(typeof definition[FACTORIES[kind]], seed.id).toBe('function')
        expect(seed.name, seed.id).toBeTruthy()
        if (kind === 'image')
          expect(seed.capabilities, seed.id).toEqual({ vision: true })
        else
          expect(seed.capabilities, seed.id).toBeUndefined()
        if (kind !== 'speech')
          expect(seed.voices, seed.id).toBeUndefined()
      }
    }
    // `gemini-3.5-transcribe` exists only in the package's id union: not seeded.
    expect((definition.seedModels ?? []).some(seed => seed.id.includes('gemini-3.5-transcribe'))).toBe(false)
  })

  it('carries the voice suggestions of PROVIDERS.md 13 (unique, at most 100)', () => {
    const voices = (id: string, modelId: string) => provider(id).seedModels?.find(seed => seed.id === modelId)?.voices
    expect(voices('openai', 'tts-1')).toEqual(['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'])
    expect(voices('openai', 'tts-1-hd')).toEqual([...OPENAI_TTS_VOICES])
    expect(voices('openai', 'gpt-4o-mini-tts')).toEqual([...OPENAI_TTS_VOICES, 'ballad', 'verse', 'marin', 'cedar'])
    expect(OPENAI_GPT_TTS_VOICES).toHaveLength(13)
    for (const modelId of MEDIA_SEEDS.google?.speech ?? [])
      expect(voices('google', modelId)).toEqual([...GEMINI_TTS_VOICES])
    expect(GEMINI_TTS_VOICES).toHaveLength(30)
    expect(GEMINI_TTS_VOICES).toContain('Kore')
    expect(voices('xai', 'tts')).toEqual(['eve', 'ara', 'leo', 'rex', 'sal'])
    expect(XAI_VOICES[0]).toBe('eve')
    // No voice list is known for Mistral: the field takes a voice id from the Mistral console.
    expect(voices('mistral', 'voxtral-mini-tts-latest')).toBeUndefined()
    for (const list of [OPENAI_GPT_TTS_VOICES, GEMINI_TTS_VOICES, XAI_VOICES]) {
      expect(new Set(list).size).toBe(list.length)
      expect(modelInfoSchema.safeParse({ id: 'x', kind: 'speech', voices: [...list] }).success).toBe(true)
    }
  })
})

describe('imageParams', () => {
  it('openai: square, portrait and landscape sizes; Auto sends nothing', () => {
    const imageParams = need(provider('openai'), 'imageParams')
    const model: ModelInfo = { id: 'gpt-image-1', kind: 'image' }
    const expected = {
      '1:1': '1024x1024',
      '2:3': '1024x1536',
      '3:4': '1024x1536',
      '9:16': '1024x1536',
      '3:2': '1536x1024',
      '4:3': '1536x1024',
      '16:9': '1536x1024',
    } as const
    for (const aspectRatio of IMAGE_ASPECT_RATIOS) {
      expect(imageParams({ n: 2, aspectRatio, inputs: 0 }, model), aspectRatio).toEqual({ size: expected[aspectRatio] })
      expect(imageParams({ n: 1, aspectRatio, inputs: 1 }, model), `${aspectRatio} edit`).toEqual({ size: expected[aspectRatio] })
    }
    expect(imageParams({ n: 1, inputs: 0 }, model)).toBeUndefined()
    expect(openaiImageSize(undefined)).toBeUndefined()
    expect(openaiImageSize('constructor' as never)).toBeUndefined()
  })

  it('xai: the aspect ratio passed through; Auto sends nothing', () => {
    const imageParams = need(provider('xai'), 'imageParams')
    const model: ModelInfo = { id: 'grok-imagine-image', kind: 'image' }
    for (const aspectRatio of IMAGE_ASPECT_RATIOS)
      expect(imageParams({ n: 3, aspectRatio, inputs: 0 }, model)).toEqual({ aspectRatio })
    expect(imageParams({ n: 1, inputs: 0 }, model)).toBeUndefined()
  })

  it('google: text and image modalities, plus the aspect ratio when set', () => {
    const imageParams = need(provider('google'), 'imageParams')
    const model: ModelInfo = { id: 'gemini-2.5-flash-image', capabilities: { imageOutput: true } }
    expect(imageParams({ n: 1, aspectRatio: '3:4', inputs: 0 }, model)).toEqual({
      providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '3:4' } } },
    })
    expect(imageParams({ n: 1, inputs: 0 }, model)).toEqual({ providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'] } } })
  })

  it('openrouter: image and text modalities in the request body, plus the aspect ratio when set', () => {
    const imageParams = need(provider('openrouter'), 'imageParams')
    const model: ModelInfo = { id: 'google/gemini-2.5-flash-image', capabilities: { imageOutput: true } }
    expect(imageParams({ n: 1, aspectRatio: '16:9', inputs: 0 }, model)).toEqual({
      providerOptions: { openrouter: { modalities: ['image', 'text'], image_config: { aspect_ratio: '16:9' } } },
    })
    expect(imageParams({ n: 1, inputs: 0 }, model)).toEqual({ providerOptions: { openrouter: { modalities: ['image', 'text'] } } })
  })
})

describe('transcriptionOptions', () => {
  const expected: Record<string, unknown> = {
    openai: { openai: { language: 'de' } },
    google: { google: { languageCodes: ['de'] } },
    xai: { xai: { language: 'de' } },
    mistral: { mistral: { language: 'de' } },
    groq: { groq: { language: 'de' } },
  }

  it.each(Object.entries(expected))('%s: the language under its provider key; nothing for auto', (id, options) => {
    const transcriptionOptions = need(provider(id), 'transcriptionOptions')
    expect(transcriptionOptions({ language: 'de' })).toEqual(options)
    expect(transcriptionOptions({ language: ' DE ' })).toEqual(options)
    expect(transcriptionOptions({})).toBeUndefined()
    expect(transcriptionOptions({ language: 'auto' })).toBeUndefined()
    expect(transcriptionOptions({ language: '  ' })).toBeUndefined()
  })
})

describe('image requests on the wire', () => {
  function openaiImages(request: RecordedRequest): Response {
    const n = request.body instanceof Object && 'n' in request.body ? Number(request.body.n) : 1
    return jsonResponse({
      created: 1_790_000_000,
      data: Array.from({ length: n }, () => ({ b64_json: PNG_BASE64 })),
      usage: { input_tokens: 12, output_tokens: 4160, total_tokens: 4172 },
    })
  }

  it('openai: a new image sends the mapped size and never an aspect ratio', async () => {
    const definition = provider('openai')
    const { rt, requests } = fakeRuntime({ apiKey: 'test-key' }, routes({ 'https://api.openai.com/v1/images/generations': openaiImages }))
    const params = need(definition, 'imageParams')({ n: 2, aspectRatio: '16:9', inputs: 0 }, { id: 'gpt-image-1', kind: 'image' })
    const result = await generateImage({
      model: need(definition, 'createImageModel')('gpt-image-1', rt),
      prompt: 'a red fox',
      n: 2,
      size: params?.size,
      aspectRatio: params?.aspectRatio,
      providerOptions: params?.providerOptions,
      maxRetries: 0,
    })
    const request = only(requests)
    expect(request.headers.authorization).toBe('Bearer test-key')
    expect(request.body).toEqual({ model: 'gpt-image-1', prompt: 'a red fox', n: 2, size: '1536x1024' })
    expect(result.images).toHaveLength(2)
    expect(result.images[0]?.mediaType).toBe('image/png')
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 4160 })
    expect(result.warnings).toEqual([])
  })

  it('openai: input images make it an edit (multipart) with the same size', async () => {
    const definition = provider('openai')
    const { rt, requests } = fakeRuntime({ apiKey: 'test-key' }, routes({ 'https://api.openai.com/v1/images/edits': openaiImages }))
    const params = need(definition, 'imageParams')({ n: 1, aspectRatio: '1:1', inputs: 1 }, { id: 'gpt-image-1-mini', kind: 'image' })
    await generateImage({
      model: need(definition, 'createImageModel')('gpt-image-1-mini', rt),
      prompt: { text: 'make it blue', images: [PNG_BYTES] },
      n: 1,
      size: params?.size,
      maxRetries: 0,
    })
    const body = fields(only(requests))
    expect(body).toMatchObject({ model: 'gpt-image-1-mini', prompt: 'make it blue', n: '1', size: '1024x1024' })
    expect((body.image as RecordedFile).type).toBe('image/png')
  })

  it('xai: the aspect ratio and never a size; n is split into calls of at most 3 images', async () => {
    const definition = provider('xai')
    const { rt, requests } = fakeRuntime({ apiKey: 'xai-key' }, routes({
      'https://api.x.ai/v1/images/generations': (request) => {
        const n = Number((request.body as { n: number }).n)
        return jsonResponse({ data: Array.from({ length: n }, () => ({ b64_json: PNG_BASE64, revised_prompt: 'A red fox.' })) })
      },
    }))
    const params = need(definition, 'imageParams')({ n: 4, aspectRatio: '9:16', inputs: 0 }, { id: 'grok-imagine-image', kind: 'image' })
    const result = await generateImage({
      model: need(definition, 'createImageModel')('grok-imagine-image', rt),
      prompt: 'a red fox',
      n: 4,
      size: params?.size,
      aspectRatio: params?.aspectRatio,
      maxRetries: 0,
    })
    expect(requests).toHaveLength(2)
    expect(requests.map(request => (request.body as { n: number }).n).sort()).toEqual([1, 3])
    for (const request of requests) {
      expect(request.headers.authorization).toBe('Bearer xai-key')
      expect(request.body).toMatchObject({ model: 'grok-imagine-image', prompt: 'a red fox', aspect_ratio: '9:16', response_format: 'b64_json' })
      expect(request.body).not.toHaveProperty('size')
    }
    expect(result.images).toHaveLength(4)
    expect(result.warnings).toEqual([])
  })

  it('google: an image-output chat model asks for text and images at the aspect ratio', async () => {
    const definition = provider('google')
    const { rt, requests } = fakeRuntime({ apiKey: 'AIza-test' }, routes({
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent': () => jsonResponse({
        candidates: [{
          content: { role: 'model', parts: [{ text: 'Here is a red fox.' }, { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }] },
          finishReason: 'STOP',
          index: 0,
        }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1300, totalTokenCount: 1305 },
      }),
    }))
    const model: ModelInfo = { id: 'gemini-2.5-flash-image', capabilities: { imageOutput: true } }
    const result = await generateText({
      model: definition.createLanguageModel('gemini-2.5-flash-image', rt),
      prompt: 'a red fox',
      providerOptions: need(definition, 'imageParams')({ n: 1, aspectRatio: '16:9', inputs: 0 }, model)?.providerOptions,
      maxRetries: 0,
    })
    const request = only(requests)
    expect(request.headers['x-goog-api-key']).toBe('AIza-test')
    expect(request.body).toMatchObject({ generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } } })
    expect(result.text).toBe('Here is a red fox.')
    expect(result.files.map(file => file.mediaType)).toEqual(['image/png'])
  })

  it('openrouter: modalities and image_config spread into the body next to usage accounting', async () => {
    const definition = provider('openrouter')
    const { rt, requests } = fakeRuntime({ apiKey: 'sk-or-test' }, routes({
      'https://openrouter.ai/api/v1/chat/completions': () => {
        const completion = chatCompletion('google/gemini-2.5-flash-image', 'Here is a red fox.')
        const [choice] = completion.choices as [{ message: Record<string, unknown> }]
        choice.message.images = [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } }]
        return jsonResponse(completion)
      },
    }))
    const model: ModelInfo = { id: 'google/gemini-2.5-flash-image', capabilities: { imageOutput: true } }
    const result = await generateText({
      model: definition.createLanguageModel('google/gemini-2.5-flash-image', rt),
      prompt: 'a red fox',
      providerOptions: need(definition, 'imageParams')({ n: 1, aspectRatio: '1:1', inputs: 0 }, model)?.providerOptions,
      maxRetries: 0,
    })
    expect(only(requests).body).toMatchObject({
      model: 'google/gemini-2.5-flash-image',
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: '1:1' },
      usage: { include: true },
    })
    expect(result.files.map(file => file.mediaType)).toEqual(['image/png'])
  })
})

describe('transcription requests on the wire', () => {
  interface Case {
    modelId: string
    url: string
    response: () => Response
    /** The language as it reaches the wire, or `undefined` when none was sent. */
    language: (request: RecordedRequest) => unknown
    check: (request: RecordedRequest) => void
  }
  const multipartLanguage = (request: RecordedRequest) => fields(request).language
  const expectAudioFile = (request: RecordedRequest) => {
    expect(fields(request).file).toMatchObject({ file: 'audio.wav', type: 'audio/wav' })
  }
  const cases: Record<string, Case> = {
    openai: {
      modelId: 'gpt-4o-mini-transcribe',
      url: 'https://api.openai.com/v1/audio/transcriptions',
      response: () => jsonResponse({ text: 'Hallo Welt' }),
      language: multipartLanguage,
      check: (request) => {
        expect(fields(request).model).toBe('gpt-4o-mini-transcribe')
        expectAudioFile(request)
      },
    },
    google: {
      modelId: 'gemini-3.5-transcribe',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      response: () => jsonResponse({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hallo Welt' }] }] }),
      language: request => (request.body as { generation_config?: { transcription_config?: { language_codes?: unknown } } }).generation_config?.transcription_config?.language_codes,
      check: (request) => {
        expect(request.body).toMatchObject({ model: 'gemini-3.5-transcribe', input: [{ type: 'audio', mime_type: 'audio/wav' }] })
      },
    },
    xai: {
      modelId: 'stt',
      url: 'https://api.x.ai/v1/stt',
      response: () => jsonResponse({ text: 'Hallo Welt', language: 'de', duration: 0.1 }),
      language: multipartLanguage,
      check: (request) => {
        // One endpoint, no model field.
        expect(fields(request)).not.toHaveProperty('model')
        expectAudioFile(request)
      },
    },
    mistral: {
      modelId: 'voxtral-mini-latest',
      url: 'https://api.mistral.ai/v1/audio/transcriptions',
      response: () => jsonResponse({ model: 'voxtral-mini-2507', text: 'Hallo Welt' }),
      language: multipartLanguage,
      check: (request) => {
        expect(fields(request).model).toBe('voxtral-mini-latest')
        expectAudioFile(request)
      },
    },
    groq: {
      modelId: 'whisper-large-v3-turbo',
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      response: () => jsonResponse({ text: 'Hallo Welt', x_groq: { id: 'req_1' } }),
      language: multipartLanguage,
      check: (request) => {
        expect(fields(request).model).toBe('whisper-large-v3-turbo')
        expectAudioFile(request)
      },
    },
  }
  const wireLanguage: Record<string, unknown> = { openai: 'de', google: ['de'], xai: 'de', mistral: 'de', groq: 'de' }

  it.each(Object.entries(cases))('%s: the language hint reaches the wire, auto sends none', async (id, spec) => {
    const definition = provider(id)
    for (const language of ['de', 'auto']) {
      const { rt, requests } = fakeRuntime({ apiKey: 'test-key' }, routes({ [spec.url]: spec.response }))
      const result = await transcribe({
        model: need(definition, 'createTranscriptionModel')(spec.modelId, rt),
        audio: wav(),
        providerOptions: need(definition, 'transcriptionOptions')({ language }),
        maxRetries: 0,
      })
      const request = only(requests)
      spec.check(request)
      expect(spec.language(request), language).toEqual(language === 'auto' ? undefined : wireLanguage[id])
      expect(result.text).toBe('Hallo Welt')
      expect(result.warnings).toEqual([])
    }
  })
})

describe('speech requests on the wire', () => {
  // The host passes only the text and the voice: never `outputFormat`, `speed`, `instructions` or `language`, which
  // some providers do not support (the SDK prints a warning for each).
  async function speak(id: string, modelId: string, url: string, response: () => Response, voice?: string) {
    const definition = provider(id)
    const { rt, requests } = fakeRuntime({ apiKey: 'test-key' }, routes({ [url]: response }))
    const result = await generateSpeech({
      model: need(definition, 'createSpeechModel')(modelId, rt),
      text: 'Hello world',
      voice,
      maxRetries: 0,
    })
    expect(result.warnings).toEqual([])
    expect(result.audio.uint8Array.length).toBeGreaterThan(0)
    return { request: only(requests), result }
  }

  it('openai: model, input, voice and the mp3 default only', async () => {
    const { request, result } = await speak('openai', 'gpt-4o-mini-tts', 'https://api.openai.com/v1/audio/speech', () => binaryResponse(MP3_BYTES, 'audio/mpeg'), 'coral')
    expect(request.headers.authorization).toBe('Bearer test-key')
    expect(request.body).toEqual({ model: 'gpt-4o-mini-tts', input: 'Hello world', voice: 'coral', response_format: 'mp3' })
    expect(result.audio.mediaType).toBe('audio/mpeg')
  })

  it('google: generateContent with the audio modality and the prebuilt voice; PCM becomes WAV', async () => {
    const pcm = Buffer.alloc(480).toString('base64')
    const { request, result } = await speak(
      'google',
      'gemini-2.5-flash-preview-tts',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent',
      () => jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm } }] } }] }),
      'Puck',
    )
    expect(request.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } } },
    })
    expect(result.audio.mediaType).toBe('audio/wav')
  })

  it('xai: the one /tts endpoint with the voice id; the package default language and codec', async () => {
    const { request } = await speak('xai', 'tts', 'https://api.x.ai/v1/tts', () => binaryResponse(MP3_BYTES, 'audio/mpeg'), 'ara')
    expect(request.headers.authorization).toBe('Bearer test-key')
    expect(request.body).toEqual({ text: 'Hello world', voice_id: 'ara', language: 'auto', output_format: { codec: 'mp3' } })
  })

  it('mistral: no default voice, the mp3 default, no streaming', async () => {
    const { request } = await speak('mistral', 'voxtral-mini-tts-latest', 'https://api.mistral.ai/v1/audio/speech', () => jsonResponse({ audio_data: Buffer.from(MP3_BYTES).toString('base64') }))
    expect(request.body).toEqual({ model: 'voxtral-mini-tts-latest', input: 'Hello world', response_format: 'mp3', stream: false })
  })
})
