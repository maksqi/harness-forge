// Settings → Web search (Phase 14, ADR-062, ADR-063; docs/UI.md 2.20, 9.15, 14): the page frame, loading, the two
// switches (settings store), the backend select, the write-only key rows, Max results, Test search and the
// "core-search is off" state (web-search store, mocked API).
import type { PluginSettingsView, SecretState, Settings, WebSearchTestResult } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { ComputedRef } from 'vue'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import SearchPage from '~/pages/settings/search.vue'
import { useSettingsStore } from '~/stores/settings'
import { useWebSearchStore } from '~/stores/web-search'
import { testIds } from '~/utils/testids'
import { pluginDetail } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import WebSearchSettings from './WebSearchSettings.vue'

const mocks = vi.hoisted(() => ({ useHead: vi.fn(), api: null as unknown }))
// SettingsPage sets the tab title through the settings nuxt-imports module ('#imports' does not resolve in Vitest).
vi.mock('~/components/settings/nuxt-imports', () => ({ useHead: mocks.useHead }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const NuxtLink = defineComponent({
  props: { to: { type: String, required: true } },
  setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
})

const SET: SecretState = { set: true, hint: 'BSA…9fQ2', source: 'stored' }
const MISSING: SecretState = { set: false, hint: null, source: null }
const SECRET = 'tvly-dev-0123456789abcdef'

interface Server {
  values: { backend: string, maxResults: number }
  secrets: Record<string, SecretState>
  state: 'active' | 'disabled'
  settings: Settings
}

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null
let server: Server

function settingsView(): PluginSettingsView {
  return { schema: null, values: { ...server.values }, secrets: { ...server.secrets } }
}

beforeEach(() => {
  mocks.useHead.mockReset()
  toasts.success.mockReset()
  toasts.error.mockReset()
  api = createMockApi()
  mocks.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  server = {
    values: { backend: 'brave', maxResults: 5 },
    secrets: { braveApiKey: SET, tavilyApiKey: MISSING, exaApiKey: MISSING },
    state: 'active',
    settings: { ...DEFAULT_SETTINGS },
  }
  api.settings.get.mockImplementation(async () => server.settings)
  api.settings.update.mockImplementation(async ({ body }: { body: Partial<Settings> }) => {
    server.settings = { ...server.settings, ...body }
    return server.settings
  })
  api.plugins.getSettings.mockImplementation(async () => settingsView())
  api.plugins.get.mockImplementation(async () => pluginDetail({ id: 'core-search', builtin: true, state: server.state, enabled: server.state === 'active' }))
  api.plugins.updateSettings.mockImplementation(async ({ body }: { body: { values: Record<string, unknown> } }) => {
    for (const [key, value] of Object.entries(body.values)) {
      if (key.endsWith('ApiKey'))
        server.secrets[key] = value === '' ? MISSING : { set: true, hint: 'xxxx…cdef', source: 'stored' }
      else
        (server.values as Record<string, unknown>)[key] = value
    }
    return settingsView()
  })
})

afterEach(async () => {
  wrapper?.unmount()
  wrapper = null
  await flushPromises()
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function settle(rounds = 3) {
  for (let round = 0; round < rounds; round++) {
    await flushPromises()
    await nextTick()
  }
}

async function mountSettings(component: typeof WebSearchSettings | typeof SearchPage = WebSearchSettings) {
  wrapper = mount(component, { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink } } })
  await settle()
  return wrapper
}

function byTestId(id: string, root: ParentNode = document.body): HTMLElement {
  const found = root.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!found)
    throw new Error(`No element with data-testid="${id}"`)
  return found
}

function keyRows(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.settingsSearchKey}"]`)]
}

function keyRow(backend: string): HTMLElement {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.settingsSearchKey}"][data-backend="${backend}"]`)!
}

async function typeInto(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await nextTick()
}

async function click(element: HTMLElement) {
  element.click()
  await settle()
}

