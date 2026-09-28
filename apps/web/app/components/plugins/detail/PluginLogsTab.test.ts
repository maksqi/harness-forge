import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allByTestId, byTestId, mountInShell, settle } from '~/components/plugins/list/testing'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { logEntry } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import PluginLogsTab from './PluginLogsTab.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

const HISTORY = [
  logEntry(1, { level: 'debug', message: 'loading index.mjs' }),
  logEntry(2, { level: 'info', message: 'setup complete' }),
  logEntry(3, { level: 'warn', message: 'quota low', data: { left: 180 } }),
  logEntry(4, { level: 'error', message: 'webhook failed' }),
]

async function mountLogs(pluginId = 'dice-roller') {
  wrapper = mountInShell(PluginLogsTab, { pluginId })
  await settle()
  return wrapper
}

function rows() {
  return allByTestId(testIds.pluginLogEntry).map(row => [row.dataset.level, row.lastElementChild?.textContent?.trim()])
}

async function chooseLevel(label: string) {
  const item = Array.from(byTestId(testIds.pluginLogsLevel)!.querySelectorAll('button')).find(button => button.textContent?.trim() === label)!
  item.click()
  await settle()
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find(item => item.textContent?.trim() === text)
  expect(found, text).toBeDefined()
  return found as HTMLButtonElement
}

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  api.plugins.logs.mockResolvedValue({ items: HISTORY })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
  vi.unstubAllGlobals()
})

describe('pluginLogsTab', () => {
  it('loads the ring buffer and shows time, level and message', async () => {
    await mountLogs()
    expect(api.plugins.logs).toHaveBeenCalledWith({ params: { id: 'dice-roller' }, query: { limit: 500 } })
    expect(rows()).toEqual([
      ['debug', 'loading index.mjs'],
      ['info', 'setup complete'],
      ['warn', 'quota low{"left":180}'],
      ['error', 'webhook failed'],
    ])
    const first = allByTestId(testIds.pluginLogEntry)[0]!
    expect(first.querySelector('time')?.getAttribute('datetime')).toBe(new Date(HISTORY[0]!.at).toISOString())
    expect(byTestId(testIds.pluginLogs)!.querySelector('[role="log"]')).not.toBeNull()
  })

  it('appends live plugin.log events of this plugin only', async () => {
    await mountLogs()
    const plugins = usePluginsStore()
    plugins.applyEvent(createServerEvent('plugin.log', { pluginId: 'dice-roller', entry: logEntry(5, { level: 'info', message: 'rolled 3d6 = 11' }) }))
    plugins.applyEvent(createServerEvent('plugin.log', { pluginId: 'other', entry: logEntry(6, { message: 'not mine' }) }))
    // A repeated sequence number is ignored.
    plugins.applyEvent(createServerEvent('plugin.log', { pluginId: 'dice-roller', entry: logEntry(5, { message: 'duplicate' }) }))
    await settle()
    expect(rows().map(row => row[1])).toEqual(['loading index.mjs', 'setup complete', 'quota low{"left":180}', 'webhook failed', 'rolled 3d6 = 11'])
  })

  it('filters by minimum level', async () => {
    await mountLogs()
    expect(byTestId(testIds.pluginLogsLevel)!.dataset.value).toBe('all')
    await chooseLevel('Warn')
    expect(byTestId(testIds.pluginLogsLevel)!.dataset.value).toBe('warn')
    expect(rows().map(row => row[0])).toEqual(['warn', 'error'])
    await chooseLevel('Info')
    expect(rows().map(row => row[0])).toEqual(['info', 'warn', 'error'])
    await chooseLevel('Error')
    expect(rows().map(row => row[0])).toEqual(['error'])
    await chooseLevel('All')
    expect(rows()).toHaveLength(4)
  })

  it('clears the view but keeps showing new entries, and can show the earlier ones again', async () => {
    await mountLogs()
    button('Clear view').click()
    await settle()
    expect(rows()).toEqual([])
    expect(byTestId(testIds.pluginLogs)!.textContent).toContain('View cleared. New entries appear here.')
    usePluginsStore().applyEvent(createServerEvent('plugin.log', { pluginId: 'dice-roller', entry: logEntry(9, { message: 'after clear' }) }))
    await settle()
    expect(rows().map(row => row[1])).toEqual(['after clear'])

    button('Clear view').click()
    await settle()
    button('Show earlier entries').click()
    await settle()
    expect(rows()).toHaveLength(5)
  })

  it('copies the visible entries as text', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } })
    await mountLogs()
    await chooseLevel('Error')
    button('Copy').click()
    await settle()
    expect(writeText).toHaveBeenCalledTimes(1)
    const text = (writeText.mock.calls[0] as unknown as [string])[0]
    expect(text.split('\n')).toHaveLength(1)
    expect(text).toMatch(/ERROR webhook failed$/)
  })

  it('shows an empty state and a load error with Retry', async () => {
    api.plugins.logs.mockResolvedValueOnce({ items: [] })
    await mountLogs()
    expect(byTestId(testIds.pluginLogs)!.textContent).toContain('No log entries yet.')
    wrapper!.unmount()
    disposePinia(pinia)
    pinia = createPinia()
    setActivePinia(pinia)

    api.plugins.logs.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Log buffer unavailable.' }))
    await mountLogs('broken')
    expect(byTestId(testIds.pluginLogs)!.textContent).toContain('Log buffer unavailable.')
    button('Retry').click()
    await settle()
    expect(rows()).toHaveLength(4)
  })
})
