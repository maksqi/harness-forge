import type { CredentialField, ProviderSummary } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useProvidersStore } from '~/stores/providers'
import { testIds } from '~/utils/testids'
import { providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ProviderKeyDialog from './ProviderKeyDialog.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const SECRET = 'sk-ant-api03-very-secret-value-1234'

const apiKey: CredentialField = { key: 'apiKey', label: 'API key', type: 'secret', required: true, envVar: 'ANTHROPIC_API_KEY' }
const baseURL: CredentialField = { key: 'baseURL', label: 'Base URL', type: 'url', default: 'https://api.anthropic.com/v1', advanced: true }

function anthropic(overrides: Partial<ProviderSummary> = {}): ProviderSummary {
  return providerSummary({
    status: 'not_configured',
    credentialFields: [apiKey, baseURL],
    credentials: {
      apiKey: { set: false, hint: null, source: null },
      baseURL: { set: false, hint: null, source: null },
    },
    keyUrl: 'https://platform.claude.com/settings/keys',
    ...overrides,
  })
}

const stored = {
  apiKey: { set: true, hint: 'sk-ant-…1234', source: 'stored' as const },
  baseURL: { set: false, hint: null, source: null },
}

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  toasts.success.mockReset()
  toasts.error.mockReset()
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function mountDialog(provider: ProviderSummary) {
  const store = useProvidersStore()
  store.items = [provider]
  store.loaded = true
  const open = ref(true)
  const saved = vi.fn()
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(ProviderKeyDialog, {
        'open': open.value,
        'providerId': provider.id,
        'onUpdate:open': (value: boolean) => {
          open.value = value
        },
        'onSaved': saved,
      }),
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  return { wrapper, open, saved, store }
}

function el<T extends HTMLElement = HTMLElement>(selector: string): T | null {
  return document.body.querySelector<T>(selector)
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string, extra = ''): T | null {
  return el<T>(`[data-testid="${id}"]${extra}`)
}

async function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  element!.click()
  await flushPromises()
}

