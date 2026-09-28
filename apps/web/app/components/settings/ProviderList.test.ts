import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { pluginSummary, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import InsecureBanner from './InsecureBanner.vue'
import ProviderList from './ProviderList.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const apiKeyField = { key: 'apiKey', label: 'API key', type: 'secret' as const, required: true }

const anthropic = providerSummary({ modelCount: 23, credentialFields: [apiKeyField] })
const openai = providerSummary({
  id: 'openai',
  name: 'OpenAI (ChatGPT)',
  status: 'not_configured',
  modelCount: 0,
  credentialFields: [apiKeyField],
})
const moonshot = providerSummary({
  id: 'moonshotai',
  name: 'Moonshot AI (Kimi)',
  status: 'error',
  lastError: { code: 'auth_invalid', message: 'Invalid Authentication', status: 401 },
})
const together = providerSummary({ id: 'together-ai', name: 'Together AI', pluginId: 'together-ai', modelCount: 12 })

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  toasts.error.mockReset()
  api.plugins.list.mockResolvedValue({ items: [pluginSummary({ id: 'together-ai', name: 'Together AI plugin' })] })
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function mountList(configureId: string | null = null) {
  const current = ref<string | null>(configureId)
  const updates: Array<string | null> = []
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(ProviderList, {
        'configureId': current.value,
        'onUpdate:configureId': (value: string | null) => {
          updates.push(value)
          current.value = value
        },
      }),
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  return { wrapper, updates }
}

function rows() {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.providerRow}"]`)]
}

describe('providerList', () => {
  it('lists providers with their subtitle and status', async () => {
    api.providers.list.mockResolvedValue({ items: [together, moonshot, openai, anthropic] })
    mountList()
    await flushPromises()

    expect(rows().map(row => row.dataset.providerId)).toEqual(['anthropic', 'openai', 'moonshotai', 'together-ai'])
    const [first, second, third, fourth] = rows()
    expect(first!.textContent).toContain('23 models')
    expect(first!.querySelector(`[data-testid="${testIds.providerStatus}"]`)?.getAttribute('data-status')).toBe('connected')
    expect(second!.querySelector(`[data-testid="${testIds.providerConfigure}"]`)?.textContent?.trim()).toBe('Add key')
    expect(third!.querySelector(`[data-testid="${testIds.providerStatus}"]`)?.textContent).toContain('Error 401')
    expect(fourth!.textContent).toContain('12 models · via Together AI plugin')
  })

  it('opens the key dialog from the Configure button', async () => {
    api.providers.list.mockResolvedValue({ items: [anthropic, openai] })
    mountList()
    await flushPromises()

    rows()[1]!.querySelector<HTMLButtonElement>(`[data-testid="${testIds.providerConfigure}"]`)!.click()
    await flushPromises()
    expect(document.body.querySelector(`[data-testid="${testIds.keyDialog}"]`)?.getAttribute('data-provider-id')).toBe('openai')
  })

  it('opens ?configure=<id> once loaded and clears it when the dialog closes', async () => {
    api.providers.list.mockResolvedValue({ items: [anthropic, openai] })
    const { updates } = mountList('openai')
    await flushPromises()

    const dialog = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.keyDialog}"]`)
    expect(dialog?.dataset.providerId).toBe('openai')
    expect(updates).toEqual([])

    document.body.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click()
    await flushPromises()
    expect(updates).toEqual([null])
    expect(document.body.querySelector(`[data-testid="${testIds.keyDialog}"]`)).toBeNull()
  })

  it('reports an unknown ?configure= provider', async () => {
    api.providers.list.mockResolvedValue({ items: [anthropic] })
    const { updates } = mountList('nope')
    await flushPromises()

    expect(document.body.querySelector(`[data-testid="${testIds.keyDialog}"]`)).toBeNull()
    expect(toasts.error).toHaveBeenCalledWith('Provider not found', { description: 'No provider has the id "nope".' })
    expect(updates).toEqual([null])
  })

  it('switches a provider off and rolls back with a toast on failure', async () => {
    api.providers.list.mockResolvedValue({ items: [anthropic] })
    api.providers.update.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Database is locked.' }))
    mountList()
    await flushPromises()

    const toggle = rows()[0]!.querySelector<HTMLButtonElement>(`[data-testid="${testIds.providerEnabled}"]`)!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    toggle.click()
    await flushPromises()

    expect(api.providers.update).toHaveBeenCalledWith({ params: { id: 'anthropic' }, body: { enabled: false } })
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Database is locked.' })
    expect(rows()[0]!.querySelector(`[data-testid="${testIds.providerEnabled}"]`)?.getAttribute('aria-checked')).toBe('true')
  })

  it('shows a load failure with Retry', async () => {
    api.providers.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Server unavailable.' }))
    mountList()
    await flushPromises()

    const alert = document.body.querySelector<HTMLElement>('[data-slot="settings-load-error"]')!
    expect(alert.textContent).toContain('Could not load providers')
    api.providers.list.mockResolvedValue({ items: [anthropic] })
    alert.querySelector('button')!.click()
    await flushPromises()
    expect(rows()).toHaveLength(1)
    expect(document.body.querySelector('[data-slot="settings-load-error"]')).toBeNull()
  })
})

describe('insecureBanner', () => {
  it('warns over plain HTTP from a network host only', () => {
    const network = mount(InsecureBanner, { props: { location: { protocol: 'http:', hostname: '192.168.1.20' } } })
    expect(network.get(`[data-testid="${testIds.insecureBanner}"]`).text())
      .toBe('You\'re using plain HTTP. Keys you enter can be read on the network. Use HTTPS or localhost.')
    const local = mount(InsecureBanner, { props: { location: { protocol: 'http:', hostname: '127.0.0.1' } } })
    expect(local.find(`[data-testid="${testIds.insecureBanner}"]`).exists()).toBe(false)
  })
})
