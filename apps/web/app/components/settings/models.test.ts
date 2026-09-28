import { describe, expect, it } from 'vitest'
import { catalogModel, providerSummary } from '~/utils/testing/fixtures'
import { contextWindowRule, customModelInput, parseTokenCount } from './custom-model'
import { formatPrice, formatUsd, matchesModelQuery, modelSections, sortModels } from './models'

const anthropic = providerSummary()
const ollama = providerSummary({ id: 'ollama', name: 'Ollama (local)', local: true })

describe('model sections', () => {
  const models = [
    catalogModel({ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }),
    catalogModel({ id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', hidden: true }),
    catalogModel({ id: 'claude-opus-10', name: 'Claude Opus 10' }),
    catalogModel({ id: 'claude-opus-9', name: 'Claude Opus 9' }),
    catalogModel({ providerId: 'openai', id: 'gpt-5', name: 'GPT-5' }),
  ]

  it('keeps every connected provider, hidden models included, sorted by name', () => {
    const sections = modelSections([anthropic, ollama], models, '')
    expect(sections.map(section => section.provider.id)).toEqual(['anthropic', 'ollama'])
    expect(sections[0]!.models.map(model => model.name)).toEqual(['Claude Haiku 4.5', 'Claude Opus 9', 'Claude Opus 10', 'Claude Sonnet 5'])
    expect(sections[0]!.total).toBe(4)
    expect(sections[1]).toMatchObject({ models: [], total: 0 })
  })

  it('filters by name, id or alias and drops empty sections', () => {
    const sections = modelSections([anthropic, ollama], models, '  OPUS 10 ')
    expect(sections).toHaveLength(1)
    expect(sections[0]!.models.map(model => model.id)).toEqual(['claude-opus-10'])
    expect(sections[0]!.total).toBe(4)
    expect(matchesModelQuery({ name: 'x', id: 'y', alias: 'My favorite' }, 'favorite')).toBe(true)
    expect(matchesModelQuery({ name: 'Claude', id: 'claude-3', alias: null }, 'claude 4')).toBe(false)
    expect(sortModels([]).length).toBe(0)
  })
})

describe('prices', () => {
  it('formats USD per 1M tokens', () => {
    expect(formatUsd(3)).toBe('$3')
    expect(formatUsd(2.5)).toBe('$2.50')
    expect(formatUsd(0.15)).toBe('$0.15')
    expect(formatUsd(0.075)).toBe('$0.075')
    expect(formatUsd(0.0375)).toBe('$0.0375')
    expect(formatPrice({ input: 3, output: 15 })).toBe('$3 / $15')
    expect(formatPrice({ input: 0.25 })).toBe('$0.25 / —')
    expect(formatPrice({})).toBeNull()
    expect(formatPrice(null)).toBeNull()
  })
})

describe('custom model form', () => {
  it('parses token counts with K and M suffixes', () => {
    expect(parseTokenCount('128000')).toBe(128_000)
    expect(parseTokenCount('128k')).toBe(128_000)
    expect(parseTokenCount(' 1.5M ')).toBe(1_500_000)
    expect(parseTokenCount('0')).toBeNull()
    expect(parseTokenCount('1.5')).toBeNull()
    expect(parseTokenCount('lots')).toBeNull()
    expect(contextWindowRule.safeParse('').success).toBe(true)
    expect(contextWindowRule.safeParse('200K').success).toBe(true)
    expect(contextWindowRule.safeParse('-1').success).toBe(false)
  })

  it('builds the request body without blank optional fields', () => {
    expect(customModelInput('anthropic', {
      modelId: ' claude-next ',
      name: ' ',
      contextWindow: '',
      tools: true,
      vision: false,
      reasoning: true,
      pdf: false,
    })).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-next',
      capabilities: { tools: true, vision: false, reasoning: true, pdf: false },
    })
    expect(customModelInput('ollama', {
      modelId: 'llama3:70b',
      name: 'Llama 3 70B',
      contextWindow: '8K',
      tools: false,
      vision: false,
      reasoning: false,
      pdf: false,
    })).toMatchObject({ name: 'Llama 3 70B', contextWindow: 8000 })
  })
})
