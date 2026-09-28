import type { ModelLabelResolver } from './model-label'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { MODEL_LABEL_RESOLVER, splitModelRef } from './model-label'
import ModelLabel from './ModelLabel.vue'

const resolver: ModelLabelResolver = ref => (ref === 'anthropic:claude-sonnet-5'
  ? { name: 'Claude Sonnet 5', providerName: 'Anthropic', icon: { mono: '/api/icons/lobe/anthropic' } }
  : null)

describe('modelLabel', () => {
  it('shows the provider icon and the model name from the resolver', () => {
    const wrapper = mount(ModelLabel, {
      props: { modelRef: 'anthropic:claude-sonnet-5', showProvider: true },
      global: { provide: { [MODEL_LABEL_RESOLVER as symbol]: resolver } },
    })
    expect(wrapper.attributes('data-state')).toBe('known')
    expect(wrapper.get('[data-slot="provider-icon"]').attributes('aria-label')).toBe('Anthropic')
    expect(wrapper.text()).toContain('Claude Sonnet 5')
    expect(wrapper.text()).toContain('Anthropic')
  })

  it('shows the raw model id with a warning for unknown refs', () => {
    const wrapper = mount(ModelLabel, { props: { modelRef: 'ollama:llama3:8b' } })
    expect(wrapper.attributes('data-state')).toBe('unknown')
    expect(wrapper.get('.font-mono').text()).toBe('llama3:8b')
    expect(wrapper.text()).toContain('unknown model')
  })

  it('splits model refs on the first colon only', () => {
    expect(splitModelRef('openrouter:anthropic/claude-sonnet-5')).toEqual({ providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-5' })
    expect(splitModelRef('ollama:llama3:8b')).toEqual({ providerId: 'ollama', modelId: 'llama3:8b' })
    expect(splitModelRef('no-colon')).toBeNull()
    expect(splitModelRef(':x')).toBeNull()
  })
})
