import type { Health } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { pluginSummary, providerSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { buildDiagnostics, diagnosticsText, formatUptime, versionRows } from './about'
import AboutPanel from './AboutPanel.vue'

const mock = vi.hoisted(() => ({ api: null as unknown, copied: [] as string[] }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('~/components/common/clipboard', () => ({
  copyText: async (text: string) => {
    mock.copied.push(text)
    return true
  },
}))

const health: Health = {
  ok: true,
  version: '0.1.0',
  node: 'v26.9.0',
  uptimeSec: 7_950,
  safeMode: false,
  pluginApiVersion: '1.0.0',
  versions: { ai: '7.0.116', hono: '4.13.9', nuxt: '4.5.2' },
}

const HINT = 'sk-ant-…9fQ2'
const keyed = providerSummary({
  credentialFields: [{ key: 'apiKey', label: 'API key', type: 'secret', required: true }],
  credentials: { apiKey: { set: true, hint: HINT, source: 'stored' } },
  keyUrl: 'https://platform.claude.com/settings/keys',
})
const failing = providerSummary({
  id: 'moonshotai',
  status: 'error',
  lastError: { code: 'auth_invalid', message: 'Invalid Authentication', status: 401, details: { upstream: 'raw body' } },
})

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  mock.copied = []
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function mountAbout() {
  const Host = defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(AboutPanel) }) })
  return mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
}

describe('aboutPanel', () => {
  it('shows versions from /api/health and copies diagnostics without keys', async () => {
    api.health.get.mockResolvedValue({ ...health, safeMode: true })
    api.providers.list.mockResolvedValue({ items: [keyed, failing] })
    api.plugins.list.mockResolvedValue({ items: [pluginSummary()] })
    const wrapper = mountAbout()
    await flushPromises()

    const text = wrapper.text()
    for (const value of ['0.1.0', 'v26.9.0', '1.0.0', '7.0.116', '4.13.9', '4.5.2', '2h 12m'])
      expect(text).toContain(value)
    expect(text).toContain('Safe mode')
    expect(text).toContain('MIT License')

    await wrapper.get(`[data-testid="${testIds.aboutCopyDiagnostics}"]`).trigger('click')
    await flushPromises()
    expect(mock.copied).toHaveLength(1)
    const report = JSON.parse(mock.copied[0]!)
    expect(report.app).toMatchObject({ version: '0.1.0', safeMode: true, pluginApiVersion: '1.0.0' })
    expect(report.providers.map((provider: { id: string }) => provider.id)).toEqual(['anthropic', 'moonshotai'])
    expect(report.plugins[0]).toMatchObject({ id: 'dice-roller', state: 'active' })
    expect(mock.copied[0]).not.toContain(HINT)
    expect(mock.copied[0]).not.toContain('raw body')
    expect(wrapper.get(`[data-testid="${testIds.aboutCopyDiagnostics}"]`).text()).toContain('Copied')
  })

  it('offers Retry when the server cannot be reached', async () => {
    api.health.get.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Could not reach the server.' }))
    api.providers.list.mockResolvedValue({ items: [] })
    api.plugins.list.mockResolvedValue({ items: [] })
    const wrapper = mountAbout()
    await flushPromises()

    expect(wrapper.text()).toContain('Could not reach the server')
    api.health.get.mockResolvedValue(health)
    await wrapper.get('[data-slot="settings-load-error"] button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('v26.9.0')
  })
})

describe('about rules', () => {
  it('formats the uptime', () => {
    expect(formatUptime(42)).toBe('42s')
    expect(formatUptime(725)).toBe('12m 5s')
    expect(formatUptime(3600)).toBe('1h')
    expect(formatUptime(7950)).toBe('2h 12m')
    expect(formatUptime(2 * 86_400 + 5 * 3600 + 10)).toBe('2d 5h')
    expect(formatUptime(-5)).toBe('0s')
  })

  it('lists Nuxt only when the server knows it', () => {
    expect(versionRows(health).map(row => row.label)).toEqual(['Version', 'Node.js', 'Plugin API', 'AI SDK', 'Hono', 'Nuxt'])
    expect(versionRows({ ...health, versions: { ai: '7', hono: '4' } }).map(row => row.label)).not.toContain('Nuxt')
  })

  it('reports only allow-listed fields', () => {
    const report = buildDiagnostics({
      health: null,
      healthError: 'Could not reach the server.',
      userAgent: 'test-agent',
      providers: [keyed, failing],
      plugins: [],
      generatedAt: 0,
    })
    expect(report.app).toEqual({ error: 'Could not reach the server.' })
    expect(report.browser).toEqual({ userAgent: 'test-agent' })
    expect(report.providers).toEqual([
      { id: 'anthropic', pluginId: 'core-providers', enabled: true, status: 'connected', local: false, modelCount: 3, lastError: null },
      { id: 'moonshotai', pluginId: 'core-providers', enabled: true, status: 'error', local: false, modelCount: 3, lastError: { code: 'auth_invalid', message: 'Invalid Authentication', status: 401 } },
    ])
    const text = diagnosticsText({ health, userAgent: 'x', providers: [keyed], plugins: [], generatedAt: 0 })
    expect(text).not.toContain(HINT)
    expect(text).not.toContain('credentials')
    expect(text).not.toContain('keyUrl')
  })
})
