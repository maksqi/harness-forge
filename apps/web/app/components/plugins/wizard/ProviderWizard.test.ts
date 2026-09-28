import type { PluginDraft } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { pluginDetail, pluginSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { resetLobeIcons } from './lobe-icons'
import { templateById } from './provider-templates'
import ProviderWizard from './ProviderWizard.vue'
import { applyTemplate, defaultWizardValues, emptyModel, WIZARD_DRAFT_KEY } from './wizard'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

// CodeMirror is not exercised here: the manifest text is what matters.
vi.mock('./WizardManifestView.vue', async () => {
  const vue = await import('vue')
  return {
    __esModule: true,
    default: vue.defineComponent({
      props: { json: { type: String, required: true } },
      setup: props => () => vue.h('pre', { 'data-stub': 'manifest' }, props.json),
    }),
  }
})

const KEY = 'sk-acme-test-key-0123456789'

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let storage: Storage

beforeEach(() => {
  storage = stubLocalStorage()
  api = createMockApi()
  mock.api = api
  api.plugins.list.mockResolvedValue({ items: [pluginSummary({ id: 'existing-plugin' })] })
  api.icons.list.mockResolvedValue({ items: [{ slug: 'together', hasColor: true }, { slug: 'lmstudio', hasColor: false }], version: 'test' })
  pinia = createPinia()
  setActivePinia(pinia)
  resetLobeIcons()
  toasts.success.mockReset()
  toasts.error.mockReset()
})

const mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  for (const wrapper of mounted.splice(0))
    wrapper.unmount()
  disposePinia(pinia)
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function mountWizard(props: { editId?: string } = {}) {
  const created = vi.fn()
  const cancel = vi.fn()
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(ProviderWizard, { ...props, onCreated: created, onCancel: cancel }),
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  mounted.push(wrapper)
  return { wrapper, created, cancel }
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string, extra = ''): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]${extra}`)
}

function wizardStep(): string | undefined {
  return byTestId(testIds.wizard)?.dataset.step
}

async function type(element: HTMLElement | null, value: string) {
  expect(element).not.toBeNull()
  const input = element as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('blur'))
  await flushPromises()
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  element!.click()
  await flushPromises()
}

function nextButton(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.wizardNext)!
}

function stepText(): string {
  return document.body.querySelector('[data-testid^="wizard-step-"]')?.textContent ?? ''
}

/** Seeds a stored draft (the create flow restores it on mount). */
function seedDraft(step: string, values: object) {
  storage.setItem(WIZARD_DRAFT_KEY, JSON.stringify({ step, values }))
}

describe('providerWizard: steps and validation', () => {
  it('starts on Basics with Next disabled; pressing it shows the errors and focuses the first invalid field', async () => {
    mountWizard()
    await flushPromises()
    expect(wizardStep()).toBe('basics')
    expect(byTestId(testIds.wizardStepBasics)).not.toBeNull()
    expect(nextButton().getAttribute('aria-disabled')).toBe('true')
    expect(stepText()).not.toContain('Enter a name.')

    await click(nextButton())
    expect(wizardStep()).toBe('basics')
    expect(stepText()).toContain('Enter a name.')
    expect(document.activeElement).toBe(byTestId(testIds.wizardName))
  })

  it('derives the id from the name and checks reserved and existing ids live', async () => {
    mountWizard()
    await flushPromises()
    await type(byTestId(testIds.wizardName), 'Together AI')
    expect(byTestId<HTMLInputElement>(testIds.wizardId)!.value).toBe('together-ai')
    expect(stepText()).toContain('together-ai:model-id')
    expect(nextButton().hasAttribute('aria-disabled')).toBe(false)

    await type(byTestId(testIds.wizardId), 'openai')
    expect(stepText()).toContain('"openai" is reserved for built-in plugins.')
    expect(nextButton().getAttribute('aria-disabled')).toBe('true')

    await type(byTestId(testIds.wizardId), 'existing-plugin')
    expect(stepText()).toContain('A plugin with this id already exists.')

    // Once edited, the id no longer follows the name.
    await type(byTestId(testIds.wizardId), 'my-together')
    await type(byTestId(testIds.wizardName), 'Something else')
    expect(byTestId<HTMLInputElement>(testIds.wizardId)!.value).toBe('my-together')
  })

  it('picks a LobeHub icon from the searchable grid', async () => {
    mountWizard()
    await flushPromises()
    await click(byTestId(testIds.wizardIconTab, '[data-value="lobe"]'))
    // reka Tabs switch on mousedown in some versions: select through the keyboard-free path too.
    byTestId(testIds.wizardIconTab, '[data-value="lobe"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()
    expect(api.icons.list).toHaveBeenCalledTimes(1)
    const options = () => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.wizardIconOption}"]`)].map(option => option.dataset.value)
    expect(options()).toEqual(['together', 'lmstudio'])
    await type(byTestId(testIds.wizardIconSearch), 'lm')
    expect(options()).toEqual(['lmstudio'])
    await click(byTestId(testIds.wizardIconOption, '[data-value="lmstudio"]'))
    expect(byTestId(testIds.wizardIconOption, '[data-value="lmstudio"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(stepText()).toContain('Selected: lmstudio')
  })

  it('applies a template on the API step', async () => {
    seedDraft('api', { ...defaultWizardValues(), name: 'My models', id: 'my-models' })
    mountWizard()
    await flushPromises()
    expect(wizardStep()).toBe('api')
    await click(byTestId(testIds.wizardTemplate, '[data-value="lmstudio"]'))
    expect(byTestId<HTMLInputElement>(testIds.wizardBaseUrl)!.value).toBe('http://localhost:1234/v1')
    expect(byTestId(testIds.wizardTemplate, '[data-value="lmstudio"]')!.getAttribute('aria-pressed')).toBe('true')
    // The name the user typed stays.
    await click(nextButton())
    expect(wizardStep()).toBe('credentials')
    expect(byTestId(testIds.wizardAuthStyle)!.dataset.value).toBe('none')
    expect(document.body.querySelectorAll(`[data-testid="${testIds.wizardCredentialRow}"]`)).toHaveLength(0)
  })

  it('warns about plain HTTP to another host', async () => {
    seedDraft('api', { ...defaultWizardValues(), name: 'LAN box', id: 'lan-box' })
    mountWizard()
    await flushPromises()
    await type(byTestId(testIds.wizardBaseUrl), 'http://192.168.1.10:8000/v1')
    expect(stepText()).toContain('Plain HTTP to another computer')
    await type(byTestId(testIds.wizardBaseUrl), 'http://localhost:8000/v1')
    expect(stepText()).not.toContain('Plain HTTP to another computer')
  })

  it('does not skip ahead past an invalid step with the stepper', async () => {
    mountWizard()
    await flushPromises()
    const review = document.body.querySelector<HTMLElement>('[data-step-item="review"] button')
    expect(review?.hasAttribute('disabled') || review?.closest('[data-disabled]') !== null).toBe(true)
  })
})

