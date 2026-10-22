import type { WebSearchParams, WebSearchRequest } from '@harness-forge/plugin-sdk'
import type { CatalogModel, ModelInfo } from '@harness-forge/shared'
import type { Tool } from 'ai'
import type { CatalogEntryInput, WebSearchHook } from './merge.ts'
import { catalogModelSchema, WEB_SEARCH_MAX_USES } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { buildCatalogModel, catalogModelInfo, cleanVoices, effortMenu, hiddenByDefault, MAX_MODEL_VOICES, mergeLayers, modelsDevLayer, modelWebSearch, sortEfforts, WEB_SEARCH_PROBE } from './merge.ts'

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
      webSearch: null,
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

describe('webSearch (Phase 14, ADR-062)', () => {
  const tool = { type: 'provider', id: 'acme.web_search', args: {}, isProviderExecuted: true } as unknown as Tool
  const chat = (hook?: WebSearchHook, extra: Partial<CatalogEntryInput> = {}): CatalogModel => buildCatalogModel({
    providerId: 'acme',
    id: 'acme-chat',
    layers: [{ id: 'acme-chat', name: 'Acme Chat', capabilities: { tools: true, reasoning: true }, reasoningEfforts: ['low'] }],
    source: 'seed',
    ...(hook === undefined ? {} : { webSearch: hook }),
    ...extra,
  })

  it('is null without a hook and native / exclusive from the hook\'s answer to the probe', () => {
    expect(chat().webSearch).toBeNull()
    const seen: [ModelInfo, WebSearchRequest][] = []
    const native = chat((info, request) => {
      seen.push([info, request])
      return { tools: { web_search: tool } }
    })
    expect(catalogModelSchema.parse(native).webSearch).toBe('native')
    // The probe: a turn without function tools; the entry's own ModelInfo (what a turn passes).
    expect(seen).toHaveLength(1)
    expect(seen[0]?.[1]).toEqual({ functionTools: 0, maxUses: WEB_SEARCH_MAX_USES })
    expect(seen[0]?.[0]).toEqual(catalogModelInfo(native))
    expect(chat(() => ({ tools: { google_search: tool }, exclusive: true })).webSearch).toBe('exclusive')
    expect(chat(() => ({ tools: { web_search: tool }, exclusive: false })).webSearch).toBe('native')
    // Provider options alone (OpenRouter's web plugin) are native search too.
    expect(chat(() => ({ providerOptions: { acme: { plugins: [{ id: 'web' }] } } })).webSearch).toBe('native')
  })

  it('is null for nothing usable, a throw or an invalid answer, and reports the problem (never a value)', () => {
    const problems: unknown[] = []
    const onWebSearchProblem = (problem: unknown): void => {
      problems.push(problem)
    }
    expect(chat(() => undefined, { onWebSearchProblem }).webSearch).toBeNull()
    expect(chat(() => ({}), { onWebSearchProblem }).webSearch).toBeNull()
    expect(problems).toEqual([])
    const error = new Error('boom')
    expect(chat(() => {
      throw error
    }, { onWebSearchProblem }).webSearch).toBeNull()
    expect(problems).toEqual([{ modelId: 'acme-chat', problems: ['the hook threw'], error }])
    problems.length = 0
    expect(chat(() => ({ tools: { web_search: { type: 'function', secret: 'sk-hidden' } as unknown as Tool } }), { onWebSearchProblem }).webSearch).toBeNull()
    expect(chat(() => ({ tools: { web_search: tool }, exclusive: 'yes' as unknown as boolean }), { onWebSearchProblem }).webSearch).toBeNull()
    expect(problems).toHaveLength(2)
    expect(JSON.stringify(problems)).not.toContain('sk-hidden')
  })

  it('probes chat models only (image, speech and other kinds are null without a call)', () => {
    let calls = 0
    const hook: WebSearchHook = () => {
      calls++
      return { tools: { web_search: tool } }
    }
    for (const kind of ['image', 'speech', 'transcription', 'embedding'] as const) {
      const model = buildCatalogModel({ providerId: 'acme', id: `acme-${kind}`, layers: [{ id: `acme-${kind}`, kind }], source: 'seed', webSearch: hook })
      expect(model.webSearch, kind).toBeNull()
    }
    expect(calls).toBe(0)
    expect(chat(hook).webSearch).toBe('native')
    expect(calls).toBe(1)
  })

  it('modelWebSearch reads the answer like a turn does', () => {
    const info: ModelInfo = { id: 'm' }
    expect(modelWebSearch(() => ({ tools: { web_search: tool } }), info)).toBe('native')
    expect(modelWebSearch(() => ({ tools: { 'bad name': tool } }), info)).toBeNull()
    expect(modelWebSearch(() => 'native' as unknown as WebSearchParams, info)).toBeNull()
    expect(WEB_SEARCH_PROBE).toEqual({ functionTools: 0, maxUses: WEB_SEARCH_MAX_USES })
    expect(Object.isFrozen(WEB_SEARCH_PROBE)).toBe(true)
  })
})
