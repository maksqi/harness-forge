import { describe, expect, it } from 'vitest'
import { classify, classifyId } from './classify.ts'

describe('classify', () => {
  it.each([
    ['gpt-6-luna', 'chat'],
    ['claude-sonnet-5', 'chat'],
    ['text-embedding-3-small', 'embedding'],
    ['mistral-embed', 'embedding'],
    ['gpt-4o-mini-tts', 'audio'],
    ['whisper-large-v3', 'audio'],
    ['gpt-4o-transcribe', 'audio'],
    ['gpt-audio', 'audio'],
    ['gpt-image-2', 'image'],
    ['omni-moderation-latest', 'other'],
    ['rerank-v3', 'other'],
  ] as const)('the id %s alone is %s', (id, kind) => {
    expect(classifyId(id)).toBe(kind)
    expect(classify(id)).toBe(kind)
    expect(classify(id, {})).toBe(kind)
  })

  it('prefers models.dev modalities over the id', () => {
    // Chat models whose ids match the pattern.
    expect(classify('gemini-2.5-flash-image', { input: ['text', 'image'], output: ['text', 'image'] })).toBe('chat')
    expect(classify('gpt-audio', { input: ['text', 'audio'], output: ['text', 'audio'] })).toBe('chat')
    // Non-chat models whose ids do not.
    expect(classify('veo-3.1', { input: ['text'], output: ['video'] })).toBe('other')
    expect(classify('acme-paint', { input: ['text'], output: ['image'] })).toBe('image')
    expect(classify('orpheus-v1', { input: ['text'], output: ['audio'] })).toBe('audio')
    expect(classify('qwen3-asr-flash', { input: ['audio'], output: ['text'] })).toBe('audio')
  })

  it('still recognizes embedding, moderation and rerank ids that models.dev lists with a text output', () => {
    expect(classify('text-embedding-3-small', { input: ['text'], output: ['text'] })).toBe('embedding')
    expect(classify('omni-moderation-latest', { input: ['text'], output: ['text'] })).toBe('other')
    expect(classify('acme-large', { input: ['text', 'image'], output: ['text'] })).toBe('chat')
  })
})
