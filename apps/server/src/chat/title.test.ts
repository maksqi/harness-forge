import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { ChatSummary, Settings } from '@harness-forge/shared'
import type { ResolvedModel } from '../providers/types.ts'
import type { UsageInput } from '../services/chats/types.ts'
import type { TitleServices } from './title.ts'
import { DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { cleanTitle, fallbackTitle, generateChatTitle, TITLE_INSTRUCTIONS, TITLE_TIMEOUT_MS, titleModelCandidates } from './title.ts'

function textModel(text: string, calls: LanguageModelV4CallOptions[] = []): LanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options)
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } },
        warnings: [],
      }
    },
  })
}

/** A model that answers only when its call is aborted (then it rejects). */
function hangingModel(): LanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: options => new Promise((_resolve, reject) => {
      options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason), { once: true })
    }),
  })
}

function resolved(modelRef: string, model: LanguageModelV4, smallModelId?: string): ResolvedModel {
  const [providerId = '', modelId = ''] = modelRef.split(':')
  return {
    modelRef,
    providerId,
    modelId,
    model,
    info: { id: modelId },
    entry: { cost: { input: 1, output: 2 }, capabilities: { reasoning: false }, reasoningEfforts: [] },
    provider: { pluginId: 'demo', definition: { id: providerId, name: providerId, credentials: [], smallModelId, createLanguageModel: () => model } },
  } as unknown as ResolvedModel
}

interface Harness {
  services: TitleServices
  titles: { title: string, source: string }[]
  usage: UsageInput[]
  resolvedRefs: string[]
}

function harness(models: Record<string, LanguageModelV4 | Error>, settings: Partial<Settings> = {}, userTitle = false): Harness {
  const titles: { title: string, source: string }[] = []
  const usage: UsageInput[] = []
  const resolvedRefs: string[] = []
  return {
    titles,
    usage,
    resolvedRefs,
    services: {
      settings: { get: async () => ({ ...DEFAULT_SETTINGS, ...settings }) },
      providers: {
        resolveModel: async (ref) => {
          resolvedRefs.push(ref)
          const model = models[ref]
          if (model === undefined || model instanceof Error)
            throw model ?? new HarnessError({ code: 'provider_not_configured', message: 'no' })
          return resolved(ref, model)
        },
      },
      chats: {
        setTitle: async (_id, title, source) => {
          if (userTitle)
            return null
          titles.push({ title, source })
          return { title, titleSource: source } as ChatSummary
        },
        addUsage: async (input) => {
          usage.push(input)
        },
      },
    },
  }
}

const chatModel = resolved('prov:big', textModel('unused'), 'small')

describe('title text', () => {
  it('cleans a model answer: first line, no markdown / quotes / prefix, at most 8 words', () => {
    expect(cleanTitle('"Trip to Lisbon"')).toBe('Trip to Lisbon')
    expect(cleanTitle('\n\n# **Title:** Planning a *weekend* trip to Lisbon with friends and family.\nMore text')).toBe('Planning a weekend trip to Lisbon with friends')
    expect(cleanTitle('Title: Debugging React hooks!')).toBe('Debugging React hooks')
    expect(cleanTitle('   ')).toBeNull()
    expect(cleanTitle('"..."')).toBeNull()
  })

  it('falls back to the first 60 characters of the message', () => {
    expect(fallbackTitle('  short   message\n')).toBe('short message')
    const long = 'x'.repeat(100)
    expect(fallbackTitle(long)).toBe('x'.repeat(60))
    expect(fallbackTitle('😀'.repeat(70))).toBe('😀'.repeat(60))
    expect(fallbackTitle('   ')).toBeNull()
  })

  it('tries titleModelRef, then the small model of the chat provider, then the chat model', () => {
    expect(titleModelCandidates('other:title', chatModel)).toEqual(['other:title', 'prov:small', 'prov:big'])
    expect(titleModelCandidates(null, chatModel)).toEqual(['prov:small', 'prov:big'])
    expect(titleModelCandidates(null, resolved('prov:big', textModel('x')))).toEqual(['prov:big'])
    expect(titleModelCandidates('prov:big', resolved('prov:big', textModel('x'), 'big'))).toEqual(['prov:big'])
  })
})