describe('providerWizard: create', () => {
  it('runs the whole flow: fetch models, test, create with the key as a credential', async () => {
    api.pluginDrafts.test.mockImplementation(async ({ body }: { body: { action: string } }) => body.action === 'list-models'
      ? { ok: true, latencyMs: 12, models: [{ id: 'acme-large', contextWindow: 131072 }, { id: 'acme-small' }] }
      : { ok: true, latencyMs: 9, output: 'pong' })
    api.pluginDrafts.create.mockImplementation(async ({ body }: { body: PluginDraft }) => pluginDetail({ id: body.manifest.id, kind: 'declarative' }))
    api.plugins.get.mockImplementation(async ({ params }: { params: { id: string } }) => pluginDetail({ id: params.id, kind: 'declarative' }))
    const { created } = mountWizard()
    await flushPromises()

    await type(byTestId(testIds.wizardName), 'Acme AI')
    await click(nextButton())
    expect(wizardStep()).toBe('api')

    await type(byTestId(testIds.wizardBaseUrl), 'https://api.acme.example/v1')
    await click(nextButton())
    expect(wizardStep()).toBe('credentials')

    await type(byTestId(testIds.wizardCredentialValue, '[data-value="apiKey"]'), KEY)
    await click(nextButton())
    expect(wizardStep()).toBe('models')

    await click(byTestId(testIds.wizardFetchModels))
    expect(api.pluginDrafts.test).toHaveBeenLastCalledWith({ body: expect.objectContaining({ action: 'list-models', credentials: { apiKey: KEY } }) })
    expect(stepText()).toContain('2 models · 12 ms')
    const checkbox = [...document.body.querySelectorAll<HTMLElement>('[aria-label="Fetched models"] [role="checkbox"]')][0]
    await click(checkbox ?? null)
    expect(byTestId(testIds.wizardModelRow, '[data-value="acme-large"]')).not.toBeNull()
    await click(nextButton())
    expect(wizardStep()).toBe('review')

    expect(document.body.querySelector('[data-stub="manifest"]')?.textContent).toContain('"baseURL": "https://api.acme.example/v1"')
    expect(document.body.querySelector('[data-stub="manifest"]')?.textContent).not.toContain(KEY)
    await click(byTestId(testIds.wizardTest))
    expect(api.pluginDrafts.test).toHaveBeenLastCalledWith({ body: expect.objectContaining({ action: 'ping', modelId: 'acme-large' }) })
    const result = byTestId(testIds.wizardTestResult)!
    expect(result.dataset.status).toBe('ok')
    expect(result.textContent).toContain('Connected · 9 ms')

    await click(byTestId(testIds.wizardCreate))
    const draft = api.pluginDrafts.create.mock.calls[0]?.[0]?.body as PluginDraft
    expect(draft.manifest).toMatchObject({ id: 'acme-ai', name: 'Acme AI', contributes: { providers: [{ id: 'acme-ai', baseURL: 'https://api.acme.example/v1' }] } })
    expect(draft.manifest.contributes?.providers?.[0]?.models).toEqual([{ id: 'acme-large', contextWindow: 131072, capabilities: { tools: false, vision: false, reasoning: false, pdf: false } }])
    expect(draft.credentials).toEqual({ 'acme-ai': { apiKey: KEY } })
    expect(created).toHaveBeenCalledWith('acme-ai')
    expect(toasts.success).toHaveBeenCalledWith('Provider created')
    expect(storage.getItem(WIZARD_DRAFT_KEY)).toBeNull()
  })

  it('shows a failed connection test', async () => {
    seedDraft('review', { ...completeDraftValues() })
    api.pluginDrafts.test.mockResolvedValue({ ok: false, latencyMs: 30, error: { code: 'auth_invalid', message: 'Acme AI rejected the credentials (HTTP 401). Check the key and the auth style.', status: 401, details: { upstream: 'Incorrect API key' } } })
    mountWizard()
    await flushPromises()
    await click(byTestId(testIds.wizardTest))
    const result = byTestId(testIds.wizardTestResult)!
    expect(result.dataset.status).toBe('error')
    expect(result.textContent).toContain('rejected the credentials')
    expect(result.textContent).toContain('Incorrect API key')
  })

  it('asks for the password when the server wants fresh auth, then retries once', async () => {
    seedDraft('review', completeDraftValues())
    api.pluginDrafts.create
      .mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Confirm your password to continue.', action: 'login' }))
      .mockResolvedValueOnce(pluginDetail({ id: 'acme-ai', kind: 'declarative' }))
    api.auth.login.mockResolvedValue({ enabled: true, authenticated: true, source: 'settings', freshUntil: Date.now() + 600_000 })
    api.plugins.get.mockResolvedValue(pluginDetail({ id: 'acme-ai', kind: 'declarative' }))
    const { created } = mountWizard()
    await flushPromises()
    await click(byTestId(testIds.wizardCreate))
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    await type(byTestId(testIds.confirmPasswordInput), 'hunter2')
    await click(byTestId(testIds.confirmPasswordSubmit))
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'hunter2' } })
    expect(api.pluginDrafts.create).toHaveBeenCalledTimes(2)
    expect(created).toHaveBeenCalledWith('acme-ai')
  })

  it('maps server validation errors and conflicts back to their step', async () => {
    seedDraft('review', completeDraftValues())
    api.pluginDrafts.create.mockRejectedValueOnce(new HarnessError({
      code: 'validation_error',
      message: 'manifest.contributes.providers.0.baseURL: invalid',
      details: { issues: [{ path: ['manifest', 'contributes', 'providers', 0, 'baseURL'], message: 'The server refused this URL.', code: 'custom' }] },
    }))
    mountWizard()
    await flushPromises()
    await click(byTestId(testIds.wizardCreate))
    expect(wizardStep()).toBe('api')
    expect(stepText()).toContain('The server refused this URL.')

    api.pluginDrafts.create.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A plugin with the id "acme-ai" already exists.', details: { reason: 'exists' } }))
    // Any change clears the server issue; go back to Review and create again.
    await type(byTestId(testIds.wizardBaseUrl), 'https://api.acme.example/v2')
    for (const target of ['credentials', 'models', 'review']) {
      await click(nextButton())
      expect(wizardStep()).toBe(target)
    }
    await click(byTestId(testIds.wizardCreate))
    expect(wizardStep()).toBe('basics')
    expect(stepText()).toContain('A plugin with the id "acme-ai" already exists.')
  })
})

