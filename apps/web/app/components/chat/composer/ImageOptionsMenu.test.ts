import type { ImageOptions } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { catalogModel } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { bodyAll, byTestId, seedStores, sonnet } from './composer-test-utils'
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

interface MenuProps {
  modelValue: ImageOptions
  modelRef: string | null
  previousImages?: number
  open?: boolean
  returnFocusTo?: HTMLElement | null
}

/** Mounts the menu with v-model and v-model:open wired to a reactive state. */
function mountMenu(initial: MenuProps) {
  const state = reactive<MenuProps>({ open: false, ...initial })
  const wrapper = mount(defineComponent({
    render: () => h(TooltipProvider, null, {
      default: () => h(ImageOptionsMenu, {
        ...state,
        'onUpdate:modelValue': (value: ImageOptions) => {
          state.modelValue = value
        },
        'onUpdate:open': (value: boolean) => {
          state.open = value
        },
      }),
    }),
  }), { attachTo: document.body, global: { plugins: [pinia] } })
  const menu = () => wrapper.findComponent(ImageOptionsMenu)
  const trigger = () => wrapper.get(byTestId(testIds.imageOptionsTrigger))
  return { wrapper, state, menu, trigger }
}

function values(testId: string): Array<string | undefined> {
  return bodyAll(byTestId(testId)).map(item => item.dataset.value)
}

