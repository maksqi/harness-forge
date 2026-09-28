import type { HookMap, HookName, ProviderOptions, ReasoningParams } from '@harness-forge/plugin-sdk'
import type { ReasoningEffort } from '@harness-forge/shared'
import type { ResolvedModel } from '../providers/types.ts'
import type { RunParamsInput } from './params.ts'
import { describe, expect, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { buildRunParams, joinInstructions, mergeProviderOptions, providerImageOptions, providerReasoning } from './params.ts'

function resolved(options: { reasoning?: boolean, efforts?: ReasoningEffort[], fn?: (effort: ReasoningEffort) => ReasoningParams | undefined } = {}): ResolvedModel {
  return {
    modelRef: 'prov:model',
    providerId: 'prov',
    modelId: 'model',
    info: { id: 'model' },
    entry: { capabilities: { reasoning: options.reasoning ?? true }, reasoningEfforts: options.efforts ?? ['auto', 'off', 'low', 'high'] },
    provider: { pluginId: 'demo', definition: { id: 'prov', name: 'Prov', credentials: [], createLanguageModel: () => null as never, ...(options.fn === undefined ? {} : { reasoning: options.fn }) } },
  } as unknown as ResolvedModel
}

type HookRun = <K extends HookName>(name: K, ...args: HookMap[K]) => Promise<void>

function input(overrides: Partial<RunParamsInput> & { run?: HookRun } = {}): RunParamsInput {
  const run: HookRun = overrides.run ?? (async () => {})
  return {
    chatId: 'chat',
    modelRef: 'prov:model',
    resolved: resolved({ fn: effort => ({ reasoning: effort === 'off' ? 'none' : 'high', providerOptions: { prov: { budget: 1024 } } }) }),
    reasoningEffort: 'high',
    toolMode: 'ask',
    globalInstructions: ' Global. ',
    chatInstructions: 'Chat.',
    maxSteps: 20,
    registry: { hooks: { run, on: () => ({ dispose() {} }), list: () => [] } },
    logger: createSilentLogger(),
    ...overrides,
  }
}

describe('instructions', () => {
  it('joins global and chat instructions with a blank line, skipping empty ones', () => {
    expect(joinInstructions(' Global. ', 'Chat.')).toBe('Global.\n\nChat.')
    expect(joinInstructions('', undefined)).toBe('')
    expect(joinInstructions(undefined, 'Only chat')).toBe('Only chat')
  })
})

describe('providerReasoning', () => {
  it('calls provider.reasoning only for an offered effort of a reasoning model', () => {
    const fn = (effort: ReasoningEffort): ReasoningParams => ({ reasoning: effort === 'off' ? 'none' : 'high' })
    const logger = createSilentLogger()
    expect(providerReasoning(resolved({ fn }), 'high', logger)).toEqual({ reasoning: 'high' })
    expect(providerReasoning(resolved({ fn }), 'off', logger)).toEqual({ reasoning: 'none' })
    expect(providerReasoning(resolved({ fn }), 'auto', logger)).toBeUndefined()
    expect(providerReasoning(resolved({ fn }), 'medium', logger)).toBeUndefined()
    expect(providerReasoning(resolved({ fn, reasoning: false }), 'high', logger)).toBeUndefined()
    expect(providerReasoning(resolved(), 'high', logger)).toBeUndefined()
  })

  it('ignores a throwing provider and invalid values', () => {
    const logger = createSilentLogger()
    expect(providerReasoning(resolved({ fn: () => {
      throw new Error('bad')
    } }), 'high', logger)).toBeUndefined()
    expect(providerReasoning(resolved({ fn: () => ({ reasoning: 'extreme', providerOptions: { prov: 'x' }, maxOutputTokens: -1 }) as never }), 'high', logger)).toEqual({})
    expect(providerReasoning(resolved({ fn: () => ({ maxOutputTokens: 8000, providerOptions: { prov: { a: 1 } } }) }), 'high', logger)).toEqual({ maxOutputTokens: 8000, providerOptions: { prov: { a: 1 } } })
  })
})

describe('buildRunParams', () => {
  it('builds instructions, reasoning and provider options without hooks', async () => {
    expect(await buildRunParams(input())).toEqual({
      instructions: 'Global.\n\nChat.',
      maxSteps: 20,
      providerOptions: { prov: { budget: 1024 } },
      reasoning: 'high',
      headers: {},
    })
    expect((await buildRunParams(input({ globalInstructions: '', chatInstructions: undefined, reasoningEffort: 'auto' })))).toEqual({ instructions: undefined, maxSteps: 20, providerOptions: {}, headers: {} })
  })

  it('applies chat.params and chat.headers hooks and checks their values', async () => {
    const run: HookRun = async (name, ...args) => {
      const [hookInput, output] = args as unknown as [Record<string, unknown>, Record<string, unknown>]
      if (name === 'chat.params') {
        expect(hookInput).toMatchObject({ chatId: 'chat', modelRef: 'prov:model', reasoningEffort: 'high', toolMode: 'ask', model: { id: 'model' } })
        output.instructions = `${String(output.instructions)} Hooked.`
        output.temperature = 0.2
        output.maxOutputTokens = 512
        output.maxSteps = 500
        output.reasoning = 'low';
        (output.providerOptions as Record<string, unknown>).extra = { on: true }
      }
      if (name === 'chat.headers') {
        output.headers = { 'x-ok': 'yes', 'bad name': 'no', 'x-newline': 'a\nb', 'x-number': 5 }
      }
    }
    expect(await buildRunParams(input({ run }))).toEqual({
      instructions: 'Global.\n\nChat. Hooked.',
      temperature: 0.2,
      maxOutputTokens: 512,
      maxSteps: 100,
      reasoning: 'low',
      providerOptions: { prov: { budget: 1024 }, extra: { on: true } },
      headers: { 'x-ok': 'yes' },
    })
  })

  it('falls back to the pre-hook values for invalid hook output', async () => {
    const run: HookRun = async (name, ...args) => {
      const output = args[1] as unknown as Record<string, unknown>
      if (name === 'chat.params') {
        output.instructions = 42
        output.maxSteps = 'many'
        output.reasoning = 'extreme'
        output.providerOptions = 'nope'
        output.temperature = Number.NaN
      }
    }
    expect(await buildRunParams(input({ run }))).toEqual({
      instructions: 'Global.\n\nChat.',
      maxSteps: 20,
      reasoning: 'high',
      providerOptions: { prov: { budget: 1024 } },
      headers: {},
    })
  })
})

describe('image output provider options (ADR-028)', () => {
  function imageModel(imageParams?: (request: unknown) => unknown): ResolvedModel {
    const base = resolved()
    return { ...base, provider: { ...base.provider, definition: { ...base.provider.definition, ...(imageParams === undefined ? {} : { imageParams }) } } } as unknown as ResolvedModel
  }

  it('asks imageParams for one image with the aspect ratio and keeps only valid provider options', () => {
    const requests: unknown[] = []
    const model = imageModel((request) => {
      requests.push(request)
      return { providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'] } }, size: '1024x1024' }
    })
    expect(providerImageOptions(model, '16:9', createSilentLogger())).toEqual({ google: { responseModalities: ['TEXT', 'IMAGE'] } })
    expect(providerImageOptions(model, undefined, createSilentLogger())).toEqual({ google: { responseModalities: ['TEXT', 'IMAGE'] } })
    expect(requests).toEqual([{ n: 1, inputs: 0, aspectRatio: '16:9' }, { n: 1, inputs: 0 }])
    expect(providerImageOptions(imageModel(), '1:1', createSilentLogger())).toBeUndefined()
    expect(providerImageOptions(imageModel(() => undefined), '1:1', createSilentLogger())).toBeUndefined()
    expect(providerImageOptions(imageModel(() => ({ providerOptions: { google: 'x' } })), '1:1', createSilentLogger())).toBeUndefined()
    expect(providerImageOptions(imageModel(() => {
      throw new Error('broken plugin')
    }), '1:1', createSilentLogger())).toBeUndefined()
  })

  it('deep-merges the reasoning options over the image options, before the hooks see them', async () => {
    expect(mergeProviderOptions({ google: { a: 1, nested: { x: 1 } }, other: { keep: true } }, { google: { b: 2, nested: { y: 2 } } })).toEqual({
      google: { a: 1, b: 2, nested: { x: 1, y: 2 } },
      other: { keep: true },
    })
    const polluted = JSON.parse('{"prov":{"__proto__":{"polluted":true},"ok":1}}') as ProviderOptions
    const merged = mergeProviderOptions({}, polluted)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(merged.prov).toMatchObject({ ok: 1 })
    const seen: unknown[] = []
    const params = await buildRunParams(input({
      imageProviderOptions: { prov: { responseModalities: ['TEXT', 'IMAGE'] }, img: { aspectRatio: '16:9' } },
      run: async (name, ...args) => {
        if (name === 'chat.params')
          seen.push(structuredClone((args[1] as { providerOptions: unknown }).providerOptions))
      },
    }))
    const expected = { prov: { responseModalities: ['TEXT', 'IMAGE'], budget: 1024 }, img: { aspectRatio: '16:9' } }
    expect(seen).toEqual([expected])
    expect(params.providerOptions).toEqual(expected)
  })
})
