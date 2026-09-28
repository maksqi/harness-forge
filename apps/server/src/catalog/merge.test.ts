import { catalogModelSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { buildCatalogModel, catalogModelInfo, effortMenu, mergeLayers, modelsDevLayer, sortEfforts } from './merge.ts'

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
