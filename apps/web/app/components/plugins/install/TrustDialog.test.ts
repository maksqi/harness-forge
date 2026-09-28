import type { PluginDetail } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuthStore } from '~/stores/auth'
import { testIds } from '~/utils/testids'
import { authStatus, pluginDetail } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import TrustDialog from './TrustDialog.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const OLD = 'a'.repeat(64)
const CURRENT = 'd'.repeat(64)
const NEWER = 'e'.repeat(64)

function untrusted(overrides: Partial<PluginDetail> = {}): PluginDetail {
  return pluginDetail({
    id: 'dice-roller',
    name: 'Dice roller',
    state: 'untrusted',
    source: 'npm',
    sourceRef: 'dice-roller@1.1.0',
    trust: { required: true, trusted: false, hash: CURRENT, trustedHash: OLD },
    ...overrides,
  })
}

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  toasts.success.mockReset()
  const auth = useAuthStore()
  auth.status = authStatus()
  auth.loaded = true
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function mountDialog() {
  const open = ref(true)
  const trusted = vi.fn()
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(TrustDialog, {
        'open': open.value,
        'pluginId': 'dice-roller',
        'onUpdate:open': (value: boolean) => {
          open.value = value
        },
        'onTrusted': trusted,
      }),
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  return { wrapper, open, trusted }
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  element!.click()
  await flushPromises()
}

async function type(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

function confirmDisabled(): boolean {
  return byTestId<HTMLButtonElement>(testIds.trustConfirm)!.disabled
}

describe('trustDialog', () => {
  it('loads the plugin, requires "I trust" and pins the current hash', async () => {
    api.plugins.get.mockResolvedValue(untrusted())
    api.pluginInstall.trust.mockResolvedValue(untrusted({ state: 'active', trust: { required: true, trusted: true, hash: CURRENT, trustedHash: CURRENT } }))
    const { open, trusted } = await mountDialog()

    expect(api.plugins.get).toHaveBeenCalledWith({ params: { id: 'dice-roller' } })
    const dialog = byTestId(testIds.trustDialog)!
    expect(dialog.dataset.pluginId).toBe('dice-roller')
    expect(dialog.textContent).toContain('Trust Dice roller?')
    expect(byTestId(testIds.trustWarning)!.textContent).toContain(CURRENT)
    expect(dialog.textContent).toContain('I trust dice-roller@1.1.0')
    expect(confirmDisabled()).toBe(true)

    await click(byTestId(testIds.trustCheckbox))
    expect(confirmDisabled()).toBe(false)
    await click(byTestId(testIds.trustConfirm))
    expect(api.pluginInstall.trust).toHaveBeenCalledWith({ params: { id: 'dice-roller' }, body: { sha256: CURRENT } })
    expect(toasts.success).toHaveBeenCalledWith('Trusted Dice roller')
    expect(trusted).toHaveBeenCalledWith('dice-roller')
    expect(open.value).toBe(false)
  })

  it('asks for the password when the session is not fresh', async () => {
    useAuthStore().status = authStatus({ enabled: true, source: 'settings', freshUntil: null })
    api.plugins.get.mockResolvedValue(untrusted())
    api.auth.login.mockRejectedValueOnce(new HarnessError({ code: 'rate_limited', message: 'Too many attempts.', retryAfterMs: 4000 }))
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    api.pluginInstall.trust.mockResolvedValue(untrusted({ state: 'active' }))
    const { trusted } = await mountDialog()
    await click(byTestId(testIds.trustCheckbox))
    expect(confirmDisabled()).toBe(true)

    await type(byTestId<HTMLInputElement>(testIds.trustPassword), 'pw')
    await click(byTestId(testIds.trustConfirm))
    expect(document.body.textContent).toContain('Too many attempts. Try again in 4 s.')
    expect(api.pluginInstall.trust).not.toHaveBeenCalled()

    await type(byTestId<HTMLInputElement>(testIds.trustPassword), 'pw2')
    await click(byTestId(testIds.trustConfirm))
    expect(api.auth.login).toHaveBeenLastCalledWith({ body: { password: 'pw2' } })
    expect(trusted).toHaveBeenCalledWith('dice-roller')
  })

  it('falls back to ConfirmPasswordDialog on a fresh-auth refusal and retries once', async () => {
    api.plugins.get.mockResolvedValue(untrusted())
    api.pluginInstall.trust
      .mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Confirm your password to continue.', action: 'login' }))
      .mockResolvedValueOnce(untrusted({ state: 'active' }))
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    const { trusted } = await mountDialog()
    await click(byTestId(testIds.trustCheckbox))
    await click(byTestId(testIds.trustConfirm))
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    await type(byTestId<HTMLInputElement>(testIds.confirmPasswordInput), 'secret')
    await click(byTestId(testIds.confirmPasswordSubmit))
    expect(api.pluginInstall.trust).toHaveBeenCalledTimes(2)
    expect(trusted).toHaveBeenCalledWith('dice-roller')
  })

  it('reloads the plugin when its files changed since the dialog opened', async () => {
    api.plugins.get.mockResolvedValueOnce(untrusted()).mockResolvedValueOnce(untrusted({ trust: { required: true, trusted: false, hash: NEWER, trustedHash: OLD } }))
    api.pluginInstall.trust.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'The plugin files changed since they were reviewed: inspect them again before trusting.', details: { reason: 'stale' } }))
    const { trusted, open } = await mountDialog()
    await click(byTestId(testIds.trustCheckbox))
    await click(byTestId(testIds.trustConfirm))
    expect(document.body.textContent).toContain('files changed since they were reviewed')
    expect(byTestId(testIds.trustWarning)!.textContent).toContain(NEWER)
    expect(confirmDisabled()).toBe(true)
    expect(trusted).not.toHaveBeenCalled()
    expect(open.value).toBe(true)
  })

  it('explains when there is nothing to trust', async () => {
    api.plugins.get.mockResolvedValue(untrusted({ state: 'active', trust: { required: true, trusted: true, hash: CURRENT, trustedHash: CURRENT } }))
    await mountDialog()
    expect(document.body.textContent).toContain('already trusted')
    expect(byTestId(testIds.trustCheckbox)).toBeNull()
    expect(confirmDisabled()).toBe(true)
  })
})