function item(testId: string, value: string): HTMLElement {
  return bodyAll(byTestId(testId, `[data-value="${value}"]`))[0]!
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
  it('renders its trigger with the summary for an image model and for a chat model with image output', () => {
    const image = mountMenu({ modelValue: { n: 2, aspectRatio: '16:9' }, modelRef: imageModel.ref })
    expect(image.trigger().attributes('aria-label')).toBe('Image options: 16:9, 2 images')
    expect(image.trigger().text()).toBe('16:9 · 2')
    expect(image.trigger().classes()).toContain('pointer-coarse:h-10')
    image.wrapper.unmount()

    const output = mountMenu({ modelValue: { n: 2, aspectRatio: '16:9' }, modelRef: imageOutputModel.ref })
    expect(output.trigger().attributes('aria-label')).toBe('Image options: 16:9')
    expect(output.trigger().text()).toBe('16:9')
    output.wrapper.unmount()

    const auto = mountMenu({ modelValue: {}, modelRef: imageModel.ref })
    expect(auto.trigger().text()).toBe('Auto')
    expect(auto.trigger().attributes('aria-label')).toBe('Image options: Auto, 1 image')
    auto.wrapper.unmount()
  })

  it('renders nothing for other models, unknown models and without a model', () => {
    for (const modelRef of [sonnet.ref, 'openai:unknown-model', null]) {
      const { wrapper } = mountMenu({ modelValue: {}, modelRef })
      expect(wrapper.find(byTestId(testIds.imageOptionsTrigger)).exists()).toBe(false)
      wrapper.unmount()
    }
  })

  it('image model: aspect ratio (Auto + 7), images 1-4 and "Edit the previous image" when the parent reply has images', async () => {
    const { wrapper } = mountMenu({ modelValue: {}, modelRef: imageModel.ref, previousImages: 2, open: true })
    await flushPromises()
    expect(values(testIds.imageAspectOption)).toEqual(['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'])
    expect(values(testIds.imageCountOption)).toEqual(['1', '2', '3', '4'])
    expect(item(testIds.imageAspectOption, 'auto').getAttribute('data-state')).toBe('checked')
    expect(item(testIds.imageCountOption, '1').getAttribute('data-state')).toBe('checked')
    const edit = bodyAll(byTestId(testIds.imageEditPrevious))
    expect(edit).toHaveLength(1)
    expect(edit[0]!.textContent).toContain('Edit the previous image')
    expect(edit[0]!.getAttribute('data-state')).toBe('checked')
    expect(document.body.textContent).toContain('Aspect ratio')
    expect(document.body.textContent).toContain('Images')
    wrapper.unmount()
  })

  it('image model without previous images: no "Edit the previous image"', async () => {
    const { wrapper } = mountMenu({ modelValue: {}, modelRef: imageModel.ref, open: true })
    await flushPromises()
    expect(values(testIds.imageCountOption)).toHaveLength(4)
    expect(bodyAll(byTestId(testIds.imageEditPrevious))).toHaveLength(0)
    wrapper.unmount()
  })

  it('chat model with image output: the aspect ratio only', async () => {
    const { wrapper } = mountMenu({ modelValue: { n: 3 }, modelRef: imageOutputModel.ref, previousImages: 1, open: true })
    await flushPromises()
    expect(values(testIds.imageAspectOption)).toHaveLength(8)
    expect(bodyAll(byTestId(testIds.imageCountOption))).toHaveLength(0)
    expect(bodyAll(byTestId(testIds.imageEditPrevious))).toHaveLength(0)
    wrapper.unmount()
  })

  it('emits the whole new value when a ratio is picked, and closes', async () => {
    const { wrapper, state, menu } = mountMenu({ modelValue: { editPrevious: false }, modelRef: imageModel.ref, previousImages: 1, open: true })
    await flushPromises()
    item(testIds.imageAspectOption, '16:9').click()
    await flushPromises()
    expect(menu().emitted('update:modelValue')).toEqual([[{ n: undefined, aspectRatio: '16:9', editPrevious: false }]])
    expect(state.open).toBe(false)
    wrapper.unmount()
  })

  it('emits a count, keeping the other options', async () => {
    const { wrapper, menu } = mountMenu({ modelValue: { aspectRatio: '16:9', editPrevious: false }, modelRef: imageModel.ref, open: true })
    await flushPromises()
    expect(item(testIds.imageAspectOption, '16:9').getAttribute('data-state')).toBe('checked')
    item(testIds.imageCountOption, '3').click()
    await flushPromises()
    expect(menu().emitted('update:modelValue')).toEqual([[{ n: 3, aspectRatio: '16:9', editPrevious: false }]])
    wrapper.unmount()
  })

  it('stores Auto and 1 image as the defaults (left out)', async () => {
    const auto = mountMenu({ modelValue: { n: 3, aspectRatio: '16:9' }, modelRef: imageModel.ref, open: true })
    await flushPromises()
    item(testIds.imageAspectOption, 'auto').click()
    await flushPromises()
    expect(auto.menu().emitted('update:modelValue')).toEqual([[{ n: 3, aspectRatio: undefined, editPrevious: undefined }]])
    auto.wrapper.unmount()

    const one = mountMenu({ modelValue: { n: 3 }, modelRef: imageModel.ref, open: true })
    await flushPromises()
    item(testIds.imageCountOption, '1').click()
    await flushPromises()
    expect(one.menu().emitted('update:modelValue')).toEqual([[{ n: undefined, aspectRatio: undefined, editPrevious: undefined }]])
    one.wrapper.unmount()
  })

  it('toggles "Edit the previous image": unchecked stores false, checked goes back to the default', async () => {
    const { wrapper, state, menu } = mountMenu({ modelValue: { n: 2 }, modelRef: imageModel.ref, previousImages: 1, open: true })
    await flushPromises()
    bodyAll(byTestId(testIds.imageEditPrevious))[0]!.click()
    await flushPromises()
    expect(menu().emitted('update:modelValue')!.at(-1)).toEqual([{ n: 2, aspectRatio: undefined, editPrevious: false }])

    state.open = true
    await flushPromises()
    const edit = bodyAll(byTestId(testIds.imageEditPrevious))[0]!
    expect(edit.getAttribute('data-state')).toBe('unchecked')
    edit.click()
    await flushPromises()
    expect(menu().emitted('update:modelValue')!.at(-1)).toEqual([{ n: 2, aspectRatio: undefined, editPrevious: undefined }])
    wrapper.unmount()
  })

  it('closes when the model stops taking image options', async () => {
    const { wrapper, state } = mountMenu({ modelValue: {}, modelRef: imageModel.ref, open: true })
    await flushPromises()
    expect(bodyAll(byTestId(testIds.imageAspectOption))).toHaveLength(8)
    state.modelRef = sonnet.ref
    await flushPromises()
    expect(state.open).toBe(false)
    state.modelRef = imageModel.ref
    await flushPromises()
    expect(bodyAll(byTestId(testIds.imageAspectOption))).toHaveLength(0)
    wrapper.unmount()
  })

  it('picking the current value emits nothing', async () => {
    const { wrapper, menu } = mountMenu({ modelValue: { aspectRatio: '1:1' }, modelRef: imageModel.ref, open: true })
    await flushPromises()
    item(testIds.imageAspectOption, '1:1').click()
    await flushPromises()
    expect(menu().emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })

  it('opens from the trigger and returns focus to returnFocusTo on close', async () => {
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    const { wrapper, state, trigger } = mountMenu({ modelValue: {}, modelRef: imageModel.ref, returnFocusTo: textarea })
    await trigger().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(state.open).toBe(true)
    expect(bodyAll(byTestId(testIds.imageAspectOption))).toHaveLength(8)
    expect(document.activeElement?.getAttribute('data-value')).toBe('auto')
    item(testIds.imageAspectOption, '4:3').click()
    await flushPromises()
    expect(state.open).toBe(false)
    expect(document.activeElement).toBe(textarea)
    wrapper.unmount()
  })

  it('defaults previousImages to 0, open to false and returnFocusTo to null', () => {
    const wrapper = mount(defineComponent({
      render: () => h(TooltipProvider, null, { default: () => h(ImageOptionsMenu, { modelValue: {}, modelRef: imageModel.ref }) }),
    }), { global: { plugins: [pinia] } })
    expect(wrapper.findComponent(ImageOptionsMenu).props()).toMatchObject({ previousImages: 0, open: false, returnFocusTo: null })
    wrapper.unmount()
  })
})
