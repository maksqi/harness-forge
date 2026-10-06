import type { Settings } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { TOOL_MODE_OPTIONS as PERMISSION_MENU_OPTIONS } from '~/components/chat/composer/permission'
import { useAuthStore } from '~/stores/auth'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { authStatus, customizationList, styleEntry } from '~/utils/testing/fixtures'
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

const saved: Settings = { ...DEFAULT_SETTINGS, displayName: 'Maks', maxSteps: 20, projectMaxSteps: 100 }

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

async function settle(rounds = 3) {
  for (let round = 0; round < rounds; round++) {
    await flushPromises()
    await nextTick()
  }
}

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
    expect((wrapper.get(`[data-testid="${testIds.settingsProjectMaxSteps}"]`).element as HTMLInputElement).value).toBe('100')
    expect(wrapper.text()).toContain('Max steps in project chats')
    expect(wrapper.text()).toContain('Agent runs in project chats can take more steps (1–200).')
    expect(wrapper.get(`[data-testid="${testIds.settingsDefaultMode}"]`).text()).toBe('Ask')
    expect(wrapper.get(`[data-testid="${testIds.settingsDefaultEffort}"]`).text()).toBe('Auto')
    expect(wrapper.get(`[data-testid="${testIds.settingsAltShortcuts}"]`).attributes('aria-checked')).toBe('true')
    // The switch also governs Alt+V (dictation) and Alt+C (the changes panel, Phase 8; docs/UI.md 9.4, 12).
    expect(wrapper.text()).toContain('Use Alt+M, Alt+R and Alt+P for composer menus, Alt+V to dictate and Alt+C for changes.')
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

  it('rejects an invalid max steps value and saves a valid one (1 to 200)', async () => {
    const wrapper = await mountGeneral()
    const input = wrapper.get(`[data-testid="${testIds.settingsMaxSteps}"]`)

    for (const value of ['0', '201', 'ten', '2.5']) {
      await input.trigger('focus')
      await input.setValue(value)
      await input.trigger('blur')
      await flushPromises()
      expect(wrapper.text()).toContain('Enter a whole number from 1 to 200.')
      expect(input.attributes('aria-invalid')).toBe('true')
    }
    expect(api.settings.update).not.toHaveBeenCalled()

    await input.trigger('focus')
    await input.setValue(' 150 ')
    await input.trigger('keydown', { key: 'Enter' })
    await input.trigger('blur')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { maxSteps: 150 } })
    expect(wrapper.text()).not.toContain('Enter a whole number from 1 to 200.')
  })

  it('saves the max steps of project chats (1 to 200) and keeps the saved value on an error', async () => {
    const wrapper = await mountGeneral()
    const input = wrapper.get(`[data-testid="${testIds.settingsProjectMaxSteps}"]`)
    const other = wrapper.get(`[data-testid="${testIds.settingsMaxSteps}"]`)

    for (const value of ['0', '201', '', 'many']) {
      await input.trigger('focus')
      await input.setValue(value)
      await input.trigger('blur')
      await flushPromises()
      expect(wrapper.text()).toContain('Enter a whole number from 1 to 200.')
      expect(input.attributes('aria-invalid')).toBe('true')
      // The error belongs to this field only.
      expect(other.attributes('aria-invalid')).toBeUndefined()
    }
    expect(api.settings.update).not.toHaveBeenCalled()
    expect(useSettingsStore().resolved.projectMaxSteps).toBe(100)

    // Esc restores the saved value and clears the error.
    await input.trigger('focus')
    await input.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect((input.element as HTMLInputElement).value).toBe('100')
    expect(input.attributes('aria-invalid')).toBeUndefined()

    // An unchanged value saves nothing.
    await input.trigger('focus')
    await input.setValue('100')
    await input.trigger('blur')
    await flushPromises()
    expect(api.settings.update).not.toHaveBeenCalled()

    await input.trigger('focus')
    await input.setValue('200')
    await input.trigger('keydown', { key: 'Enter' })
    await input.trigger('blur')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledTimes(1)
    expect(api.settings.update).toHaveBeenCalledWith({ body: { projectMaxSteps: 200 } })
    expect(useSettingsStore().resolved.projectMaxSteps).toBe(200)
    expect(useSettingsStore().resolved.maxSteps).toBe(20)
    expect(wrapper.text()).not.toContain('Enter a whole number from 1 to 200.')
  })

  it('restores the project max steps when the save fails', async () => {
    api.settings.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    const wrapper = await mountGeneral()
    const input = wrapper.get(`[data-testid="${testIds.settingsProjectMaxSteps}"]`)
    await input.trigger('focus')
    await input.setValue('50')
    await input.trigger('blur')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { projectMaxSteps: 50 } })
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect((input.element as HTMLInputElement).value).toBe('100')
  })

  it('offers Accept edits as the default permission mode', async () => {
    const wrapper = await mountGeneral()
    const trigger = wrapper.get(`[data-testid="${testIds.settingsDefaultMode}"]`)
    // reka-ui's Select opens with the keyboard in happy-dom.
    await trigger.trigger('keydown', { key: 'Enter' })
    await settle()
    const items = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
    // Plan (Phase 9) is listed like Accept edits.
    expect(items.map(item => item.dataset.value)).toEqual(['ask', 'edits', 'plan', 'auto', 'off'])
    expect(items[1]!.textContent).toContain('Accept edits')
    expect(items[1]!.textContent).toContain('Edit project files without asking; ask before shell commands')

    items[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { defaultToolMode: 'edits' } })
    expect(trigger.text()).toBe('Accept edits')
  })

  it('offers Plan as the default permission mode (Phase 9)', async () => {
    const wrapper = await mountGeneral()
    const trigger = wrapper.get(`[data-testid="${testIds.settingsDefaultMode}"]`)
    await trigger.trigger('keydown', { key: 'Enter' })
    await settle()
    const plan = document.body.querySelector<HTMLElement>('[data-slot="select-item"][data-value="plan"]')!
    expect(plan.textContent).toContain('Plan')
    expect(plan.textContent).toContain('Explore and plan; change nothing until you approve the plan')
    plan.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { defaultToolMode: 'plan' } })
    expect(trigger.text()).toBe('Plan')
  })

  it('shows the Shift+Tab switch after Alt shortcuts and saves it at once (Phase 9)', async () => {
    const wrapper = await mountGeneral()
    const toggle = wrapper.get(`[data-testid="${testIds.settingsShiftTabModes}"]`)
    expect(toggle.attributes('aria-checked')).toBe('true')
    const field = toggle.element.closest('[data-slot="field"]')!
    expect(field.textContent).toContain('Shift+Tab switches the permission mode')
    expect(field.textContent).toContain('In the composer, Shift+Tab cycles Ask, Accept edits and Plan. Off: Shift+Tab moves focus.')
    expect(field.querySelector('label')!.getAttribute('for')).toBe(toggle.attributes('id'))
    // Right after the Alt shortcuts field, in the Chat section.
    const altField = wrapper.get(`[data-testid="${testIds.settingsAltShortcuts}"]`).element.closest('[data-slot="field"]')!
    expect(altField.nextElementSibling).toBe(field)

    await toggle.trigger('click')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { shiftTabModes: false } })
    expect(useSettingsStore().resolved.shiftTabModes).toBe(false)
    expect(toggle.attributes('aria-checked')).toBe('false')
  })

  it('rolls the Shift+Tab switch back with a toast when saving fails', async () => {
    api.settings.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    const wrapper = await mountGeneral()
    const toggle = wrapper.get(`[data-testid="${testIds.settingsShiftTabModes}"]`)
    await toggle.trigger('click')
    await flushPromises()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { shiftTabModes: false } })
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect(useSettingsStore().resolved.shiftTabModes).toBe(true)
    expect(toggle.attributes('aria-checked')).toBe('true')
  })

  it('shows the Agent section between Chat and Custom instructions (Phase 9)', async () => {
    const wrapper = await mountGeneral()
    const titles = wrapper.findAll('[data-slot="settings-section"] > header h2').map(title => title.text())
    const chat = titles.indexOf('Chat')
    expect(chat).toBeGreaterThanOrEqual(0)
    expect(titles.slice(chat, chat + 3)).toEqual(['Chat', 'Agent', 'Custom instructions'])
    // Its fields (docs/UI.md 9.11; AgentSettingsSection.test.ts covers them).
    for (const id of [testIds.settingsAutoCompact, testIds.settingsCompactionModel, testIds.settingsSubagentModel, testIds.settingsSubagentMaxSteps])
      expect(wrapper.find(`[data-testid="${id}"]`).exists(), id).toBe(true)
    expect((wrapper.get(`[data-testid="${testIds.settingsSubagentMaxSteps}"]`).element as HTMLInputElement).value).toBe('30')
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

  it('shows the global output style after the default effort (Phase 11)', async () => {
    const wrapper = await mountGeneral()
    const trigger = wrapper.get(`[data-testid="${testIds.settingsOutputStyle}"]`)
    expect(trigger.attributes('data-value')).toBe('default')
    expect(trigger.text()).toBe('Default')
    expect(wrapper.text()).toContain('How replies are written in chats that don\'t choose one. Projects can choose their own.')
  })

  it('offers the built-in and the active personal styles of the global catalog and saves the choice (W11.8-T8)', async () => {
    api.customizations.list.mockResolvedValue(customizationList({
      project: null,
      items: [
        styleEntry({ name: 'terse', label: 'Terse', source: 'user', path: undefined }),
        styleEntry({ name: 'off-style', label: 'Off style', source: 'user', path: undefined, state: 'off' }),
      ],
    }))
    const wrapper = await mountGeneral()
    expect(api.customizations.list).toHaveBeenCalledWith({ query: {} })
    const trigger = wrapper.get(`[data-testid="${testIds.settingsOutputStyle}"]`)
    trigger.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    const items = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
    expect(items.map(item => item.dataset.value)).toEqual(['default', 'explanatory', 'learning', 'terse'])
    items[3]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { outputStyle: 'terse' } })
    expect(wrapper.get(`[data-testid="${testIds.settingsOutputStyle}"]`).attributes('data-value')).toBe('terse')
    expect(wrapper.get(`[data-testid="${testIds.settingsOutputStyle}"]`).text()).toBe('Terse')
  })

  it('keeps a stored style that is no longer an option, marked "Not available" (W11.8-T8)', async () => {
    api.settings.get.mockResolvedValue({ ...saved, outputStyle: 'gone' })
    const wrapper = await mountGeneral()
    const trigger = wrapper.get(`[data-testid="${testIds.settingsOutputStyle}"]`)
    expect(trigger.text()).toBe('gone')
    trigger.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    const missing = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(item => item.dataset.value === 'gone')
    expect(missing?.textContent).toContain('Not available')
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
    expect(parseMaxSteps('101')).toEqual({ value: 101 })
    expect(parseMaxSteps('200')).toEqual({ value: 200 })
    expect(parseMaxSteps('201')).toEqual({ error: 'Enter a whole number from 1 to 200.' })
    expect(parseMaxSteps('0')).toHaveProperty('error')
    expect(parseMaxSteps('1e2')).toHaveProperty('error')
    expect(parseMaxSteps('')).toHaveProperty('error')
    expect(parseMaxSteps('-3')).toHaveProperty('error')
  })

  it('labels the choices', () => {
    expect(sendKeyOptions(true).map(option => option.label)).toEqual(['Enter', '⌘ Enter'])
    expect(sendKeyOptions(false).map(option => option.label)).toEqual(['Enter', 'Ctrl Enter'])
    // The options of the composer's permission menu, Accept edits and Plan included (docs/UI.md 7.11, 9.4).
    expect(TOOL_MODE_OPTIONS.map(option => [option.value, option.label])).toEqual([
      ['ask', 'Ask'],
      ['edits', 'Accept edits'],
      ['plan', 'Plan'],
      ['auto', 'Auto'],
      ['off', 'Off'],
    ])
    expect(TOOL_MODE_OPTIONS.map(option => option.description)).toEqual(PERMISSION_MENU_OPTIONS.map(option => option.description))
    expect(EFFORT_OPTIONS.map(option => option.value)).toEqual(['auto', 'off', 'low', 'medium', 'high', 'max'])
  })
})
