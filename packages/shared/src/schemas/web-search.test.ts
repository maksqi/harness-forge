import { describe, expect, it } from 'vitest'
import { chatRequestBodySchema, noticeCodeSchema } from '../chat.ts'
import { modelWebSearchSchema, webSearchBackendSchema, webSearchModeSchema, webSearchUnavailableReasonSchema } from '../enums.ts'
import { MODEL_WEB_SEARCH_KINDS, WEB_SEARCH_BACKENDS, WEB_SEARCH_MODES, WEB_SEARCH_UNAVAILABLE_REASONS } from '../util/web-search.ts'
import { chatSettingsSchema, chatSettingsUpdateSchema, chatSummarySchema } from './chats.ts'
import { catalogModelSchema } from './models.ts'
import {
  searchWebInputSchema,
  searchWebOutputSchema,
  searchWebResultSchema,
  webSearchTestBodySchema,
  webSearchTestResultSchema,
} from './web-search.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'

const model = {
  ref: 'anthropic:claude-sonnet-5',
  providerId: 'anthropic',
  id: 'claude-sonnet-5',
  name: 'Claude Sonnet 5',
  alias: null,
  kind: 'chat',
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true, imageOutput: false },
  reasoningEfforts: ['auto', 'low', 'high'],
  cost: null,
  favorite: false,
  hidden: false,
  custom: false,
  source: 'live',
  lastUsedAt: null,
}

describe('web search enums (Phase 14, ADR-062 / ADR-063)', () => {
  it('builds the enums from the helper constants', () => {
    expect(webSearchModeSchema.options).toEqual([...WEB_SEARCH_MODES])
    expect(webSearchModeSchema.options).toEqual(['off', 'auto'])
    expect(modelWebSearchSchema.options).toEqual([...MODEL_WEB_SEARCH_KINDS])
    expect(webSearchBackendSchema.options).toEqual([...WEB_SEARCH_BACKENDS])
    expect(webSearchBackendSchema.options).toEqual(['brave', 'tavily', 'exa'])
    expect(webSearchUnavailableReasonSchema.options).toEqual([...WEB_SEARCH_UNAVAILABLE_REASONS])
    expect(noticeCodeSchema.options.at(-1)).toBe('web-search-unavailable')
  })
})

describe('chat settings, request body and summary (ADR-063)', () => {
  it('reads v1.8.1 chat settings (no `webSearch`) and the new mode', () => {
    expect(chatSettingsSchema.parse({ toolMode: 'ask', outputStyle: 'default' })).toEqual({ toolMode: 'ask', outputStyle: 'default' })
    expect(chatSettingsSchema.parse({ webSearch: 'auto' })).toEqual({ webSearch: 'auto' })
    expect(chatSettingsSchema.safeParse({ webSearch: 'on' }).success).toBe(false)
    expect(chatSettingsUpdateSchema.parse({ webSearch: null })).toEqual({ webSearch: null })
    expect(chatSettingsUpdateSchema.parse({ webSearch: 'off' })).toEqual({ webSearch: 'off' })
    expect(chatSettingsUpdateSchema.safeParse({ webSearch: true }).success).toBe(false)
  })

  it('takes the mode of the turn in the request body (optional)', () => {
    const body = {
      chatId: CHAT_ID,
      message: { id: 'msg_A000000000000001', role: 'user', parts: [{ type: 'text', text: 'News?' }] },
      trigger: 'submit-message',
      modelRef: 'anthropic:claude-sonnet-5',
      reasoningEffort: 'auto',
      toolMode: 'ask',
    }
    expect(chatRequestBodySchema.parse(body).webSearch).toBeUndefined()
    expect(chatRequestBodySchema.parse({ ...body, webSearch: 'auto' }).webSearch).toBe('auto')
    expect(chatRequestBodySchema.safeParse({ ...body, webSearch: 'native' }).success).toBe(false)
  })

  it('marks a chat that waits for an elicitation answer (live, optional)', () => {
    const summary = {
      id: CHAT_ID,
      title: null,
      titleSource: null,
      modelRef: null,
      pinned: false,
      archived: false,
      running: true,
      pendingApproval: false,
      projectId: null,
      createdAt: 1,
      updatedAt: 2,
    }
    expect(chatSummarySchema.parse(summary).awaitingInput).toBeUndefined()
    expect(chatSummarySchema.parse({ ...summary, awaitingInput: true }).awaitingInput).toBe(true)
    expect(chatSummarySchema.safeParse({ ...summary, awaitingInput: 'yes' }).success).toBe(false)
  })
})

