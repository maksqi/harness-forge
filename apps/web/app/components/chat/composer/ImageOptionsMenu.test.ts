import type { ImageOptions } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testIds } from '~/utils/testids'
import { catalogModel } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { byTestId, seedStores, sonnet } from './composer-test-utils'
import ImageOptionsMenu from './ImageOptionsMenu.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => createMockApi() }))

const imageModel = catalogModel({
  providerId: 'openai',
  id: 'gpt-image-1',
  name: 'GPT Image 1',
  kind: 'image',
  contextWindow: null,
  capabilities: { tools: false, vision: true, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false },
})
const imageOutputModel = catalogModel({
  providerId: 'google',
  id: 'gemini-3-pro-image',
  name: 'Gemini 3 Pro Image',
  capabilities: { tools: false, vision: true, pdf: false, reasoning: false, structuredOutput: false, imageOutput: true },
})

let pinia: ReturnType<typeof createPinia>

function mountMenu(props: { modelValue: ImageOptions, modelRef: string | null, previousImages?: number, open?: boolean, returnFocusTo?: HTMLElement | null }) {
  return mount(ImageOptionsMenu, { props, attachTo: document.body, global: { plugins: [pinia] } })
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  seedStores({ models: [sonnet, imageModel, imageOutputModel] })
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

describe('imageOptionsMenu', () => {
  it('renders its trigger for an image model and for a chat model with image output', () => {
    for (const model of [imageModel, imageOutputModel]) {
      const wrapper = mountMenu({ modelValue: {}, modelRef: model.ref })
      const trigger = wrapper.get(byTestId(testIds.imageOptionsTrigger))
      expect(trigger.element).toBe(wrapper.element)
      expect(trigger.attributes('aria-label')).toBe('Image options')
      wrapper.unmount()
    }
  })

  it('renders nothing for other models, unknown models and without a model', () => {
    for (const modelRef of [sonnet.ref, 'openai:unknown-model', null]) {
      const wrapper = mountMenu({ modelValue: {}, modelRef })
      expect(wrapper.find(byTestId(testIds.imageOptionsTrigger)).exists()).toBe(false)
      wrapper.unmount()
    }
  })

  it('accepts every documented prop and asks to toggle v-model:open', async () => {
    const textarea = document.createElement('textarea')
    const options: ImageOptions = { n: 2, aspectRatio: '16:9', editPrevious: false }
    const wrapper = mountMenu({ modelValue: options, modelRef: imageModel.ref, previousImages: 2, open: false, returnFocusTo: textarea })
    expect(wrapper.props()).toMatchObject({ modelValue: options, modelRef: imageModel.ref, previousImages: 2, open: false, returnFocusTo: textarea })
    await wrapper.get(byTestId(testIds.imageOptionsTrigger)).trigger('click')
    expect(wrapper.emitted('update:open')).toEqual([[true]])
    await wrapper.setProps({ open: true })
    expect(wrapper.get(byTestId(testIds.imageOptionsTrigger)).attributes('aria-expanded')).toBe('true')
    await wrapper.get(byTestId(testIds.imageOptionsTrigger)).trigger('click')
    expect(wrapper.emitted('update:open')).toEqual([[true], [false]])
    wrapper.unmount()
  })

  it('defaults previousImages to 0, open to false and returnFocusTo to null', () => {
    const wrapper = mountMenu({ modelValue: {}, modelRef: imageModel.ref })
    expect(wrapper.props()).toMatchObject({ previousImages: 0, open: false, returnFocusTo: null })
    wrapper.unmount()
  })
})
