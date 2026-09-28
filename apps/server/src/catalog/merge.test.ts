import { catalogModelSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { buildCatalogModel, catalogModelInfo, cleanVoices, effortMenu, hiddenByDefault, MAX_MODEL_VOICES, mergeLayers, modelsDevLayer, sortEfforts } from './merge.ts'

describe('field precedence', () => {
  it('takes each field, capability flag and price from the first layer that defines it', () => {
    const merged = mergeLayers('m', [
      { id: 'm', name: 'Custom name', cost: { input: 9 } },
      { id: 'm', contextWindow: 100, capabilities: { tools: true } },
      undefined,
      modelsDevLayer({ name: 'Dev name', contextWindow: 200, maxOutputTokens: 50, tools: false, reasoning: true, input: ['text', 'image'], cost: { input: 1, output: 2 } }),
      { id: 'm', name: 'Seed name', reasoningEfforts: ['low', 'high'], capabilities: { structuredOutput: true }, cost: { cacheRead: 0.5 } },
    ])
    expect(merged).toEqual({
      id: 'm',
      name: 'Custom name',
      contextWindow: 100,
      maxOutputTokens: 50,
      capabilities: { tools: true, vision: true, pdf: false, reasoning: true, structuredOutput: true },
      reasoningEfforts: ['low', 'high'],
      cost: { input: 9, output: 2, cacheRead: 0.5 },
    })
  })

  it('ignores blank names', () => {
    expect(mergeLayers('m', [{ id: 'm', name: '  ' }, { id: 'm', name: 'Real' }]).name).toBe('Real')
  })

  it('takes imageOutput and voices from the first layer that defines them', () => {
    const merged = mergeLayers('m', [
      { id: 'm', capabilities: { imageOutput: false } },
      { id: 'm', capabilities: { imageOutput: true }, voices: ['a', 'b'] },
      { id: 'm', voices: ['c'] },
    ])
    expect(merged).toEqual({ id: 'm', capabilities: { imageOutput: false }, voices: ['a', 'b'] })
  })
})

describe('models.dev layer', () => {
  it('derives vision / pdf from the input and imageOutput from a text + image output', () => {
    expect(modelsDevLayer({ input: ['text', 'image'], output: ['text', 'image'] })?.capabilities).toEqual({ vision: true, pdf: false, imageOutput: true })
    expect(modelsDevLayer({ input: ['text', 'pdf'], output: ['text'] })?.capabilities).toEqual({ vision: false, pdf: true, imageOutput: false })
    // An image-only output is a dedicated image model, not a chat model with image output.
    expect(modelsDevLayer({ output: ['image'] })?.capabilities).toEqual({ imageOutput: false })
    expect(modelsDevLayer({ name: 'No modalities' })).toEqual({ name: 'No modalities', capabilities: {} })
    expect(modelsDevLayer(undefined)).toBeUndefined()
  })
})

describe('voices', () => {
  it('keeps valid, unique names (first wins), at most 100', () => {
    expect(cleanVoices(['alloy', 'echo', 'alloy', '', 'x'.repeat(65), 7, null, 'Kore'])).toEqual(['alloy', 'echo', 'Kore'])
    const many = Array.from({ length: MAX_MODEL_VOICES + 20 }, (_, index) => `voice-${index}`)
    expect(cleanVoices(many)).toEqual(many.slice(0, MAX_MODEL_VOICES))
    expect(cleanVoices([])).toEqual([])
  })
})

describe('effort menu', () => {
  it('is empty without reasoning and starts with auto otherwise', () => {
    expect(effortMenu({ id: 'm', reasoningEfforts: ['high'] }, false)).toEqual([])
    expect(effortMenu({ id: 'm' }, true)).toEqual(['auto', 'off', 'low', 'medium', 'high'])
    expect(effortMenu({ id: 'm', reasoningEfforts: ['max', 'low', 'auto', 'low'] }, true)).toEqual(['auto', 'low', 'max'])
    expect(effortMenu({ id: 'm', reasoningEfforts: [] }, true)).toEqual([])
  })

  it('sorts efforts in menu order without auto', () => {
    expect(sortEfforts(['max', 'off', 'auto', 'medium'])).toEqual(['off', 'medium', 'max'])
  })
})

describe('buildCatalogModel', () => {
  it('builds a schema-valid entry with defaults', () => {
    const model = buildCatalogModel({ providerId: 'acme', id: 'acme-large', layers: [{ id: 'acme-large' }], source: 'seed' })
    expect(catalogModelSchema.parse(model)).toEqual({
      ref: 'acme:acme-large',
      providerId: 'acme',
      id: 'acme-large',
      name: 'acme-large',
      alias: null,
      kind: 'chat',
      contextWindow: null,
      maxOutputTokens: null,
      capabilities: { tools: false, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false },
      reasoningEfforts: [],
      cost: null,
      favorite: false,
      hidden: false,
      custom: false,
      source: 'seed',
      lastUsedAt: null,
    })
  })

  it('applies prefs: alias as name, favorite, hidden override and last use', () => {
    const prefs = { hidden: null, favorite: true, alias: 'My model', custom: false, lastUsedAt: 123 }
    const model = buildCatalogModel({ providerId: 'acme', id: 'm', layers: [{ id: 'm', name: 'Model' }], prefs, source: 'live' })
    expect(model).toMatchObject({ name: 'My model', alias: 'My model', favorite: true, hidden: false, lastUsedAt: 123 })
    const hidden = buildCatalogModel({ providerId: 'acme', id: 'm', layers: [], prefs: { ...prefs, hidden: true }, source: 'live' })
    expect(hidden.hidden).toBe(true)
  })

  it('hides non-chat kinds unless the prefs say otherwise', () => {
    const embedding = buildCatalogModel({ providerId: 'acme', id: 'text-embedding-3-small', layers: [], source: 'live' })
    expect(embedding).toMatchObject({ kind: 'embedding', hidden: true })
    const shown = buildCatalogModel({
      providerId: 'acme',
      id: 'text-embedding-3-small',
      layers: [],
      prefs: { hidden: false, favorite: false, alias: null, custom: false, lastUsedAt: null },
      source: 'live',
    })
    expect(shown.hidden).toBe(false)
    const explicit = buildCatalogModel({ providerId: 'acme', id: 'gpt-image-custom', layers: [{ id: 'gpt-image-custom', kind: 'chat' }], source: 'custom' })
    expect(explicit).toMatchObject({ kind: 'chat', hidden: false })
    const byModalities = buildCatalogModel({ providerId: 'acme', id: 'paint', layers: [], modalities: { input: ['text'], output: ['image'] }, source: 'live' })
    expect(byModalities).toMatchObject({ kind: 'image', hidden: true })
  })

  it('shows chat models, image models only when the provider can generate images, and hides every other kind', () => {
    expect(hiddenByDefault('chat', false)).toBe(false)
    expect(hiddenByDefault('image', true)).toBe(false)
    expect(hiddenByDefault('image', false)).toBe(true)
    for (const kind of ['transcription', 'speech', 'audio', 'embedding', 'other'] as const) {
      expect(hiddenByDefault(kind, true), kind).toBe(true)
      expect(hiddenByDefault(kind, false), kind).toBe(true)
    }
    const image = (imageModels?: boolean): boolean => buildCatalogModel({ providerId: 'acme', id: 'paint', layers: [{ id: 'paint', kind: 'image' }], source: 'seed', ...(imageModels === undefined ? {} : { imageModels }) }).hidden
    expect(image()).toBe(true)
    expect(image(false)).toBe(true)
    expect(image(true)).toBe(false)
    const hiddenImage = buildCatalogModel({
      providerId: 'acme',
      id: 'paint',
      layers: [{ id: 'paint', kind: 'image' }],
      prefs: { hidden: true, favorite: false, alias: null, custom: false, lastUsedAt: null },
      source: 'seed',
      imageModels: true,
    })
    expect(hiddenImage.hidden).toBe(true)
    const speech = buildCatalogModel({ providerId: 'acme', id: 'say', layers: [{ id: 'say', kind: 'speech' }], source: 'seed', imageModels: true })
    expect(speech).toMatchObject({ kind: 'speech', hidden: true })
  })

  it('reports imageOutput for chat models only and passes the voices through', () => {
    const gemini = buildCatalogModel({
      providerId: 'google',
      id: 'gemini-2.5-flash-image',
      layers: [modelsDevLayer({ input: ['text', 'image'], output: ['text', 'image'] })],
      modalities: { input: ['text', 'image'], output: ['text', 'image'] },
      source: 'live',
    })
    expect(gemini).toMatchObject({ kind: 'chat', hidden: false, capabilities: { vision: true, imageOutput: true } })
    // models.dev lists gpt-image-1-mini with a [text, image] output: an image model, so no imageOutput.
    const imageModel = buildCatalogModel({
      providerId: 'openai',
      id: 'gpt-image-1-mini',
      layers: [modelsDevLayer({ input: ['text', 'image'], output: ['text', 'image'] })],
      modalities: { input: ['text', 'image'], output: ['text', 'image'] },
      source: 'live',
      imageModels: true,
    })
    expect(imageModel).toMatchObject({ kind: 'image', hidden: false, capabilities: { imageOutput: false } })
    const explicit = buildCatalogModel({ providerId: 'mock', id: 'image-chat', layers: [{ id: 'image-chat', kind: 'chat', capabilities: { imageOutput: true } }], source: 'live' })
    expect(explicit).toMatchObject({ kind: 'chat', hidden: false, capabilities: { imageOutput: true } })

    const speech = buildCatalogModel({ providerId: 'mock', id: 'speech', layers: [{ id: 'speech', kind: 'speech', voices: ['b', 'a', 'b'] }], source: 'live' })
    expect(catalogModelSchema.parse(speech)).toMatchObject({ kind: 'speech', hidden: true, voices: ['b', 'a'] })
    expect(catalogModelInfo(speech)).toMatchObject({ id: 'speech', kind: 'speech', voices: ['b', 'a'] })
    const chat = buildCatalogModel({ providerId: 'mock', id: 'echo', layers: [{ id: 'echo' }], source: 'live' })
    expect('voices' in chat).toBe(false)
    expect('voices' in catalogModelInfo(chat)).toBe(false)
  })

  it('treats a model that lists efforts as a reasoning model', () => {
    const model = buildCatalogModel({ providerId: 'acme', id: 'm', layers: [{ id: 'm', reasoningEfforts: ['off', 'high'] }], source: 'custom' })
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.reasoningEfforts).toEqual(['auto', 'off', 'high'])
  })

  it('converts an entry back to ModelInfo without auto', () => {
    const model = buildCatalogModel({
      providerId: 'acme',
      id: 'm',
      layers: [{ id: 'm', name: 'M', contextWindow: 10, capabilities: { reasoning: true }, cost: { input: 1 } }],
      source: 'seed',
    })
    expect(catalogModelInfo(model)).toEqual({
      id: 'm',
      name: 'M',
      kind: 'chat',
      contextWindow: 10,
      capabilities: { tools: false, vision: false, pdf: false, reasoning: true, structuredOutput: false, imageOutput: false },
      reasoningEfforts: ['off', 'low', 'medium', 'high'],
      cost: { input: 1 },
    })
  })
})
