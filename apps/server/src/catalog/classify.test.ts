import type { ProviderDefinition } from '@harness-forge/plugin-sdk'
import { describe, expect, it } from 'vitest'
import { classify, classifyId, IMAGE_MODEL_ID_PATTERN, isMediaModelKind, MEDIA_MODEL_KINDS, providerServesKind } from './classify.ts'

describe('classifyId', () => {
  it.each([
    ['gpt-6-luna', 'chat'],
    ['claude-sonnet-5', 'chat'],
    ['text-embedding-3-small', 'embedding'],
    ['mistral-embed', 'embedding'],
    ['gpt-4o-mini-tts', 'speech'],
    ['tts-1-hd', 'speech'],
    ['gemini-2.5-flash-preview-tts', 'speech'],
    ['whisper-large-v3', 'transcription'],
    ['whisper-1', 'transcription'],
    ['gpt-4o-transcribe', 'transcription'],
    ['gpt-audio', 'audio'],
    ['gpt-image-2', 'image'],
    ['dall-e-3', 'image'],
    ['imagen-4.0-generate-001', 'image'],
    ['grok-imagine-image', 'image'],
    ['omni-moderation-latest', 'other'],
    ['rerank-v3', 'other'],
    // Only the specific image ids: other ids that contain "image" are chat models (Gemini image output).
    ['gemini-2.5-flash-image', 'chat'],
    ['openai/gpt-5-image', 'chat'],
    ['acme-vision-image', 'chat'],
  ] as const)('the id %s alone is %s', (id, kind) => {
    expect(classifyId(id)).toBe(kind)
    expect(classify(id)).toBe(kind)
    expect(classify(id, {})).toBe(kind)
  })

  it('matches the image id pattern at the start of the id or after a slash only', () => {
    for (const id of ['gpt-image-1', 'GPT-Image-1.5', 'chatgpt-image-latest', 'openai/gpt-image-1', 'dall-e-2', 'imagen-3', 'grok-imagine-image-quality'])
      expect(IMAGE_MODEL_ID_PATTERN.test(id), id).toBe(true)
    for (const id of ['my-gpt-image', 'gemini-3-pro-image-preview', 'grok-imagine-video', 'grok-2-image-1212'])
      expect(IMAGE_MODEL_ID_PATTERN.test(id), id).toBe(false)
  })
})

describe('classify', () => {
  it('takes the image id pattern before the modalities (models.dev lists some image models with a text output)', () => {
    for (const id of ['gpt-image-1-mini', 'gpt-image-1.5', 'chatgpt-image-latest'])
      expect(classify(id, { input: ['text', 'image'], output: ['text', 'image'] }), id).toBe('image')
    expect(classify('gpt-image-1', { input: ['text', 'image'], output: ['image'] })).toBe('image')
    expect(classify('grok-imagine-image', { input: ['text', 'image', 'pdf'], output: ['image', 'pdf'] })).toBe('image')
  })

  it('reads the voice kinds from the modalities', () => {
    // Text in, audio out: speech. Audio in without text, text out: transcription.
    expect(classify('gpt-4o-mini-tts', { input: ['text'], output: ['audio'] })).toBe('speech')
    expect(classify('orpheus-v1', { input: ['text'], output: ['audio'] })).toBe('speech')
    expect(classify('whisper-large-v3', { input: ['audio'], output: ['text'] })).toBe('transcription')
    expect(classify('qwen3-asr-flash', { input: ['audio'], output: ['text'] })).toBe('transcription')
    expect(classify('voxtral-mini-latest', { input: ['audio', 'video'], output: ['text'] })).toBe('transcription')
    // Audio out without a text input is another audio model; audio in with text in is a chat model.
    expect(classify('voice-changer', { input: ['audio'], output: ['audio'] })).toBe('audio')
    expect(classify('voxtral-small-latest', { input: ['text', 'audio'], output: ['text'] })).toBe('chat')
  })

  it('prefers models.dev modalities over the id', () => {
    // Chat models whose ids match an id rule.
    expect(classify('gemini-2.5-flash-image', { input: ['text', 'image'], output: ['text', 'image'] })).toBe('chat')
    expect(classify('gpt-audio', { input: ['text', 'audio'], output: ['text', 'audio'] })).toBe('chat')
    expect(classify('acme-tts-chat', { input: ['text'], output: ['text'] })).toBe('chat')
    // Non-chat models whose ids match no rule.
    expect(classify('veo-3.1', { input: ['text'], output: ['video'] })).toBe('other')
    expect(classify('acme-paint', { input: ['text'], output: ['image'] })).toBe('image')
    expect(classify('mistral-ocr', { input: ['image', 'pdf'], output: ['text'] })).toBe('other')
  })

  it('still recognizes embedding, moderation and rerank ids that models.dev lists with a text output', () => {
    expect(classify('text-embedding-3-small', { input: ['text'], output: ['text'] })).toBe('embedding')
    expect(classify('omni-moderation-latest', { input: ['text'], output: ['text'] })).toBe('other')
    expect(classify('acme-large', { input: ['text', 'image'], output: ['text'] })).toBe('chat')
  })
})

describe('media kinds', () => {
  const unused = (): never => {
    throw new Error('unused')
  }
  const base: ProviderDefinition = { id: 'acme', name: 'Acme', credentials: [], createLanguageModel: unused }

  it('names the media kinds', () => {
    expect(MEDIA_MODEL_KINDS).toEqual(['image', 'transcription', 'speech'])
    expect(['image', 'transcription', 'speech'].every(isMediaModelKind)).toBe(true)
    expect(['chat', 'audio', 'embedding', 'other', undefined, 'toString'].some(isMediaModelKind)).toBe(false)
  })

  it('tells which media kinds a provider serves from its factories', () => {
    const served = (definition: ProviderDefinition): string[] => MEDIA_MODEL_KINDS.filter(kind => providerServesKind(definition, kind))
    expect(served(base)).toEqual([])
    expect(served({ ...base, createImageModel: unused })).toEqual(['image'])
    expect(served({ ...base, createTranscriptionModel: unused, createSpeechModel: unused })).toEqual(['transcription', 'speech'])
    // imageParams / transcriptionOptions alone serve nothing.
    expect(served({ ...base, imageParams: () => undefined, transcriptionOptions: () => undefined })).toEqual([])
  })
})