describe('webSearchSettings: loading', () => {
  it('renders its root test id and loads the settings and the search API configuration', async () => {
    await mountSettings()
    expect(byTestId(testIds.webSearchSettings)).toBeTruthy()
    expect(api.settings.get).toHaveBeenCalledTimes(1)
    expect(api.plugins.getSettings).toHaveBeenCalledWith({ params: { id: 'core-search' } })
    expect(api.plugins.get).toHaveBeenCalledWith({ params: { id: 'core-search' } })
    const sections = [...document.body.querySelectorAll('[data-slot="settings-section"] h2')].map(heading => heading.textContent?.trim())
    expect(sections).toEqual(['Web search in chats', 'Search API'])
    expect(byTestId(testIds.settingsSearchNative).getAttribute('aria-checked')).toBe('true')
    expect(byTestId(testIds.settingsSearchDefault).getAttribute('aria-checked')).toBe('false')
    expect(byTestId(testIds.settingsSearchBackend).dataset.value).toBe('brave')
    expect(byTestId(testIds.settingsSearchBackend).textContent?.trim()).toBe('Brave Search')
    expect((byTestId(testIds.settingsSearchMaxResults) as HTMLInputElement).value).toBe('5')
    expect(document.body.textContent).toContain('Only your query, the number of results and the time filter go to Brave Search. Queries and keys are never logged.')
    // Nothing is searched on load.
    expect(api.webSearch.test).not.toHaveBeenCalled()
  })

  it('reuses loaded settings and a fresh configuration (15 s)', async () => {
    useSettingsStore().settings = { ...DEFAULT_SETTINGS }
    useSettingsStore().loaded = true
    await useWebSearchStore().fetch()
    await mountSettings()
    expect(api.settings.get).not.toHaveBeenCalled()
    expect(api.plugins.getSettings).toHaveBeenCalledTimes(1)
  })

  it('says so when loading fails, and retries', async () => {
    api.plugins.getSettings.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    await mountSettings()
    const alert = document.body.querySelector<HTMLElement>('[data-slot="settings-load-error"]')!
    expect(alert.textContent).toContain('Could not load the web search settings')
    expect(alert.textContent).toContain('The database is locked.')
    // The sections still render; the Search API controls wait for the configuration.
    expect(byTestId(testIds.settingsSearchNative)).toBeTruthy()
    expect(keyRows()).toHaveLength(0)
    expect(byTestId(testIds.settingsSearchBackend).hasAttribute('disabled') || byTestId(testIds.settingsSearchBackend).dataset.disabled !== undefined).toBe(true)

    await click(alert.querySelector('button')!)
    expect(document.body.querySelector('[data-slot="settings-load-error"]')).toBeNull()
    expect(keyRows()).toHaveLength(3)
  })

  it('shows placeholders while the configuration loads', async () => {
    api.plugins.getSettings.mockReturnValue(new Promise(() => {}))
    await mountSettings()
    expect(document.body.querySelector('[data-slot="web-search-keys-loading"]')).not.toBeNull()
    expect(keyRows()).toHaveLength(0)
    expect(byTestId(testIds.settingsSearchTest).hasAttribute('disabled')).toBe(true)
  })
})

describe('webSearchSettings: web search in chats', () => {
  it('saves "Use the model\'s own web search" and "Turn on web search in new chats" at once', async () => {
    await mountSettings()
    const native = byTestId(testIds.settingsSearchNative)
    const field = native.closest('[data-slot="field"]')!
    expect(field.textContent).toContain('Use the model\'s own web search when it has one')
    expect(field.textContent).toContain('The provider bills its searches; they aren\'t in harness-forge\'s cost estimate.')
    expect(field.querySelector('label')!.getAttribute('for')).toBe(native.id)
    await click(native)
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { webSearchNative: false } })
    expect(native.getAttribute('aria-checked')).toBe('false')

    const defaultOn = byTestId(testIds.settingsSearchDefault)
    expect(defaultOn.closest('[data-slot="field"]')!.textContent).toContain('Turn on web search in new chats')
    await click(defaultOn)
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { webSearchDefault: 'auto' } })
    expect(defaultOn.getAttribute('aria-checked')).toBe('true')
    await click(defaultOn)
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { webSearchDefault: 'off' } })
  })

  it('rolls a failed switch back and toasts the error', async () => {
    await mountSettings()
    api.settings.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    const native = byTestId(testIds.settingsSearchNative)
    await click(native)
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect(native.getAttribute('aria-checked')).toBe('true')
  })

  it('every switch keeps the 40px coarse-pointer hit area', async () => {
    await mountSettings()
    for (const id of [testIds.settingsSearchNative, testIds.settingsSearchDefault])
      expect(byTestId(id).classList.contains('pointer-coarse:after:-inset-y-3')).toBe(true)
  })
})

