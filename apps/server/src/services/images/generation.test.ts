import type { GeneratedFile } from 'ai'
import { LIMITS } from '@harness-forge/shared'
import { DefaultGeneratedFile } from 'ai'
import { describe, expect, it } from 'vitest'
import { cutUtf16, IMAGE_MODEL_NAME_MAX_CHARS, imageCost, imageModelDisplayName, imageUsage, resultModelName, revisedPromptOf, roundUsd, sanitizeImageParams } from './generation.ts'

function generated(providerMetadata?: GeneratedFile['providerMetadata']): GeneratedFile {
  return new DefaultGeneratedFile({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', ...(providerMetadata ? { providerMetadata } : {}) })
}

describe('image generation helpers: imageParams results', () => {
  it('keeps a WxH size, a W:H aspect ratio and provider options of objects', () => {
    expect(sanitizeImageParams({ size: '1536x1024', aspectRatio: '16:9', providerOptions: { openai: { quality: 'high' } } })).toEqual({
      size: '1536x1024',
      aspectRatio: '16:9',
      providerOptions: { openai: { quality: 'high' } },
    })
    expect(sanitizeImageParams({ providerOptions: { google: { imageConfig: { aspectRatio: '1:1' } } } })).toEqual({ providerOptions: { google: { imageConfig: { aspectRatio: '1:1' } } } })
  })

  it('drops malformed members and non-object results', () => {
    expect(sanitizeImageParams({ size: '1024', aspectRatio: 'wide', providerOptions: { openai: 'high' } })).toEqual({})
    expect(sanitizeImageParams({ size: '0x100', aspectRatio: '16:0', providerOptions: [] })).toEqual({})
    expect(sanitizeImageParams({ size: 1024, extra: true })).toEqual({})
    for (const value of [undefined, null, 'size', 42, [], Promise.resolve({ size: '1x1' })])
      expect(sanitizeImageParams(value)).toEqual({})
  })
})

describe('image generation helpers: usage and cost', () => {
  it('reports null usage when the provider reports no token count (xAI), zeros for missing counts otherwise', () => {
    expect(imageUsage(undefined)).toBeNull()
    expect(imageUsage({ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined })).toBeNull()
    expect(imageUsage({ inputTokens: 12, outputTokens: 4160, totalTokens: 4172 })).toEqual({ inputTokens: 12, outputTokens: 4160, totalTokens: 4172 })
    expect(imageUsage({ inputTokens: 12, outputTokens: undefined, totalTokens: undefined })).toEqual({ inputTokens: 12, outputTokens: 0, totalTokens: 12 })
    expect(imageUsage({ inputTokens: undefined, outputTokens: undefined, totalTokens: 500 })).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 500 })
    expect(imageUsage({ inputTokens: 3.6, outputTokens: -2, totalTokens: Number.NaN })).toEqual({ inputTokens: 4, outputTokens: 0, totalTokens: 4 })
  })

  it('multiplies the counts by the per-1M-token prices of the catalog', () => {
    // gpt-image-1 like prices: USD 5 per 1M input tokens, 40 per 1M image output tokens.
    expect(imageCost({ inputTokens: 1000, outputTokens: 5000, totalTokens: 6000 }, { input: 5, output: 40 })).toBe(0.205)
    // mock:image: USD 1 / 2 per 1M tokens, "a red fox" (3 words) and 2 images (100 tokens each).
    expect(imageCost({ inputTokens: 3, outputTokens: 200, totalTokens: 203 }, { input: 1, output: 2 })).toBe(0.000403)
    expect(imageCost({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }, { input: 1, output: 2 })).toBe(0)
    // A token kind that is not used needs no price.
    expect(imageCost({ inputTokens: 0, outputTokens: 1_000_000, totalTokens: 1_000_000 }, { output: 8 })).toBe(8)
    expect(imageCost({ inputTokens: 10, outputTokens: undefined, totalTokens: undefined }, { input: 2 })).toBe(0.00002)
  })

  it('is null when the price or the usage is unknown', () => {
    expect(imageCost({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }, null)).toBeNull()
    expect(imageCost({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }, undefined)).toBeNull()
    expect(imageCost({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }, {})).toBeNull()
    expect(imageCost({ inputTokens: 10, outputTokens: 10, totalTokens: 20 }, { input: 5 })).toBeNull()
    expect(imageCost(undefined, { input: 5, output: 40 })).toBeNull()
    expect(imageCost({ inputTokens: undefined, outputTokens: undefined, totalTokens: 500 }, { input: 5, output: 40 })).toBeNull()
  })

  it('rounds USD to 1e-10', () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3)
    expect(roundUsd(1.23456789012345)).toBe(1.2345678901)
  })
})

