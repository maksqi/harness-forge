// InstallReview (Phase 12, C46-T5; docs/UI.md 8.3, 10.9): the preview, trust and install steps extracted from
// InstallDialog. InstallDialog.test.ts covers the flow end to end; this mounts the review on its own.
import type { PluginInspection } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuthStore } from '~/stores/auth'
import { testIds } from '~/utils/testids'
import { authStatus, claudePluginInfo, pluginDetail } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import InstallReview from './InstallReview.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const HASH = 'd'.repeat(64)

function inspection(overrides: Partial<PluginInspection> = {}): PluginInspection {
  return {
    manifest: { manifestVersion: 1, id: 'review-kit', name: 'Review kit', version: '1.2.0', engines: { harness: '^1.0.0' } },
    kind: 'declarative',
    format: 'claude',
    source: 'github',
    sourceRef: 'anthropics/review-kit@0123456789ab',
    sha256: HASH,
    contributions: { providers: [], models: 0, tools: [], mcpServers: ['review-kit'], commands: ['review-kit:review'], hooks: [], agents: [], skills: [], commandHooks: 1, outputStyles: [] },
    networkHosts: [],
    secretsRequested: [],
    permissions: [],
    requiresTrust: true,
    compatible: true,
    existing: null,
    files: { count: 4, bytes: 2048 },
    warnings: [],
    claude: claudePluginInfo(),
    ...overrides,
  }
}

let api: MockApi
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.status = authStatus()
  auth.loaded = true
})

afterEach(() => {
  document.body.replaceChildren()
  disposePinia(pinia)
})

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

async function type(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

/** A keydown Enter on `element`; returns the event (its `defaultPrevented`). */
function pressEnter(element: HTMLElement, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
  element.dispatchEvent(event)
  return event
}

async function mountReview(current = ref(inspection())) {
  const events = { back: vi.fn(), installed: vi.fn(), stale: vi.fn() }
  const wrapper = mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(InstallReview, {
        inspection: current.value,
        request: { kind: 'json', source: { source: 'github', repo: 'anthropics/review-kit' } },
        sourceLabel: 'anthropics/review-kit@0123456789ab',
        onBack: events.back,
        onInstalled: events.installed,
        onStale: events.stale,
      }),
    }),
  }), { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  return { wrapper, events, current }
}

