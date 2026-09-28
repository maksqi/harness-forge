import { describe, expect, it } from 'vitest'
import { catalogModel, providerSummary } from '~/utils/testing/fixtures'
import { modelItemLabel, modelMatches, modelPickerGroups, resolveModelQuery, unconnectedProviders } from './model-picker'

const anthropic = providerSummary({ id: 'anthropic', name: 'Anthropic (Claude)' })
const ollama = providerSummary({ id: 'ollama', name: 'Ollama', local: true })
const sonnet = catalogModel({ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' })
const haiku = catalogModel({ id: 'claude-haiku-5', name: 'Claude Haiku 5', favorite: true })
const llama = catalogModel({ providerId: 'ollama', id: 'llama3:8b', name: 'Llama 3 8B', contextWindow: 8192 })

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
})
