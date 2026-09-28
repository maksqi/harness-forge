import type { Settings } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '~/stores/auth'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { authStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { displayNameError, EFFORT_OPTIONS, instructionsError, parseMaxSteps, sendKeyOptions, TOOL_MODE_OPTIONS } from './general'
import GeneralSettings from './GeneralSettings.vue'

const mock = vi.hoisted(() => ({ api: null as unknown, navigateTo: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('./nuxt-imports', () => ({ navigateTo: mock.navigateTo }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

const saved: Settings = { ...DEFAULT_SETTINGS, displayName: 'Maks', maxSteps: 20 }

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  mock.navigateTo.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  toasts.error.mockReset()
  let current: Settings = { ...saved }
  api.settings.get.mockImplementation(async () => current)
  api.settings.update.mockImplementation(async ({ body }: { body: Partial<Settings> }) => {
    current = { ...current, ...body }
    return current
  })
  api.auth.status.mockResolvedValue(authStatus())
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function mountGeneral() {
  const wrapper = mount(GeneralSettings, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

describe('generalSettings', () => {
  it('loads the settings into the fields', async () => {
    const wrapper = await mountGeneral()
    expect(api.settings.get).toHaveBeenCalled()
    expect((wrapper.get(`[data-testid="${testIds.settingsDisplayName}"]`).element as HTMLInputElement).value).toBe('Maks')
    expect((wrapper.get(`[data-testid="${testIds.settingsMaxSteps}"]`).element as HTMLInputElement).value).toBe('20')
    expect(wrapper.get(`[data-testid="${testIds.settingsDefaultMode}"]`).text()).toBe('Ask')
    expect(wrapper.get(`[data-testid="${testIds.settingsDefaultEffort}"]`).text()).toBe('Auto')
    expect(wrapper.get(`[data-testid="${testIds.settingsAltShortcuts}"]`).attributes('aria-checked')).toBe('true')
    // The switch also governs Alt+V (dictation, docs/UI.md 12).
    expect(wrapper.text()).toContain('Use Alt+M, Alt+R and Alt+P for composer menus, and Alt+V to dictate.')
  })

  it('says so when the settings cannot be loaded, and retries', async () => {
    api.settings.get.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    const wrapper = await mountGeneral()
    const alert = wrapper.get('[data-slot="settings-load-error"]')
    expect(alert.text()).toContain('Could not load your settings')
    expect(alert.text()).toContain('The database is locked.')
    await alert.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-slot="settings-load-error"]').exists()).toBe(false)
    expect((wrapper.get(`[data-testid="${testIds.settingsDisplayName}"]`).element as HTMLInputElement).value).toBe('Maks')
  })

  it('saves the display name trimmed on blur, and only when it changed', async () => {
    const wrapper = await mountGeneral()
    const input = wrapper.get(`[data-testid="${testIds.settingsDisplayName}"]`)

    await input.trigger('focus')
    await input.setValue('  Maks  ')
    await input.trigger('blur')
    await flushPromises()
    expect(api.settings.update).not.toHaveBeenCalled()

    await input.trigger('focus')
    await input.setValue('  Ada  ')
    await input.trigger('blur')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { displayName: 'Ada' } })
    expect(useSettingsStore().resolved.displayName).toBe('Ada')
  })

  it('rejects an invalid max steps value and saves a valid one', async () => {
    const wrapper = await mountGeneral()
    const input = wrapper.get(`[data-testid="${testIds.settingsMaxSteps}"]`)

    for (const value of ['0', '101', 'ten', '2.5']) {
      await input.trigger('focus')
      await input.setValue(value)
      await input.trigger('blur')
      await flushPromises()
      expect(wrapper.text()).toContain('Enter a whole number from 1 to 100.')
      expect(input.attributes('aria-invalid')).toBe('true')
    }
    expect(api.settings.update).not.toHaveBeenCalled()

    await input.trigger('focus')
    await input.setValue(' 40 ')
    await input.trigger('keydown', { key: 'Enter' })
    await input.trigger('blur')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { maxSteps: 40 } })
    expect(wrapper.text()).not.toContain('Enter a whole number from 1 to 100.')
  })

  it('restores the saved value on Escape', async () => {
    const wrapper = await mountGeneral()
    const input = wrapper.get(`[data-testid="${testIds.settingsDisplayName}"]`)
    await input.trigger('focus')
    await input.setValue('Draft name')
    await input.trigger('keydown', { key: 'Escape' })
    await input.trigger('blur')
    await flushPromises()
    expect((input.element as HTMLInputElement).value).toBe('Maks')
    expect(api.settings.update).not.toHaveBeenCalled()
  })

  it('saves choices at once', async () => {
    const wrapper = await mountGeneral()
    await wrapper.get(`[data-testid="${testIds.settingsSendKey}"] [data-value="mod-enter"]`).trigger('click')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { sendKey: 'mod-enter' } })

    await wrapper.get(`[data-testid="${testIds.settingsAltShortcuts}"]`).trigger('click')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { altShortcuts: false } })
  })

  it('saves the instructions on blur and toasts a failure', async () => {
    api.settings.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    const wrapper = await mountGeneral()
    const textarea = wrapper.get(`[data-testid="${testIds.settingsInstructions}"]`)
    await textarea.trigger('focus')
    await textarea.setValue('Answer briefly.')
    await textarea.trigger('blur')
    await flushPromises()

    expect(api.settings.update).toHaveBeenCalledWith({ body: { instructions: 'Answer briefly.' } })
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  })

  it('offers "Set password" without a password and "Log out" with a session', async () => {
    const wrapper = await mountGeneral()
    expect(wrapper.get(`[data-testid="${testIds.passwordSet}"]`).text()).toBe('Set password')
    expect(wrapper.find(`[data-testid="${testIds.logout}"]`).exists()).toBe(false)

    useAuthStore().status = authStatus({ enabled: true, authenticated: true, source: 'settings' })
    await flushPromises()
    expect(wrapper.get(`[data-testid="${testIds.passwordSet}"]`).text()).toBe('Change password')
    api.auth.logout.mockResolvedValue(undefined)
    await wrapper.get(`[data-testid="${testIds.logout}"]`).trigger('click')
    await flushPromises()
    expect(api.auth.logout).toHaveBeenCalled()
    expect(mock.navigateTo).toHaveBeenCalledWith('/login')
  })

  it('shows HF_PASSWORD as read-only', async () => {
    const wrapper = await mountGeneral()
    useAuthStore().status = authStatus({ enabled: true, authenticated: true, source: 'env' })
    await flushPromises()
    expect(wrapper.text()).toContain('Set by HF_PASSWORD')
    expect(wrapper.find(`[data-testid="${testIds.passwordSet}"]`).exists()).toBe(false)
  })
})

describe('general rules', () => {
  it('validates the text settings against the shared schema', () => {
    expect(displayNameError('Maks')).toBeNull()
    expect(displayNameError('x'.repeat(65))).toBe('Use at most 64 characters.')
    expect(instructionsError('x'.repeat(20_000))).toBeNull()
    expect(instructionsError('x'.repeat(20_001))).toBe('Use at most 20,000 characters.')
    expect(parseMaxSteps('1')).toEqual({ value: 1 })
    expect(parseMaxSteps(' 100 ')).toEqual({ value: 100 })
    expect(parseMaxSteps('')).toHaveProperty('error')
    expect(parseMaxSteps('-3')).toHaveProperty('error')
  })

  it('labels the choices', () => {
    expect(sendKeyOptions(true).map(option => option.label)).toEqual(['Enter', '⌘ Enter'])
    expect(sendKeyOptions(false).map(option => option.label)).toEqual(['Enter', 'Ctrl Enter'])
    expect(TOOL_MODE_OPTIONS.map(option => option.value)).toEqual(['ask', 'auto', 'off'])
    expect(EFFORT_OPTIONS.map(option => option.value)).toEqual(['auto', 'off', 'low', 'medium', 'high', 'max'])
  })
})
