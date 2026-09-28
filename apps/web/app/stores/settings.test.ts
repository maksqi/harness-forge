import type { Settings } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_STORAGE_KEY } from '~/utils/appearance'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { useSettingsStore } from './settings'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>

let api: MockApi

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  stubLocalStorage()
  const root = document.documentElement
  delete root.dataset.density
  delete root.dataset.textSize
  delete root.dataset.readingFont
})

afterEach(() => {
  disposePinia(pinia)
  vi.unstubAllGlobals()
})

describe('settings store', () => {
  it('resolves to the defaults before loading and after a failed load', async () => {
    const store = useSettingsStore()
    expect(store.resolved).toEqual(DEFAULT_SETTINGS)
    await expect(store.fetch()).rejects.toMatchObject({ code: 'not_implemented' })
    expect(store.loaded).toBe(false)
    expect(store.resolved.maxSteps).toBe(20)
  })

  it('loads the settings and applies the appearance to <html> (cached for the next boot)', async () => {
    api.settings.get.mockResolvedValue(settings({ density: 'compact', textSize: 'lg', readingFont: 'serif', displayName: 'Maks' }))
    const store = useSettingsStore()
    await store.fetch()
    expect(store.loaded).toBe(true)
    expect(store.resolved.displayName).toBe('Maks')
    const root = document.documentElement
    expect(root.getAttribute('data-density')).toBe('compact')
    expect(root.getAttribute('data-text-size')).toBe('lg')
    expect(root.getAttribute('data-reading-font')).toBe('serif')
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!)).toEqual({ density: 'compact', textSize: 'lg', readingFont: 'serif' })
  })

  it('updates optimistically and keeps the server answer', async () => {
    api.settings.get.mockResolvedValue(settings())
    let resolveUpdate: (value: Settings) => void = () => {}
    api.settings.update.mockReturnValue(new Promise((resolve) => {
      resolveUpdate = resolve
    }))
    const store = useSettingsStore()
    await store.fetch()
    const pending = store.update({ sendKey: 'mod-enter' })
    expect(store.resolved.sendKey).toBe('mod-enter')
    expect(store.saving).toBe(true)
    resolveUpdate(settings({ sendKey: 'mod-enter' }))
    await pending
    expect(api.settings.update).toHaveBeenCalledWith({ body: { sendKey: 'mod-enter' } })
    expect(store.saving).toBe(false)
    expect(store.settings?.sendKey).toBe('mod-enter')
  })

  it('rolls back a failed update and re-applies the appearance', async () => {
    api.settings.get.mockResolvedValue(settings())
    api.settings.update.mockRejectedValue(new HarnessError({ code: 'validation_error', message: 'Bad value' }))
    const store = useSettingsStore()
    await store.fetch()
    const failed = store.update({ density: 'compact', altShortcuts: false })
    expect(document.documentElement.getAttribute('data-density')).toBe('compact')
    await expect(failed).rejects.toMatchObject({ code: 'validation_error' })
    expect(store.resolved.density).toBe('comfortable')
    expect(store.resolved.altShortcuts).toBe(true)
    expect(document.documentElement.getAttribute('data-density')).toBe('comfortable')
  })

  it('ignores an empty patch', async () => {
    const store = useSettingsStore()
    await store.update({})
    expect(api.settings.update).not.toHaveBeenCalled()
  })
})