describe('providerWizard: draft', () => {
  it('keeps a draft without secret values and restores it', async () => {
    const first = mountWizard()
    await flushPromises()
    await type(byTestId(testIds.wizardName), 'Draft AI')
    await click(nextButton())
    await type(byTestId(testIds.wizardBaseUrl), 'https://draft.example/v1')
    await click(nextButton())
    await type(byTestId(testIds.wizardCredentialValue, '[data-value="apiKey"]'), KEY)
    await new Promise(resolve => setTimeout(resolve, 400))
    const stored = storage.getItem(WIZARD_DRAFT_KEY) ?? ''
    expect(stored).toContain('Draft AI')
    expect(stored).toContain('"step":"credentials"')
    expect(stored).not.toContain(KEY)
    first.wrapper.unmount()
    mounted.splice(mounted.indexOf(first.wrapper), 1)
    document.body.replaceChildren()

    mountWizard()
    await flushPromises()
    expect(wizardStep()).toBe('credentials')
    expect(document.body.textContent).toContain('Continuing your draft.')
    expect(byTestId<HTMLInputElement>(testIds.wizardCredentialValue, '[data-value="apiKey"]')!.value).toBe('')
  })

  it('discards the draft after confirmation', async () => {
    seedDraft('api', { ...defaultWizardValues(), name: 'Old draft', id: 'old-draft' })
    mountWizard()
    await flushPromises()
    await click(byTestId(testIds.wizardDiscard))
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Discard')
    await click(confirm ?? null)
    await nextTick()
    expect(storage.getItem(WIZARD_DRAFT_KEY)).toBeNull()
    expect(wizardStep()).toBe('basics')
    expect(byTestId<HTMLInputElement>(testIds.wizardName)!.value).toBe('')
  })
})

