import type { Settings } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { isChoice, TEXT_SIZE_OPTIONS } from './appearance'
import AppearanceSettings from './AppearanceSettings.vue'

const mock = vi.hoisted(() => ({
  api: null as unknown,
  colorMode: null as null | { preference: string, value: string },
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('./nuxt-imports', () => ({ useColorMode: () => mock.colorMode }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  mock.colorMode = reactive({ preference: 'dark', value: 'dark' })
  pinia = createPinia()
  setActivePinia(pinia)
  stubLocalStorage()
  let current: Settings = { ...DEFAULT_SETTINGS }
  api.settings.get.mockImplementation(async () => current)
  api.settings.update.mockImplementation(async ({ body }: { body: Partial<Settings> }) => {
    current = { ...current, ...body }
    return current
  })
})

afterEach(() => {
  disposePinia(pinia)
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  delete document.documentElement.dataset.density
  delete document.documentElement.dataset.textSize
  delete document.documentElement.dataset.readingFont
})

async function mountAppearance() {
  const wrapper = mount(AppearanceSettings, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

function card(wrapper: Awaited<ReturnType<typeof mountAppearance>>, value: string) {
  return wrapper.get(`[data-testid="${testIds.appearanceThemeCard}"][data-value="${value}"]`)
}

describe('appearanceSettings', () => {
  it('binds the theme cards to useColorMode().preference', async () => {
    const wrapper = await mountAppearance()
    expect(card(wrapper, 'dark').attributes('data-state')).toBe('on')
    expect(card(wrapper, 'light').attributes('data-state')).toBe('off')

    await card(wrapper, 'light').get('[role="radio"]').trigger('click')
    expect(mock.colorMode!.preference).toBe('light')
    expect(card(wrapper, 'light').attributes('data-state')).toBe('on')
    expect(card(wrapper, 'dark').attributes('data-state')).toBe('off')

    await card(wrapper, 'system').get('[role="radio"]').trigger('click')
    expect(mock.colorMode!.preference).toBe('system')
    // The theme never goes to the server.
    expect(api.settings.update).not.toHaveBeenCalled()
  })

  it('follows a preference changed elsewhere (sidebar toggle) and reads unknown values as dark', async () => {
    const wrapper = await mountAppearance()
    mock.colorMode!.preference = 'system'
    await flushPromises()
    expect(card(wrapper, 'system').attributes('data-state')).toBe('on')
    mock.colorMode!.preference = 'sepia'
    await flushPromises()
    expect(card(wrapper, 'dark').attributes('data-state')).toBe('on')
  })

  it('applies reading font, text size and density instantly and saves them', async () => {
    const wrapper = await mountAppearance()

    await wrapper.get(`[data-testid="${testIds.appearanceReadingFont}"] [data-value="serif"]`).trigger('click')
    expect(document.documentElement.dataset.readingFont).toBe('serif')
    await wrapper.get(`[data-testid="${testIds.appearanceTextSize}"] [data-value="lg"]`).trigger('click')
    expect(document.documentElement.dataset.textSize).toBe('lg')
    await wrapper.get(`[data-testid="${testIds.appearanceDensity}"] [data-value="compact"]`).trigger('click')
    expect(document.documentElement.dataset.density).toBe('compact')
    await flushPromises()

    expect(api.settings.update).toHaveBeenCalledWith({ body: { readingFont: 'serif' } })
    expect(api.settings.update).toHaveBeenCalledWith({ body: { textSize: 'lg' } })
    expect(api.settings.update).toHaveBeenCalledWith({ body: { density: 'compact' } })
    expect(JSON.parse(localStorage.getItem('hf-appearance') ?? '{}')).toEqual({ density: 'compact', textSize: 'lg', readingFont: 'serif' })
  })

  it('keeps the current choice when the active item is clicked again', async () => {
    const wrapper = await mountAppearance()
    await wrapper.get(`[data-testid="${testIds.appearanceTextSize}"] [data-value="md"]`).trigger('click')
    await flushPromises()
    expect(api.settings.update).not.toHaveBeenCalled()
  })

  it('toggles "Expand thinking by default"', async () => {
    const wrapper = await mountAppearance()
    const toggle = wrapper.get(`[data-testid="${testIds.appearanceShowThinking}"]`)
    expect(toggle.attributes('aria-checked')).toBe('false')
    await toggle.trigger('click')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { showThinking: true } })
    expect(toggle.attributes('aria-checked')).toBe('true')
  })

  it('recognizes valid choices', () => {
    expect(isChoice(TEXT_SIZE_OPTIONS, 'sm')).toBe(true)
    expect(isChoice(TEXT_SIZE_OPTIONS, '')).toBe(false)
    expect(isChoice(TEXT_SIZE_OPTIONS, 'xl')).toBe(false)
  })
})
