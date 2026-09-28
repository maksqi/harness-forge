import { customModelInputSchema, modelKindSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { catalogModel, providerSummary } from '~/utils/testing/fixtures'
import {
  contextWindowError,
  contextWindowRule,
  CUSTOM_MODEL_KINDS,
  customModelInput,
  isCustomModelKind,
  parseTokenCount,
} from './custom-model'
import {
  formatPrice,
  formatUsd,
  matchesModelQuery,
  MODEL_KIND_LABELS,
  MODEL_SELECT_EMPTY_TEXT,
  modelSections,
  modelSelectGroups,
  sortModels,
} from './models'

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

  it('builds the request body without blank optional fields, always with the kind', () => {
    expect(customModelInput('anthropic', {
      modelId: ' claude-next ',
      name: ' ',
      kind: 'chat',
      contextWindow: '',
      tools: true,
      vision: false,
      reasoning: true,
      pdf: false,
      imageOutput: false,
    })).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-next',
      kind: 'chat',
      capabilities: { tools: true, vision: false, reasoning: true, pdf: false, imageOutput: false },
    })
    expect(customModelInput('ollama', {
      modelId: 'llama3:70b',
      name: 'Llama 3 70B',
      kind: 'chat',
      contextWindow: '8K',
      tools: false,
      vision: false,
      reasoning: false,
      pdf: false,
      imageOutput: true,
    })).toMatchObject({ name: 'Llama 3 70B', kind: 'chat', contextWindow: 8000, capabilities: { imageOutput: true } })
  })

  it('sends neither a context window nor capabilities for the other kinds', () => {
    for (const kind of ['image', 'transcription', 'speech'] as const) {
      const body = customModelInput('openai', {
        modelId: 'gpt-image-2',
        name: 'GPT Image 2',
        kind,
        contextWindow: '128K',
        tools: true,
        vision: true,
        reasoning: false,
        pdf: false,
        imageOutput: false,
      })
      expect(body).toEqual({ providerId: 'openai', modelId: 'gpt-image-2', name: 'GPT Image 2', kind })
      expect(customModelInputSchema.safeParse(body).success).toBe(true)
    }
  })

  it('validates the context window only for chat models', () => {
    expect(contextWindowError('', 'chat')).toBeUndefined()
    expect(contextWindowError('200K', 'chat')).toBeUndefined()
    expect(contextWindowError('lots', 'chat')).toBe('Enter a number of tokens, e.g. 128000 or 128K.')
    expect(contextWindowError('lots', 'image')).toBeUndefined()
    expect(contextWindowError('-1', 'speech')).toBeUndefined()
  })

  it('offers the four kinds of the Kind select, Chat first', () => {
    expect(CUSTOM_MODEL_KINDS.map(option => [option.value, option.label])).toEqual([
      ['chat', 'Chat'],
      ['image', 'Image'],
      ['transcription', 'Speech to text'],
      ['speech', 'Text to speech'],
    ])
    for (const option of CUSTOM_MODEL_KINDS)
      expect(modelKindSchema.safeParse(option.value).success).toBe(true)
    expect(isCustomModelKind('speech')).toBe(true)
    expect(isCustomModelKind('embedding')).toBe(false)
    expect(isCustomModelKind(undefined)).toBe(false)
  })
})

describe('model select groups', () => {
  const openai = providerSummary({ id: 'openai', name: 'OpenAI (ChatGPT)' })
  const groq = providerSummary({ id: 'groq', name: 'Groq' })
  const models = [
    catalogModel({ providerId: 'openai', id: 'gpt-5', name: 'GPT-5' }),
    catalogModel({ providerId: 'openai', id: 'gpt-5-mini', name: 'GPT-5 mini', hidden: true }),
    catalogModel({ providerId: 'openai', id: 'gpt-image-1', name: 'GPT Image 1', kind: 'image' }),
    catalogModel({ providerId: 'openai', id: 'dall-e-2', name: 'DALL-E 2', kind: 'image', hidden: true }),
    catalogModel({ providerId: 'openai', id: 'gpt-4o-mini-transcribe', kind: 'transcription', hidden: true }),
    catalogModel({ providerId: 'openai', id: 'gpt-4o-mini-tts', kind: 'speech', hidden: true, voices: ['alloy', 'ash'] }),
    catalogModel({ providerId: 'openai', id: 'text-embedding-3', kind: 'embedding' }),
    catalogModel({ providerId: 'groq', id: 'whisper-large-v3-turbo', kind: 'transcription', hidden: true }),
    catalogModel({ providerId: 'mistral', id: 'voxtral-mini-latest', kind: 'transcription', hidden: true }),
    catalogModel({ id: 'claude-sonnet-5' }),
  ]
  const refs = (kind: Parameters<typeof modelSelectGroups>[2], providers = [groq, openai]) =>
    modelSelectGroups(providers, models, kind).map(group => [group.provider.id, group.models.map(model => model.id)])

  it('lists the visible chat models of connected providers only', () => {
    expect(refs('chat')).toEqual([['openai', ['gpt-5']]])
    expect(refs('chat', [anthropic, openai])).toEqual([['anthropic', ['claude-sonnet-5']], ['openai', ['gpt-5']]])
  })

  it('lists the visible image models', () => {
    expect(refs('image')).toEqual([['openai', ['gpt-image-1']]])
  })

  it('lists every speech-to-text and text-to-speech model, hidden ones included, in provider order', () => {
    expect(refs('transcription')).toEqual([['groq', ['whisper-large-v3-turbo']], ['openai', ['gpt-4o-mini-transcribe']]])
    expect(refs('speech')).toEqual([['openai', ['gpt-4o-mini-tts']]])
    expect(refs('speech', [groq])).toEqual([])
  })

  it('labels the kinds and the empty lists', () => {
    expect(MODEL_KIND_LABELS.image).toBe('Image')
    expect(MODEL_KIND_LABELS.transcription).toBe('Speech to text')
    expect(MODEL_KIND_LABELS.speech).toBe('Text to speech')
    expect(Object.keys(MODEL_KIND_LABELS).sort()).toEqual([...modelKindSchema.options].sort())
    expect(MODEL_SELECT_EMPTY_TEXT.image).toBe('No image models from your connected providers.')
  })
})