describe('providerKeyDialog', () => {
  it('shows a stored key only as its masked hint and never keeps typed keys', async () => {
    api.providers.test.mockResolvedValue({ ok: true, latencyMs: 210, modelCount: 23 })
    api.credentials.set.mockImplementation(async () => anthropic({ status: 'connected', credentials: stored }))
    const { open } = mountDialog(anthropic({ status: 'connected', credentials: stored }))
    await flushPromises()

    const dialog = byTestId(testIds.keyDialog)!
    expect(dialog.dataset.providerId).toBe('anthropic')
    const input = byTestId<HTMLInputElement>(testIds.keyInput, '[data-value="apiKey"]')!
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('sk-ant-…1234 · stored')
    expect(byTestId<HTMLAnchorElement>(testIds.keyGetLink)!.href).toBe('https://platform.claude.com/settings/keys')

    await type(input, SECRET)
    const reveal = byTestId<HTMLButtonElement>(testIds.keyReveal)!
    expect(reveal.disabled).toBe(false)
    await click(reveal)
    expect(byTestId<HTMLInputElement>(testIds.keyInput, '[data-value="apiKey"]')!.type).toBe('text')

    await click(byTestId(testIds.keySave))
    expect(api.credentials.set).toHaveBeenCalledWith({ params: { id: 'anthropic' }, body: { values: { apiKey: SECRET } } })
    expect(open.value).toBe(false)
    await flushPromises()
    expect(document.body.innerHTML).not.toContain(SECRET)

    open.value = true
    await flushPromises()
    const reopened = byTestId<HTMLInputElement>(testIds.keyInput, '[data-value="apiKey"]')!
    expect(reopened.value).toBe('')
    expect(reopened.type).toBe('password')
    expect(document.body.innerHTML).not.toContain(SECRET)
  })

  it('runs Test before Save and saves only after it passes', async () => {
    const calls: string[] = []
    api.providers.test.mockImplementation(async () => {
      calls.push('test')
      return { ok: true, latencyMs: 380, modelCount: 23 }
    })
    api.credentials.set.mockImplementation(async () => {
      calls.push('save')
      return anthropic({ status: 'connected', credentials: stored })
    })
    const { open, saved } = mountDialog(anthropic())
    await flushPromises()

    const save = byTestId<HTMLButtonElement>(testIds.keySave)!
    expect(save.disabled).toBe(true)
    await type(byTestId<HTMLInputElement>(testIds.keyInput, '[data-value="apiKey"]')!, ' sk-new ')
    expect(save.disabled).toBe(false)
    await click(save)

    expect(calls).toEqual(['test', 'save'])
    expect(api.providers.test).toHaveBeenCalledWith({ params: { id: 'anthropic' }, body: { values: { apiKey: 'sk-new' } } })
    expect(api.credentials.set).toHaveBeenCalledWith({ params: { id: 'anthropic' }, body: { values: { apiKey: 'sk-new' } } })
    expect(toasts.success).toHaveBeenCalledWith('Anthropic (Claude) connected')
    expect(saved).toHaveBeenCalledWith('anthropic')
    expect(open.value).toBe(false)
  })

  it('keeps the dialog open on a failed test and offers "Save anyway"', async () => {
    api.providers.test.mockResolvedValue({
      ok: false,
      latencyMs: 120,
      error: { code: 'auth_invalid', message: 'invalid x-api-key', status: 401, action: 'configure-provider' },
    })
    api.credentials.set.mockResolvedValue(anthropic({ status: 'connected', credentials: stored }))
    const { open, saved } = mountDialog(anthropic())
    await flushPromises()

    await type(byTestId<HTMLInputElement>(testIds.keyInput, '[data-value="apiKey"]')!, 'sk-wrong')
    await click(byTestId(testIds.keySave))

    expect(api.credentials.set).not.toHaveBeenCalled()
    expect(open.value).toBe(true)
    const result = byTestId(testIds.keyTestResult)!
    expect(result.dataset.status).toBe('error')
    expect(result.textContent).toContain('Anthropic (Claude) rejected the API key')
    expect(result.textContent).toContain('invalid x-api-key')

    await click(byTestId(testIds.keySaveAnyway))
    expect(api.credentials.set).toHaveBeenCalledWith({ params: { id: 'anthropic' }, body: { values: { apiKey: 'sk-wrong' } } })
    expect(toasts.success).toHaveBeenCalledWith('Anthropic (Claude) saved')
    expect(saved).toHaveBeenCalledWith('anthropic')
    expect(open.value).toBe(false)
  })

  it('tests the stored credentials when nothing was typed and reuses a passing test on Save', async () => {
    api.providers.test.mockResolvedValue({ ok: true, latencyMs: 379.6, modelCount: 23 })
    api.credentials.set.mockResolvedValue(anthropic({ status: 'connected', credentials: stored }))
    mountDialog(anthropic({ status: 'connected', credentials: stored }))
    await flushPromises()

    await click(byTestId(testIds.keyTest))
    expect(api.providers.test).toHaveBeenLastCalledWith({ params: { id: 'anthropic' }, body: {} })
    const result = byTestId(testIds.keyTestResult)!
    expect(result.dataset.status).toBe('ok')
    expect(result.textContent).toContain('Connected · 23 models · 380 ms')

    await type(byTestId<HTMLInputElement>(testIds.keyInput, '[data-value="apiKey"]')!, 'sk-next')
    await click(byTestId(testIds.keyTest))
    expect(api.providers.test).toHaveBeenLastCalledWith({ params: { id: 'anthropic' }, body: { values: { apiKey: 'sk-next' } } })
    await click(byTestId(testIds.keySave))
    expect(api.providers.test).toHaveBeenCalledTimes(2)
    expect(api.credentials.set).toHaveBeenCalledTimes(1)
  })

  it('explains a key that comes from the server environment', async () => {
    mountDialog(anthropic({
      status: 'env',
      credentials: {
        apiKey: { set: true, hint: 'sk-…abcd', source: 'env' },
        baseURL: { set: false, hint: null, source: null },
      },
    }))
    await flushPromises()

    expect(byTestId(testIds.keyEnvBadge)?.textContent).toContain('From env')
    expect(byTestId(testIds.keyDialog)!.textContent)
      .toContain('Using ANTHROPIC_API_KEY from the server environment. A key saved here takes priority.')
    expect(byTestId<HTMLInputElement>(testIds.keyInput, '[data-value="apiKey"]')!.placeholder).toBe('sk-…abcd · from env')
    expect(byTestId(testIds.keyRemove)).toBeNull()
  })

  it('removes a stored key after confirmation', async () => {
    api.credentials.clear.mockResolvedValue(anthropic())
    mountDialog(anthropic({ status: 'connected', credentials: stored }))
    await flushPromises()

    await click(byTestId(testIds.keyRemove))
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('[data-slot="confirm-dialog"] button')]
      .find(button => button.textContent?.trim() === 'Remove')
    await click(confirm ?? null)

    expect(api.credentials.clear).toHaveBeenCalledWith({ params: { id: 'anthropic' } })
    expect(toasts.success).toHaveBeenCalledWith('Anthropic (Claude) key removed')
    expect(byTestId<HTMLInputElement>(testIds.keyInput, '[data-value="apiKey"]')!.placeholder).toBe('Paste your key…')
    expect(byTestId(testIds.keyRemove)).toBeNull()
  })

  it('validates and resets an overridden base URL in "Advanced"', async () => {
    api.providers.test.mockResolvedValue({ ok: true, latencyMs: 90 })
    api.credentials.set.mockResolvedValue(anthropic({ status: 'connected' }))
    mountDialog(anthropic({
      status: 'connected',
      credentials: {
        apiKey: stored.apiKey,
        baseURL: { set: true, hint: null, source: 'stored', value: 'https://proxy.example.com/v1' },
      },
    }))
    await flushPromises()

    // An override opens "Advanced" right away.
    expect(byTestId(testIds.keyAdvanced)!.getAttribute('data-state')).toBe('open')
    const input = byTestId<HTMLInputElement>(testIds.keyBaseUrl)!
    expect(input.value).toBe('https://proxy.example.com/v1')
    expect(input.placeholder).toBe('https://api.anthropic.com/v1')

    await type(input, 'ftp://proxy.example.com')
    expect(byTestId(testIds.keyDialog)!.textContent).toContain('Enter a URL that starts with http:// or https://.')
    expect(byTestId<HTMLButtonElement>(testIds.keySave)!.disabled).toBe(true)
    expect(byTestId<HTMLButtonElement>(testIds.keyTest)!.disabled).toBe(true)

    const reset = [...document.body.querySelectorAll<HTMLButtonElement>('[data-field="baseURL"] button')]
      .find(button => button.textContent?.trim() === 'Reset')
    await click(reset ?? null)
    expect(byTestId<HTMLInputElement>(testIds.keyBaseUrl)!.value).toBe('')
    await click(byTestId(testIds.keySave))
    expect(api.credentials.set).toHaveBeenCalledWith({ params: { id: 'anthropic' }, body: { values: { baseURL: '' } } })
  })

  it('keeps "Advanced" closed without overrides and shows keyless fields up front', async () => {
    const ollama = providerSummary({
      id: 'ollama',
      name: 'Ollama (local)',
      local: true,
      keyUrl: 'https://ollama.com/download',
      credentialFields: [
        { key: 'baseURL', label: 'Base URL', type: 'url', required: true, default: 'http://localhost:11434/v1' },
        { key: 'apiKey', label: 'API key', type: 'secret', advanced: true },
      ],
      credentials: {
        baseURL: { set: true, hint: null, source: null },
        apiKey: { set: false, hint: null, source: null },
      },
    })
    mountDialog(ollama)
    await flushPromises()

    expect(byTestId<HTMLInputElement>(testIds.keyBaseUrl)!.placeholder).toBe('http://localhost:11434/v1')
    expect(byTestId(testIds.keyAdvanced)!.getAttribute('data-state')).toBe('closed')
    expect(byTestId(testIds.keyInput, '[data-value="apiKey"]')).toBeNull()
    expect(byTestId(testIds.keyGetLink)).toBeNull()
  })
})
