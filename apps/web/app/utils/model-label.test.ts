import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MODEL_LABEL_RESOLVER } from '~/components/providers/model-label'
import ModelLabel from '~/components/providers/ModelLabel.vue'
import { useModelsStore } from '~/stores/models'
import { useProvidersStore } from '~/stores/providers'
import { catalogModel, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { createModelLabelResolver } from './model-label'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  mock.api = createMockApi()
  stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  vi.unstubAllGlobals()
})

describe('createModelLabelResolver', () => {
  it('resolves model refs from the stores, reactively, for ModelLabel', async () => {
    const models = useModelsStore()
    const providers = useProvidersStore()
    const resolver = createModelLabelResolver({ model: ref => models.byRef(ref), provider: id => providers.byId(id) })
    const wrapper = mount(ModelLabel, {
      props: { modelRef: 'anthropic:claude-sonnet-5', showProvider: true },
      global: { provide: { [MODEL_LABEL_RESOLVER as symbol]: resolver } },
    })
    expect(wrapper.attributes('data-state')).toBe('unknown')

    models.items = [catalogModel({ name: 'Claude Sonnet 5' })]
    providers.items = [providerSummary()]
    await wrapper.vm.$nextTick()
    expect(wrapper.attributes('data-state')).toBe('known')
    expect(wrapper.text()).toContain('Claude Sonnet 5')
    expect(wrapper.text()).toContain('Anthropic (Claude)')
    expect(resolver('anthropic:claude-sonnet-5')).toEqual({
      name: 'Claude Sonnet 5',
      providerName: 'Anthropic (Claude)',
      icon: providerSummary().icon,
    })
    expect(resolver('ollama:unknown')).toBeNull()
  })
})