describe('installReview', () => {
  it('renders the review root with the preview, the consent and the install footer', async () => {
    const { events } = await mountReview()
    expect(document.body.querySelector('[data-slot="install-review"]')).not.toBeNull()
    expect(byTestId(testIds.installPreview)?.dataset.pluginId).toBe('review-kit')
    expect(byTestId(testIds.trustWarning)).not.toBeNull()
    expect(document.body.textContent).toContain('I trust anthropics/review-kit@0123456789ab')
    expect(byTestId<HTMLButtonElement>(testIds.installSubmit)!.disabled).toBe(true)
    byTestId(testIds.installBack)!.click()
    expect(events.back).toHaveBeenCalledTimes(1)
  })

  it('installs the reviewed hash with trust and emits the plugin', async () => {
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'Review kit' }))
    const { events } = await mountReview()
    byTestId(testIds.trustCheckbox)!.click()
    await flushPromises()
    byTestId(testIds.installSubmit)!.click()
    await flushPromises()
    expect(api.pluginInstall.install).toHaveBeenCalledWith({ body: { source: 'github', repo: 'anthropics/review-kit', sha256: HASH, trust: true } })
    expect(events.installed).toHaveBeenCalledWith(expect.objectContaining({ id: 'review-kit' }))
  })

  it('emits stale on a 409 stale answer and shows the notice once the parent passes the new inspection', async () => {
    api.pluginInstall.install.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'The plugin changed since you reviewed it.', details: { reason: 'stale' } }))
    const { events, current } = await mountReview()
    byTestId(testIds.trustCheckbox)!.click()
    await flushPromises()
    byTestId(testIds.installSubmit)!.click()
    await flushPromises()
    expect(events.stale).toHaveBeenCalledTimes(1)
    expect(byTestId(testIds.installError)?.dataset.code).toBe('conflict')
    current.value = inspection({ manifest: { manifestVersion: 1, id: 'review-kit', name: 'Review kit', version: '1.3.0', engines: { harness: '^1.0.0' } } })
    await nextTick()
    await flushPromises()
    expect(byTestId(testIds.installError)).toBeNull()
    expect(byTestId(testIds.installStale)).not.toBeNull()
    expect(byTestId(testIds.trustCheckbox)!.getAttribute('aria-checked')).toBe('false')
  })

  it('opens on the trust checkbox, and Install is never the default button (W12.9)', async () => {
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'Review kit' }))
    const { events } = await mountReview()
    await flushPromises()
    expect(document.activeElement).toBe(byTestId(testIds.trustCheckbox))
    byTestId(testIds.trustCheckbox)!.click()
    await flushPromises()
    // Enter in the form (implicit submission) and Enter on the focused Install do nothing.
    document.body.querySelector('[data-slot="install-review"] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    const submit = byTestId<HTMLButtonElement>(testIds.installSubmit)!
    expect(submit.type).toBe('button')
    expect(pressEnter(submit).defaultPrevented).toBe(true)
    await flushPromises()
    expect(api.pluginInstall.install).not.toHaveBeenCalled()
    // A click installs.
    submit.click()
    await flushPromises()
    expect(api.pluginInstall.install).toHaveBeenCalledTimes(1)
    expect(events.installed).toHaveBeenCalledTimes(1)
  })

  it('installs on Enter in the inline password field only, like a click on Install (W12.17)', async () => {
    useAuthStore().status = authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() - 1000 })
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'Review kit' }))
    const { events } = await mountReview()
    const field = byTestId<HTMLInputElement>(testIds.trustPassword)!
    // Install is disabled until the consent is given: Enter in the field does nothing yet.
    await type(field, 'secret')
    expect(pressEnter(field).defaultPrevented).toBe(false)
    await flushPromises()
    expect(api.auth.login).not.toHaveBeenCalled()
    byTestId(testIds.trustCheckbox)!.click()
    await flushPromises()
    // Enter on the review, on the checkbox, on Install or while an IME composes does nothing.
    document.body.querySelector('[data-slot="install-review"] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(pressEnter(byTestId(testIds.trustCheckbox)!).defaultPrevented).toBe(true)
    expect(pressEnter(byTestId(testIds.installSubmit)!).defaultPrevented).toBe(true)
    pressEnter(field, { isComposing: true })
    await flushPromises()
    expect(api.auth.login).not.toHaveBeenCalled()
    expect(api.pluginInstall.install).not.toHaveBeenCalled()
    // Enter in the password field: the login, then the install of the reviewed hash.
    pressEnter(field)
    await flushPromises()
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'secret' } })
    expect(api.pluginInstall.install).toHaveBeenCalledTimes(1)
    expect(api.pluginInstall.install).toHaveBeenCalledWith({ body: { source: 'github', repo: 'anthropics/review-kit', sha256: HASH, trust: true } })
    expect(events.installed).toHaveBeenCalledTimes(1)
  })

  it('puts the focus back in the password field after a wrong password; Enter there goes on with the install (W12.17)', async () => {
    useAuthStore().status = authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() - 1000 })
    api.auth.login.mockRejectedValueOnce(new HarnessError({ code: 'unauthorized', message: 'Invalid password' }))
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    api.pluginInstall.install.mockResolvedValue(pluginDetail({ id: 'review-kit', name: 'Review kit' }))
    const { events } = await mountReview()
    byTestId(testIds.trustCheckbox)!.click()
    await flushPromises()
    await type(byTestId<HTMLInputElement>(testIds.trustPassword), 'wrong')
    byTestId(testIds.installSubmit)!.click()
    await flushPromises()
    expect(document.body.textContent).toContain('Wrong password')
    expect(api.pluginInstall.install).not.toHaveBeenCalled()
    const field = byTestId<HTMLInputElement>(testIds.trustPassword)!
    expect(field.disabled).toBe(false)
    expect(document.activeElement).toBe(field)
    await type(field, 'right')
    pressEnter(field)
    await flushPromises()
    expect(api.auth.login).toHaveBeenLastCalledWith({ body: { password: 'right' } })
    expect(api.pluginInstall.install).toHaveBeenCalledTimes(1)
    expect(events.installed).toHaveBeenCalledTimes(1)
  })

  it('continues the clicked install when the password prompt is confirmed (W12.17)', async () => {
    api.pluginInstall.install
      .mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Confirm your password to continue.', action: 'login' }))
      .mockResolvedValueOnce(pluginDetail({ id: 'review-kit', name: 'Review kit' }))
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    const { events } = await mountReview()
    byTestId(testIds.trustCheckbox)!.click()
    await flushPromises()
    byTestId(testIds.installSubmit)!.click()
    await flushPromises()
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    await type(byTestId<HTMLInputElement>(testIds.confirmPasswordInput), 'secret')
    // Enter in the prompt's field submits its form (implicit submission; the DOM under test does not synthesize it).
    byTestId(testIds.confirmPasswordDialog)!.querySelector('form')!.requestSubmit()
    await flushPromises()
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'secret' } })
    expect(api.pluginInstall.install).toHaveBeenCalledTimes(2)
    expect(events.installed).toHaveBeenCalledTimes(1)
  })

  it('opens on Install when the plugin needs no trust', async () => {
    await mountReview(ref(inspection({ requiresTrust: false, claude: claudePluginInfo({ executables: [] }) })))
    await flushPromises()
    expect(byTestId(testIds.trustCheckbox)).toBeNull()
    expect(document.activeElement).toBe(byTestId(testIds.installSubmit))
  })
})