describe('generateChatTitle', () => {
  it('stores the model title (source auto) and a title usage row', async () => {
    const calls: LanguageModelV4CallOptions[] = []
    const h = harness({ 'prov:small': textModel('Lisbon weekend plans', calls) })
    const result = await generateChatTitle(h.services, { chatId: 'chat', text: 'Plan a weekend in Lisbon', chatModel, logger: createSilentLogger() })
    expect(result).toMatchObject({ title: 'Lisbon weekend plans', titleSource: 'auto' })
    expect(h.titles).toEqual([{ title: 'Lisbon weekend plans', source: 'auto' }])
    expect(h.resolvedRefs).toEqual(['prov:small'])
    expect(calls[0]?.prompt[0]).toEqual({ role: 'system', content: TITLE_INSTRUCTIONS })
    await vi.waitFor(() => expect(h.usage).toHaveLength(1))
    expect(h.usage[0]).toMatchObject({ chatId: 'chat', messageId: null, purpose: 'title', providerId: 'prov', modelId: 'small', inputTokens: 10, outputTokens: 4, costUsd: 0.000018 })
  })

  it('uses the next candidate when a model cannot be resolved, and the fallback when none can', async () => {
    const h = harness({ 'other:title': new Error('not configured'), 'prov:small': textModel('From small') }, { titleModelRef: 'other:title' })
    await generateChatTitle(h.services, { chatId: 'chat', text: 'hello', chatModel, logger: createSilentLogger() })
    expect(h.resolvedRefs).toEqual(['other:title', 'prov:small'])
    expect(h.titles).toEqual([{ title: 'From small', source: 'auto' }])

    const none = harness({})
    await generateChatTitle(none.services, { chatId: 'chat', text: 'A question about something rather long that keeps going on and on', chatModel, logger: createSilentLogger() })
    expect(none.titles).toEqual([{ title: 'A question about something rather long that keeps going on a', source: 'fallback' }])
  })

  it('uses the fallback when the model answers nothing usable or fails', async () => {
    const empty = harness({ 'prov:small': textModel('   ') })
    await generateChatTitle(empty.services, { chatId: 'chat', text: 'hello world', chatModel, logger: createSilentLogger() })
    expect(empty.titles).toEqual([{ title: 'hello world', source: 'fallback' }])
    const failing = harness({
      'prov:small': new MockLanguageModelV4({ doGenerate: async () => {
        throw new Error('500')
      } }),
    })
    await generateChatTitle(failing.services, { chatId: 'chat', text: 'hello world', chatModel, logger: createSilentLogger() })
    expect(failing.titles).toEqual([{ title: 'hello world', source: 'fallback' }])
  })

  it('never stores anything for an empty message or when a user title exists', async () => {
    const h = harness({ 'prov:small': textModel('x') })
    expect(await generateChatTitle(h.services, { chatId: 'chat', text: '  ', chatModel, logger: createSilentLogger() })).toBeNull()
    expect(h.resolvedRefs).toEqual([])
    const user = harness({ 'prov:small': textModel('Model title') }, {}, true)
    expect(await generateChatTitle(user.services, { chatId: 'chat', text: 'hello', chatModel, logger: createSilentLogger() })).toBeNull()
  })

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('falls back to the first 60 characters after the 10 s timeout', async () => {
      const h = harness({ 'prov:small': hangingModel() })
      const pending = generateChatTitle(h.services, { chatId: 'chat', text: 'What is the airspeed velocity of an unladen swallow?', chatModel, logger: createSilentLogger() })
      await vi.advanceTimersByTimeAsync(TITLE_TIMEOUT_MS - 1)
      expect(h.titles).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await pending
      expect(h.titles).toEqual([{ title: 'What is the airspeed velocity of an unladen swallow?', source: 'fallback' }])
    })

    it('stores nothing when the attempt is aborted (shutdown)', async () => {
      const h = harness({ 'prov:small': hangingModel() })
      const controller = new AbortController()
      const pending = generateChatTitle(h.services, { chatId: 'chat', text: 'hello', chatModel, logger: createSilentLogger(), signal: controller.signal })
      await vi.advanceTimersByTimeAsync(10)
      controller.abort()
      await vi.advanceTimersByTimeAsync(TITLE_TIMEOUT_MS)
      expect(await pending).toBeNull()
      expect(h.titles).toEqual([])
    })
  })
})