describe('catalog models (ADR-062)', () => {
  it('reads cached v1.8.1 models without `webSearch` and the new flag', () => {
    expect(catalogModelSchema.parse(model).webSearch).toBeUndefined()
    expect(catalogModelSchema.parse({ ...model, webSearch: 'native' }).webSearch).toBe('native')
    expect(catalogModelSchema.parse({ ...model, webSearch: 'exclusive' }).webSearch).toBe('exclusive')
    expect(catalogModelSchema.parse({ ...model, webSearch: null }).webSearch).toBeNull()
    expect(catalogModelSchema.safeParse({ ...model, webSearch: 'builtin' }).success).toBe(false)
  })
})

describe('search_web input and output (ADR-063)', () => {
  it('validates the tool input', () => {
    expect(searchWebInputSchema.parse({ query: '  harness forge  ' })).toEqual({ query: 'harness forge' })
    expect(searchWebInputSchema.parse({ query: 'x', count: 10, freshness: 'week' })).toEqual({ query: 'x', count: 10, freshness: 'week' })
    for (const bad of [{ query: '' }, { query: '   ' }, { query: 'x'.repeat(401) }, { query: 'x', count: 0 }, { query: 'x', count: 11 }, { query: 'x', count: 1.5 }, { query: 'x', freshness: 'hour' }, {}])
      expect(searchWebInputSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false)
  })

  it('validates the normalized results (http(s) URLs only, capped text)', () => {
    const result = { title: 'Harness Forge', url: 'https://example.com/a?b=c', snippet: 'A self-hosted chat.', published: '2026-10-01' }
    expect(searchWebResultSchema.parse(result)).toEqual(result)
    expect(searchWebResultSchema.parse({ ...result, published: null }).published).toBeNull()
    for (const change of [
      { url: 'javascript:alert(1)' },
      { url: 'ftp://example.com' },
      { url: `https://example.com/${'x'.repeat(2048)}` },
      { url: 'https://exa mple.com' },
      { title: 'x'.repeat(301) },
      { snippet: 'x'.repeat(801) },
    ])
      expect(searchWebResultSchema.safeParse({ ...result, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
    const output = { query: 'harness forge', backend: 'brave', results: [result] }
    expect(searchWebOutputSchema.parse(output)).toEqual(output)
    expect(searchWebOutputSchema.safeParse({ ...output, results: Array.from({ length: 11 }).fill(result) }).success).toBe(false)
    expect(searchWebOutputSchema.safeParse({ ...output, backend: 'searxng' }).success).toBe(false)
  })

  it('validates the test route', () => {
    expect(webSearchTestBodySchema.parse({})).toEqual({})
    expect(webSearchTestBodySchema.parse({ backend: 'tavily' })).toEqual({ backend: 'tavily' })
    expect(webSearchTestBodySchema.safeParse({ backend: 'google' }).success).toBe(false)
    expect(webSearchTestBodySchema.safeParse({ query: 'x' }).success).toBe(false)
    expect(webSearchTestResultSchema.parse({ ok: true, backend: 'exa', results: 5, ms: 312 })).toEqual({ ok: true, backend: 'exa', results: 5, ms: 312 })
    expect(webSearchTestResultSchema.safeParse({ ok: false, backend: 'exa', results: 5, ms: 312 }).success).toBe(false)
  })
})