describe('providerWizard: edit mode', () => {
  it('loads a declarative plugin, keeps its id and saves with PUT /plugins/:id/manifest', async () => {
    const manifest = {
      manifestVersion: 1 as const,
      id: 'acme-ai',
      name: 'Acme AI',
      version: '1.2.0',
      engines: { harness: '^1.0.0' },
      contributes: { providers: [{ id: 'acme-ai', name: 'Acme AI', baseURL: 'https://api.acme.example/v1', apiFormat: 'openai-chat' as const, models: [{ id: 'acme-large' }] }] },
    }
    api.plugins.get.mockResolvedValue(pluginDetail({ id: 'acme-ai', kind: 'declarative', source: 'created', editable: true, manifest }))
    api.pluginDrafts.updateManifest.mockResolvedValue(pluginDetail({ id: 'acme-ai', kind: 'declarative' }))
    const { created } = mountWizard({ editId: 'acme-ai' })
    await flushPromises()
    expect(byTestId<HTMLInputElement>(testIds.wizardName)!.value).toBe('Acme AI')
    expect(byTestId<HTMLInputElement>(testIds.wizardId)!.readOnly).toBe(true)
    expect(byTestId(testIds.wizardDiscard)).toBeNull()
    // Every step is valid: jump to Review with the stepper (reka triggers switch on mousedown).
    document.body.querySelector<HTMLElement>('[data-step-item="review"] button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()
    expect(wizardStep()).toBe('review')
    expect(byTestId(testIds.wizardCreate)!.textContent).toContain('Save changes')
    await click(byTestId(testIds.wizardCreate))
    expect(api.pluginDrafts.updateManifest).toHaveBeenCalledWith({
      params: { id: 'acme-ai' },
      body: { manifest: expect.objectContaining({ id: 'acme-ai', version: '1.2.0' }) },
    })
    expect(api.pluginDrafts.create).not.toHaveBeenCalled()
    expect(created).toHaveBeenCalledWith('acme-ai')
    expect(storage.getItem(WIZARD_DRAFT_KEY)).toBeNull()
  })

  it('refuses a code plugin', async () => {
    api.plugins.get.mockResolvedValue(pluginDetail({ id: 'dice-roller', kind: 'code' }))
    const { cancel } = mountWizard({ editId: 'dice-roller' })
    await flushPromises()
    expect(document.body.textContent).toContain('cannot be edited in the provider wizard')
    const back = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Back to plugins'))
    await click(back ?? null)
    expect(cancel).toHaveBeenCalled()
  })
})

/** Values valid on every step (a Together-style provider with a model and a key). */
function completeDraftValues() {
  return {
    ...applyTemplate({ ...defaultWizardValues(), name: 'Acme AI', id: 'acme-ai' }, templateById('together-ai')!),
    models: [emptyModel('acme-large')],
  }
}