describe('image generation helpers: revised prompt', () => {
  it('takes the first revisedPrompt of the per-image provider metadata, trimmed', () => {
    expect(revisedPromptOf([generated({ openai: { revisedPrompt: '  A fox in the snow  ' } }), generated({ openai: { revisedPrompt: 'Other' } })])).toBe('A fox in the snow')
    expect(revisedPromptOf([generated({ mock: {} }), generated({ mock: { revisedPrompt: 'Second' } })])).toBe('Second')
    expect(revisedPromptOf([generated(), generated({ mock: { revisedPrompt: '   ' } }), generated({ mock: { revisedPrompt: 42 } })])).toBeUndefined()
    expect(revisedPromptOf([])).toBeUndefined()
  })

  it('cuts a long revised prompt to LIMITS.imagePromptMaxChars UTF-16 code units, never inside a surrogate pair', () => {
    const long = 'x'.repeat(LIMITS.imagePromptMaxChars + 10)
    expect(revisedPromptOf([generated({ openai: { revisedPrompt: long } })])).toHaveLength(LIMITS.imagePromptMaxChars)
    const emoji = `${'x'.repeat(LIMITS.imagePromptMaxChars - 1)}\u{1F98A}tail`
    const cut = revisedPromptOf([generated({ openai: { revisedPrompt: emoji } })])!
    expect(cut).toBe('x'.repeat(LIMITS.imagePromptMaxChars - 1))
    expect(cutUtf16('ab\u{1F98A}', 3)).toBe('ab')
    expect(cutUtf16('abc', 5)).toBe('abc')
    expect(cutUtf16('abc', 0)).toBe('')
  })
})

describe('image generation helpers: model display name (Phase 7, plugin API 1.2.0)', () => {
  it('takes the catalog name, else the model id; trimmed and cut to 200 UTF-16 code units', () => {
    expect(imageModelDisplayName('GPT Image 1', 'gpt-image-1')).toBe('GPT Image 1')
    expect(imageModelDisplayName('  Imagen 4  ', 'imagen-4')).toBe('Imagen 4')
    for (const blank of ['', '   ', null, undefined])
      expect(imageModelDisplayName(blank, 'gpt-image-1'), String(blank)).toBe('gpt-image-1')
    expect(IMAGE_MODEL_NAME_MAX_CHARS).toBe(200)
    expect(imageModelDisplayName('n'.repeat(201), 'x')).toBe('n'.repeat(200))
    expect(imageModelDisplayName(`${'n'.repeat(199)}\u{1F98A}`, 'x')).toBe('n'.repeat(199))
  })

  it('names a result by its modelName, else the model id of its modelRef', () => {
    expect(resultModelName({ modelRef: 'openai:gpt-image-1', modelName: 'GPT Image 1' })).toBe('GPT Image 1')
    expect(resultModelName({ modelRef: 'openai:gpt-image-1' })).toBe('gpt-image-1')
    expect(resultModelName({ modelRef: 'openai:gpt-image-1', modelName: ' ' })).toBe('gpt-image-1')
    // Split on the first colon (`ollama:llama3:8b`).
    expect(resultModelName({ modelRef: 'local:flux:dev' })).toBe('flux:dev')
  })
})
