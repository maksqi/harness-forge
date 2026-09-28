import type { PluginSettingsView, SettingsSchema } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { byTestId, mountInShell, settle } from '~/components/plugins/list/testing'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import PluginConfigurationTab from './PluginConfigurationTab.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

const schema: SettingsSchema = {
  type: 'object',
  required: ['token'],
  properties: {
    token: { type: 'string', format: 'secret', title: 'API token' },
    region: { type: 'string', title: 'Region', enum: ['eu', 'us'], default: 'eu' },
    limit: { type: 'integer', title: 'Limit', minimum: 1, maximum: 50 },
  },
}

const STORED_SECRET = 'sk-live-THE-REAL-SECRET-1234'

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null
let view: PluginSettingsView

function field(key: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-testid="${testIds.schemaField}"][data-value="${key}"]`)!
}

async function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

function button(text: string, root: ParentNode = document.body): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find(item => item.textContent?.trim() === text)
  expect(found, text).toBeDefined()
  return found as HTMLButtonElement
}

async function mountTab() {
  wrapper = mountInShell(PluginConfigurationTab, { pluginId: 'dice-roller' })
  await settle(5)
  return wrapper
}

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.toast.success.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  view = { schema, values: { region: 'eu', limit: 10 }, secrets: { token: { set: true, hint: 'sk-…1234', source: 'stored' } } }
  api.plugins.getSettings.mockImplementation(async () => structuredClone(view))
  api.plugins.updateSettings.mockImplementation(async ({ body }: { body: { values: Record<string, unknown> } }) => {
    for (const [key, value] of Object.entries(body.values)) {
      if (key === 'token')
        view.secrets.token = { set: value !== '', hint: value ? `${String(value).slice(0, 3)}…${String(value).slice(-4)}` : null, source: value ? 'stored' : null }
      else if (value === null)
        delete view.values[key]
      else
        view.values[key] = value
    }
    return structuredClone(view)
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

describe('pluginConfigurationTab', () => {
  it('renders the settings form with the stored values and only the hint of the stored secret', async () => {
    await mountTab()
    expect(api.plugins.getSettings).toHaveBeenCalledWith({ params: { id: 'dice-roller' } })
    expect(byTestId(testIds.schemaForm)).not.toBeNull()
    expect(field('limit').querySelector('input')!.value).toBe('10')
    expect(field('token').textContent).toContain('sk-…1234')
    expect(document.body.innerHTML).not.toContain(STORED_SECRET)
    expect(byTestId<HTMLButtonElement>(testIds.schemaFormSave)!.disabled).toBe(true)
  })

  it('saves only what changed, then starts from the saved values', async () => {
    await mountTab()
    await type(field('limit').querySelector('input')!, '25')
    button('Replace', field('token')).click()
    await settle()
    await type(field('token').querySelector('input')!, 'sk-new-9999')
    byTestId<HTMLButtonElement>(testIds.schemaFormSave)!.click()
    await settle(5)
    expect(api.plugins.updateSettings).toHaveBeenCalledWith({ params: { id: 'dice-roller' }, body: { values: { token: 'sk-new-9999', limit: 25 } } })
    expect(mocks.toast.success).toHaveBeenCalledWith('Settings saved')
    expect(field('token').textContent).toContain('sk-…9999')
    expect(field('token').querySelector('input')).toBeNull()
    expect(field('limit').querySelector('input')!.value).toBe('25')
    expect(byTestId<HTMLButtonElement>(testIds.schemaFormSave)!.disabled).toBe(true)
  })

  it('removes a cleared optional value with null', async () => {
    await mountTab()
    await type(field('limit').querySelector('input')!, '')
    byTestId<HTMLButtonElement>(testIds.schemaFormSave)!.click()
    await settle(5)
    expect(api.plugins.updateSettings).toHaveBeenCalledWith({ params: { id: 'dice-roller' }, body: { values: { limit: null } } })
  })

  it('shows why the server refused the settings', async () => {
    await mountTab()
    api.plugins.updateSettings.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'limit: Too big' }))
    await type(field('limit').querySelector('input')!, '12')
    byTestId<HTMLButtonElement>(testIds.schemaFormSave)!.click()
    await settle(5)
    expect(document.body.textContent).toContain('Settings were not saved')
    expect(document.body.textContent).toContain('limit: Too big')
    expect(mocks.toast.success).not.toHaveBeenCalled()
  })

  it('handles plugins without settings and load failures', async () => {
    api.plugins.getSettings.mockResolvedValueOnce({ schema: null, values: {}, secrets: {} })
    await mountTab()
    expect(document.body.textContent).toContain('This plugin has no settings.')
    wrapper!.unmount()

    api.plugins.getSettings.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Settings store is locked.' }))
    await mountTab()
    expect(document.body.textContent).toContain('Could not load the settings')
    button('Retry').click()
    await settle(5)
    expect(byTestId(testIds.schemaForm)).not.toBeNull()
  })
})
