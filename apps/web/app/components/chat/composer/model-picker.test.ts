import { describe, expect, it } from 'vitest'
import { catalogModel, providerSummary } from '~/utils/testing/fixtures'
import { imagePickerModels, isPickerModel, modelItemLabel, modelMatches, modelPickerGroups, resolveModelQuery, unconnectedProviders } from './model-picker'

const anthropic = providerSummary({ id: 'anthropic', name: 'Anthropic (Claude)' })
const ollama = providerSummary({ id: 'ollama', name: 'Ollama', local: true })
const sonnet = catalogModel({ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' })
const haiku = catalogModel({ id: 'claude-haiku-5', name: 'Claude Haiku 5', favorite: true })
const llama = catalogModel({ providerId: 'ollama', id: 'llama3:8b', name: 'Llama 3 8B', contextWindow: 8192 })
const NO_CAPS = { tools: false, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false }
const openai = providerSummary({ id: 'openai', name: 'OpenAI' })
const gptImage = catalogModel({ providerId: 'openai', id: 'gpt-image-1', name: 'GPT Image 1', kind: 'image', contextWindow: null, capabilities: { ...NO_CAPS, vision: true } })
const grokImage = catalogModel({ providerId: 'xai', id: 'grok-imagine-image', name: 'Grok Imagine', kind: 'image', contextWindow: null, capabilities: NO_CAPS })
const tts = catalogModel({ providerId: 'openai', id: 'gpt-4o-mini-tts', name: 'GPT-4o mini TTS', kind: 'speech', favorite: true, capabilities: NO_CAPS })
const whisper = catalogModel({ providerId: 'openai', id: 'whisper-1', name: 'Whisper', kind: 'transcription', capabilities: NO_CAPS })

const sources = {
  favorites: [haiku],
  recent: [llama, haiku],
  byProvider: [
    { provider: anthropic, models: [sonnet, haiku] },
    { provider: ollama, models: [llama] },
  ],
}

describe('model picker groups', () => {
  it('shows Favorites, then Recent (without favorites), then one group per provider', () => {
    const groups = modelPickerGroups(sources, '')
    expect(groups.map(group => [group.value, group.label, group.models.map(model => model.ref)])).toEqual([
      ['favorites', 'Favorites', ['anthropic:claude-haiku-5']],
      ['recent', 'Recent', ['ollama:llama3:8b']],
      ['anthropic', 'Anthropic (Claude)', ['anthropic:claude-sonnet-5', 'anthropic:claude-haiku-5']],
      ['ollama', 'Ollama', ['ollama:llama3:8b']],
    ])
    expect(groups[2]!.provider?.id).toBe('anthropic')
  })

  it('skips empty Favorites and Recent groups', () => {
    const groups = modelPickerGroups({ ...sources, favorites: [], recent: [] }, '')
    expect(groups.map(group => group.value)).toEqual(['anthropic', 'ollama'])
  })

  it('searches name, id and provider name, showing provider groups only', () => {
    expect(modelPickerGroups(sources, 'haiku').map(group => [group.value, group.models.map(model => model.id)]))
      .toEqual([['anthropic', ['claude-haiku-5']]])
    expect(modelPickerGroups(sources, 'llama3:8').map(group => group.value)).toEqual(['ollama'])
    expect(modelPickerGroups(sources, 'claude').flatMap(group => group.models).map(model => model.id))
      .toEqual(['claude-sonnet-5', 'claude-haiku-5'])
    expect(modelPickerGroups(sources, 'ollama llama').map(group => group.value)).toEqual(['ollama'])
    expect(modelPickerGroups(sources, 'gpt')).toEqual([])
  })

  it('adds the "Image models" group after the provider groups', () => {
    const groups = modelPickerGroups({ ...sources, images: [gptImage, grokImage] }, '')
    expect(groups.map(group => group.value)).toEqual(['favorites', 'recent', 'anthropic', 'ollama', 'images'])
    expect(groups.at(-1)).toMatchObject({ key: 'images', label: 'Image models', models: [gptImage, grokImage] })
    expect(modelPickerGroups({ ...sources, images: [] }, '').map(group => group.value)).not.toContain('images')
  })

  it('keeps Favorites and Recent to chat and image models (transcription and speech models are chosen in Settings)', () => {
    const groups = modelPickerGroups({ ...sources, favorites: [haiku, tts, gptImage], recent: [whisper, llama, tts] }, '')
    expect(groups.slice(0, 2).map(group => [group.value, group.models.map(model => model.id)])).toEqual([
      ['favorites', ['claude-haiku-5', 'gpt-image-1']],
      ['recent', ['llama3:8b']],
    ])
    expect(isPickerModel(sonnet)).toBe(true)
    expect(isPickerModel(gptImage)).toBe(true)
    expect(isPickerModel(tts)).toBe(false)
    expect(isPickerModel(whisper)).toBe(false)
  })

  it('searches the image models by name, id and provider name', () => {
    const withImages = { ...sources, images: [gptImage, grokImage], providerName: (id: string) => (id === 'openai' ? 'OpenAI' : 'xAI') }
    expect(modelPickerGroups(withImages, 'image').map(group => [group.value, group.models.map(model => model.id)]))
      .toEqual([['images', ['gpt-image-1', 'grok-imagine-image']]])
    expect(modelPickerGroups(withImages, 'openai').map(group => [group.value, group.models.map(model => model.id)]))
      .toEqual([['images', ['gpt-image-1']]])
    expect(modelPickerGroups(withImages, 'claude').map(group => group.value)).toEqual(['anthropic'])
    // Without a name lookup the provider id is searched.
    expect(modelPickerGroups({ ...sources, images: [grokImage] }, 'xai').map(group => group.value)).toEqual(['images'])
  })

  it('lists the visible image models of connected providers in provider order', () => {
    const xai = providerSummary({ id: 'xai', name: 'xAI' })
    const visible = [grokImage, sonnet, gptImage, tts, catalogModel({ providerId: 'gone', id: 'img', kind: 'image' })]
    expect(imagePickerModels(visible, [openai, anthropic, xai]).map(model => model.ref)).toEqual(['openai:gpt-image-1', 'xai:grok-imagine-image'])
    expect(imagePickerModels(visible, [xai]).map(model => model.ref)).toEqual(['xai:grok-imagine-image'])
    expect(imagePickerModels(visible, [])).toEqual([])
  })

  it('matches every term, ignoring case and accents', () => {
    expect(modelMatches(sonnet, 'Anthropic', 'SONNET anthrópic')).toBe(true)
    expect(modelMatches(sonnet, 'Anthropic', 'sonnet haiku')).toBe(false)
    expect(modelMatches(sonnet, 'Anthropic', '  ')).toBe(true)
  })
})

describe('not connected providers', () => {
  it('lists enabled providers without credentials, filtered by the search', () => {
    const providers = [
      anthropic,
      providerSummary({ id: 'openai', name: 'OpenAI', status: 'not_configured' }),
      providerSummary({ id: 'xai', name: 'xAI', status: 'not_configured', enabled: false }),
      providerSummary({ id: 'deepseek', name: 'DeepSeek', status: 'not_configured' }),
    ]
    expect(unconnectedProviders(providers, '').map(provider => provider.id)).toEqual(['openai', 'deepseek'])
    expect(unconnectedProviders(providers, 'deep').map(provider => provider.id)).toEqual(['deepseek'])
  })
})

describe('/model argument', () => {
  const visible = [sonnet, haiku, llama]
  const byRef = (ref: string) => visible.find(model => model.ref === ref)

  it('resolves a ref, then an id, then a display name', () => {
    expect(resolveModelQuery('anthropic:claude-sonnet-5', visible, byRef)).toBe('anthropic:claude-sonnet-5')
    expect(resolveModelQuery('llama3:8b', visible, byRef)).toBe('ollama:llama3:8b')
    expect(resolveModelQuery('claude haiku 5', visible, byRef)).toBe('anthropic:claude-haiku-5')
    expect(resolveModelQuery('gpt-9', visible, byRef)).toBeNull()
    expect(resolveModelQuery('  ', visible, byRef)).toBeNull()
  })
})

describe('item label', () => {
  it('reads model, provider, capabilities and context', () => {
    expect(modelItemLabel(sonnet, 'Anthropic', '200K')).toBe('Claude Sonnet 5, Anthropic, vision, tools, reasoning, 200K context')
  })

  it('reads image output (Phase 6) and skips an empty context', () => {
    const gemini = catalogModel({ providerId: 'google', id: 'gemini-3-pro-image', name: 'Gemini 3 Pro Image', capabilities: { ...NO_CAPS, vision: true, imageOutput: true } })
    expect(modelItemLabel(gemini, 'Google', '1M')).toBe('Gemini 3 Pro Image, Google, vision, image output, 1M context')
    expect(modelItemLabel(gptImage, 'OpenAI', '')).toBe('GPT Image 1, OpenAI, vision')
  })
})