describe('webSearchSettings: search API', () => {
  it('lists one key row per backend: the selected one first, then "Other search APIs"', async () => {
    await mountSettings()
    const list = document.body.querySelector<HTMLElement>('ul[aria-label="Search API keys"]')!
    expect(list).not.toBeNull()
    expect(keyRows().map(row => [row.dataset.backend, row.dataset.state])).toEqual([['brave', 'set'], ['tavily', 'missing'], ['exa', 'missing']])
    expect(list.textContent).toContain('Other search APIs')
    const brave = keyRow('brave')
    expect(brave.textContent).toContain('Brave Search')
    expect(brave.textContent).toContain('Key saved')
    // Never the stored key, not even its masked hint.
    expect(document.body.innerHTML).not.toContain('BSA…9fQ2')
    expect(brave.querySelector(`[data-testid="${testIds.settingsSearchKeyInput}"]`)).toBeNull()
    const link = brave.querySelector<HTMLAnchorElement>('a[target="_blank"]')!
    expect(link.textContent).toContain('Get a key')
    expect(link.getAttribute('href')).toBe('https://brave.com/search/api/')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')

    const input = byTestId(testIds.settingsSearchKeyInput, keyRow('tavily')) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Paste a key…')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.getAttribute('aria-label')).toBe('Tavily key')
    expect(input.dataset.backend).toBe('tavily')
    expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe('No key')
    expect(byTestId(testIds.settingsSearchKeySave, keyRow('tavily')).hasAttribute('disabled')).toBe(true)
  })

  it('saves a key write-only: the row says "Key saved", the value is never rendered back', async () => {
    await mountSettings()
    const row = keyRow('tavily')
    const input = byTestId(testIds.settingsSearchKeyInput, row) as HTMLInputElement
    await typeInto(input, `  ${SECRET} `)
    const save = byTestId(testIds.settingsSearchKeySave, row)
    expect(save.hasAttribute('disabled')).toBe(false)
    await click(save)
    expect(api.plugins.updateSettings).toHaveBeenCalledWith({ params: { id: 'core-search' }, body: { values: { tavilyApiKey: SECRET } } })
    expect(toasts.success).toHaveBeenCalledWith('Saved the Tavily key')
    expect(keyRow('tavily').dataset.state).toBe('set')
    expect(keyRow('tavily').textContent).toContain('Key saved')
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(JSON.stringify(useWebSearchStore().$state)).not.toContain(SECRET)
    // Focus moves to the row's next control: Replace.
    expect(document.activeElement?.getAttribute('data-action')).toBe('replace')
    expect(keyRow('tavily').contains(document.activeElement)).toBe(true)
  })

  it('enter in the key input saves too; a failure keeps the input and toasts', async () => {
    await mountSettings()
    api.plugins.updateSettings.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'Invalid settings.' }))
    const input = byTestId(testIds.settingsSearchKeyInput, keyRow('exa')) as HTMLInputElement
    await typeInto(input, 'exa-key')
    input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(api.plugins.updateSettings).toHaveBeenCalledWith({ params: { id: 'core-search' }, body: { values: { exaApiKey: 'exa-key' } } })
    expect(toasts.error).toHaveBeenCalledWith(expect.any(String), { description: 'Invalid settings.' })
    expect(keyRow('exa').dataset.state).toBe('missing')
    expect((byTestId(testIds.settingsSearchKeyInput, keyRow('exa')) as HTMLInputElement).value).toBe('exa-key')
  })

  it('replace shows an empty input with focus; Esc goes back to "Key saved"', async () => {
    await mountSettings()
    const row = keyRow('brave')
    await click(row.querySelector<HTMLElement>('[data-action="replace"]')!)
    const input = byTestId(testIds.settingsSearchKeyInput, row) as HTMLInputElement
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe('Key saved')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(row.querySelector(`[data-testid="${testIds.settingsSearchKeyInput}"]`)).toBeNull()
    expect(document.activeElement?.getAttribute('data-action')).toBe('replace')
  })

  it('remove clears the key and moves focus to the input', async () => {
    await mountSettings()
    const remove = byTestId(testIds.settingsSearchKeyRemove, keyRow('brave'))
    expect(remove.dataset.backend).toBe('brave')
    expect(remove.getAttribute('aria-label')).toBe('Remove the Brave Search key')
    await click(remove)
    expect(api.plugins.updateSettings).toHaveBeenCalledWith({ params: { id: 'core-search' }, body: { values: { braveApiKey: '' } } })
    expect(toasts.success).toHaveBeenCalledWith('Removed the Brave Search key')
    expect(keyRow('brave').dataset.state).toBe('missing')
    expect(document.activeElement).toBe(byTestId(testIds.settingsSearchKeyInput, keyRow('brave')))
    // The selected API has no key now: Test search is off.
    expect(byTestId(testIds.settingsSearchTest).hasAttribute('disabled')).toBe(true)
  })

  it('the backend select saves at once and reorders the key rows', async () => {
    await mountSettings()
    const trigger = byTestId(testIds.settingsSearchBackend)
    // reka-ui's Select opens with the keyboard in happy-dom.
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    const items = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
    expect(items.map(item => [item.dataset.value, item.textContent?.trim()])).toEqual([['brave', 'Brave Search'], ['tavily', 'Tavily'], ['exa', 'Exa']])
    items[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(api.plugins.updateSettings).toHaveBeenCalledWith({ params: { id: 'core-search' }, body: { values: { backend: 'tavily' } } })
    expect(byTestId(testIds.settingsSearchBackend).dataset.value).toBe('tavily')
    expect(keyRows().map(row => row.dataset.backend)).toEqual(['tavily', 'brave', 'exa'])
    expect(document.body.textContent).toContain('go to Tavily.')
    // Tavily has no key yet.
    expect(byTestId(testIds.settingsSearchTest).hasAttribute('disabled')).toBe(true)
  })

  it('a failed backend change rolls back and toasts', async () => {
    await mountSettings()
    api.plugins.updateSettings.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    byTestId(testIds.settingsSearchBackend).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    document.body.querySelector<HTMLElement>('[data-slot="select-item"][data-value="exa"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect(byTestId(testIds.settingsSearchBackend).dataset.value).toBe('brave')
  })

  it('max results saves a whole number from 1 to 10 on blur or Enter; Esc restores', async () => {
    await mountSettings()
    const input = byTestId(testIds.settingsSearchMaxResults) as HTMLInputElement
    expect(input.getAttribute('inputmode')).toBe('numeric')
    input.dispatchEvent(new Event('focus'))
    await typeInto(input, '11')
    input.dispatchEvent(new Event('blur'))
    await settle()
    expect(document.body.textContent).toContain('Enter a whole number from 1 to 10.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(api.plugins.updateSettings).not.toHaveBeenCalled()

    input.dispatchEvent(new Event('focus'))
    await typeInto(input, '8')
    input.dispatchEvent(new Event('blur'))
    await settle()
    expect(api.plugins.updateSettings).toHaveBeenCalledWith({ params: { id: 'core-search' }, body: { values: { maxResults: 8 } } })
    expect(document.body.textContent).not.toContain('Enter a whole number from 1 to 10.')

    input.dispatchEvent(new Event('focus'))
    await typeInto(input, '3')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(input.value).toBe('8')
    expect(api.plugins.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('a failed max results save restores the saved value', async () => {
    await mountSettings()
    api.plugins.updateSettings.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    const input = byTestId(testIds.settingsSearchMaxResults) as HTMLInputElement
    input.dispatchEvent(new Event('focus'))
    await typeInto(input, '9')
    input.dispatchEvent(new Event('blur'))
    await settle()
    expect(toasts.error).toHaveBeenCalled()
    expect(input.value).toBe('5')
  })
})

describe('webSearchSettings: Test search', () => {
  const ok: WebSearchTestResult = { ok: true, backend: 'brave', results: 5, ms: 412 }

  it('tests the selected API and shows the result line', async () => {
    let finish: (value: WebSearchTestResult) => void = () => {}
    api.webSearch.test.mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    await mountSettings()
    const button = byTestId(testIds.settingsSearchTest)
    expect(button.textContent).toContain('Test search')
    button.focus()
    await click(button)
    expect(api.webSearch.test).toHaveBeenCalledWith({ body: { backend: 'brave' } })
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    finish(ok)
    await settle()
    const line = byTestId(testIds.settingsSearchTestResult)
    expect(line.getAttribute('role')).toBe('status')
    expect(line.dataset.state).toBe('ok')
    expect(line.textContent?.trim()).toBe('5 results from Brave Search in 412 ms')
    expect(button.hasAttribute('aria-busy')).toBe(false)
    // Test search keeps focus.
    expect(document.activeElement).toBe(button)
  })

  it.each([
    [new HarnessError({ code: 'provider_error', message: 'The search key was rejected.', status: 401 }), 'Brave Search rejected the key.'],
    [new HarnessError({ code: 'rate_limited', message: 'Too many requests.' }), 'Brave Search is limiting requests. Try again later.'],
    [new HarnessError({ code: 'provider_unreachable', message: 'fetch failed' }), 'Couldn\'t reach Brave Search.'],
    [new HarnessError({ code: 'provider_error', message: 'Brave Search answered HTTP 500.', status: 500 }), 'Brave Search answered HTTP 500.'],
  ])('maps a failure to its line (%#)', async (error, text) => {
    api.webSearch.test.mockRejectedValue(error)
    await mountSettings()
    await click(byTestId(testIds.settingsSearchTest))
    const line = byTestId(testIds.settingsSearchTestResult)
    expect(line.dataset.state).toBe('error')
    expect(line.textContent?.trim()).toBe(text)
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('is disabled while the selected API has no key', async () => {
    server.values.backend = 'exa'
    await mountSettings()
    expect(byTestId(testIds.settingsSearchTest).hasAttribute('disabled')).toBe(true)
  })

  it('hides the line of a test of another API', async () => {
    api.webSearch.test.mockResolvedValue(ok)
    await mountSettings()
    await click(byTestId(testIds.settingsSearchTest))
    expect(byTestId(testIds.settingsSearchTestResult).dataset.state).toBe('ok')
    await useWebSearchStore().save({ backend: 'tavily' })
    await settle()
    expect(byTestId(testIds.settingsSearchTestResult).dataset.state).toBeUndefined()
    expect(byTestId(testIds.settingsSearchTestResult).textContent?.trim()).toBe('')
  })
})

describe('webSearchSettings: core-search turned off', () => {
  it('says so, links to the plugin and disables the search API controls (the switches stay)', async () => {
    server.state = 'disabled'
    await mountSettings()
    const alert = document.body.querySelector<HTMLElement>('[data-slot="web-search-plugin-off"]')!
    expect(alert.textContent).toContain('The core-search plugin is turned off, so the search API isn\'t used.')
    const open = [...alert.querySelectorAll('a')].find(link => link.textContent?.includes('Open plugin'))!
    expect(open.getAttribute('href')).toBe('/plugins/core-search')
    const backend = byTestId(testIds.settingsSearchBackend)
    expect(backend.hasAttribute('disabled') || backend.dataset.disabled !== undefined).toBe(true)
    expect(byTestId(testIds.settingsSearchMaxResults).hasAttribute('disabled')).toBe(true)
    expect(byTestId(testIds.settingsSearchTest).hasAttribute('disabled')).toBe(true)
    expect(byTestId(testIds.settingsSearchKeyRemove, keyRow('brave')).hasAttribute('disabled')).toBe(true)
    expect(byTestId(testIds.settingsSearchKeyInput, keyRow('tavily')).hasAttribute('disabled')).toBe(true)
    expect(byTestId(testIds.settingsSearchNative).hasAttribute('disabled')).toBe(false)
  })

  it('follows plugin.changed: turning core-search on enables the controls', async () => {
    server.state = 'disabled'
    await mountSettings()
    server.state = 'active'
    useWebSearchStore().applyEvent({ type: 'plugin.changed', data: { id: 'core-search', plugin: null }, at: Date.now() })
    await settle()
    expect(document.body.querySelector('[data-slot="web-search-plugin-off"]')).toBeNull()
    expect(byTestId(testIds.settingsSearchTest).hasAttribute('disabled')).toBe(false)
  })
})

describe('settings search page', () => {
  it('renders WebSearchSettings in the settings page frame titled "Web search"', async () => {
    await mountSettings(SearchPage)
    const header = byTestId(testIds.pageHeader)
    expect(header.querySelector('h1')!.textContent?.trim()).toBe('Web search')
    expect(header.textContent).toContain('Search the web from the chat, with the model\'s own search or a search API.')
    expect(wrapper!.findComponent(WebSearchSettings).exists()).toBe(true)
    expect(document.body.querySelectorAll('h1')).toHaveLength(1)
    const head = mocks.useHead.mock.calls[0]?.[0] as { title: ComputedRef<string> } | undefined
    expect(head?.title.value).toBe('Web search · harness-forge')
  })
})
