import { readFileSync } from 'node:fs'
import { BUILTIN_PROVIDER_IDS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { PROVIDER_DEFINITIONS } from '../builtin-plugins/core-providers/index.ts'
import { bundledSnapshotPath } from './index.ts'
import {
  BUNDLED_MODELS_DEV_PROVIDERS,
  MODELS_DEV_SCHEMA_VERSION,
  modelsDevModelCount,
  parseModelsDevSnapshot,
  serializeModelsDevSnapshot,
  trimModelsDev,
  trimModelsDevForBundle,
  trimModelsDevModel,
} from './models-dev.ts'

const RAW = {
  anthropic: {
    id: 'anthropic',
    env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        description: 'dropped',
        attachment: true,
        reasoning: true,
        reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
        tool_call: true,
        structured_output: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 200000, output: 64000 },
        cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25, tiers: [{ input: 2 }] },
      },
    },
  },
  groq: { models: { 'whisper-large-v3': { name: 'Whisper', modalities: { input: ['audio'], output: ['text'] }, limit: { context: 0, output: 0 } } } },
  openrouter: {
    models: {
      'google/gemini-2.5-flash-image': { name: 'Nano Banana', modalities: { input: ['text', 'image'], output: ['text', 'image'] } },
      'openai/gpt-6-luna': { name: 'GPT-6 Luna', modalities: { input: ['text'], output: ['text'] } },
    },
  },
  togetherai: { models: { 'meta-llama/x': { name: 'Llama' } } },
}

describe('trimModelsDevModel', () => {
  it('keeps only the fields the catalog uses', () => {
    expect(trimModelsDevModel(RAW.anthropic.models['claude-haiku-4-5'])).toEqual({
      name: 'Claude Haiku 4.5',
      reasoning: true,
      tools: true,
      structuredOutput: true,
      input: ['text', 'image', 'pdf'],
      output: ['text'],
      contextWindow: 200000,
      maxOutputTokens: 64000,
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    })
  })

  it('drops non-positive limits, bad prices, control characters and non-English names', () => {
    expect(trimModelsDevModel({ name: 'A\u0000B', limit: { context: 0, output: -1 }, cost: { input: -1, output: 'x' } })).toEqual({ name: 'AB' })
    expect(trimModelsDevModel({ name: '\u041C\u043E\u0434\u0435\u043B\u044C' })).toEqual({})
    expect(trimModelsDevModel(null)).toEqual({})
  })
})

describe('trimModelsDev', () => {
  it('keeps every provider for a full refresh (complete)', () => {
    const snapshot = trimModelsDev(RAW, { fetchedAt: 5 })
    expect(snapshot).toMatchObject({ schemaVersion: MODELS_DEV_SCHEMA_VERSION, fetchedAt: 5, complete: true })
    expect(Object.keys(snapshot.providers)).toEqual(['anthropic', 'groq', 'openrouter', 'togetherai'])
    expect(modelsDevModelCount(snapshot)).toBe(5)
  })

  it('keeps the builtin providers and only the misclassifiable OpenRouter models in the bundle', () => {
    const snapshot = trimModelsDevForBundle(RAW, 7)
    expect(snapshot.complete).toBe(false)
    expect(Object.keys(snapshot.providers)).toEqual(['anthropic', 'groq', 'openrouter'])
    expect(Object.keys(snapshot.providers.openrouter ?? {})).toEqual(['google/gemini-2.5-flash-image'])
  })

  it('rejects documents without providers', () => {
    expect(() => trimModelsDev([], { fetchedAt: 1 })).toThrow()
    expect(() => trimModelsDev({}, { fetchedAt: 1 })).toThrow()
  })
})

describe('snapshot files', () => {
  it('round-trips through the line-oriented serialization', () => {
    const snapshot = trimModelsDev(RAW, { fetchedAt: 42 })
    const text = serializeModelsDevSnapshot(snapshot)
    expect(text.split('\n').length).toBeGreaterThan(5)
    expect(parseModelsDevSnapshot(JSON.parse(text))).toEqual(snapshot)
  })

  it('rejects other schema versions and malformed files', () => {
    expect(parseModelsDevSnapshot({ schemaVersion: 2, fetchedAt: 1, providers: {} })).toBeNull()
    expect(parseModelsDevSnapshot({ schemaVersion: 1, providers: {} })).toBeNull()
    expect(parseModelsDevSnapshot('x')).toBeNull()
  })

  it('the bundled snapshot covers the builtin providers and every seed and small model id', () => {
    const snapshot = parseModelsDevSnapshot(JSON.parse(readFileSync(bundledSnapshotPath(), 'utf8')))
    expect(snapshot).not.toBeNull()
    expect(snapshot?.complete).toBe(false)
    expect(BUNDLED_MODELS_DEV_PROVIDERS).toEqual(BUILTIN_PROVIDER_IDS.filter(id => id !== 'openrouter' && id !== 'ollama'))
    for (const key of BUNDLED_MODELS_DEV_PROVIDERS)
      expect(Object.keys(snapshot?.providers[key] ?? {}).length, key).toBeGreaterThan(0)
    for (const definition of PROVIDER_DEFINITIONS) {
      if (definition.id === 'openrouter' || definition.id === 'ollama')
        continue
      const models = snapshot?.providers[definition.modelsDevId ?? definition.id] ?? {}
      for (const id of [...(definition.seedModels ?? []).map(model => model.id), definition.smallModelId].filter(Boolean))
        expect(models[id as string], `${definition.id}:${id}`).toBeDefined()
    }
  })
})
