import type { PluginContributions as PluginContributionsData } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCustomizationsStore } from '~/stores/customizations'
import { testIds } from '~/utils/testids'
import { customizationEntry, customizationList, pluginDetail } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import PluginContributions from './PluginContributions.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const none: PluginContributionsData = { providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [] }

beforeEach(() => {
  const api = createMockApi()
  api.tools.list.mockResolvedValue({ items: [] })
  mock.api = api
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.replaceChildren()
})

function mountContributions(contributions: PluginContributionsData) {
  return mount(PluginContributions, {
    props: { plugin: pluginDetail({ id: 'agent-pack', name: 'Agent pack', contributions }) },
    global: { stubs: { NuxtLink: { template: '<a><slot /></a>' }, LazyMcpServersPanel: true } },
  })
}

describe('pluginContributions: agents and skills (Phase 10 seam)', () => {
  it('lists the contributed agents and skills after Commands, from the global catalog or by name', async () => {
    useCustomizationsStore().catalogs = {
      '': customizationList({
        project: null,
        items: [customizationEntry({ name: 'sql-expert', description: 'Plans SQL migrations', source: 'plugin', pluginId: 'agent-pack', path: undefined })],
      }),
    }
    const wrapper = mountContributions({ ...none, commands: ['tldr'], agents: ['sql-expert'], skills: ['release-notes'] })
    await flushPromises()
    const lists = wrapper.findAll(`[data-testid="${testIds.pluginCustomizations}"]`)
    expect(lists.map(list => [list.attributes('data-kind'), list.attributes('data-count')])).toEqual([['agent', '1'], ['skill', '1']])
    expect(lists[0]!.text()).toContain('Plans SQL migrations')
    expect(lists[1]!.get(`[data-testid="${testIds.pluginCustomization}"]`).attributes('data-name')).toBe('release-notes')
    expect(wrapper.text()).toContain('Sub-agents the main agent can start.')
    expect(wrapper.text()).toContain('Instructions the agent loads when a task needs them.')
    const text = wrapper.text()
    expect(text.indexOf('Commands')).toBeLessThan(text.indexOf('Agents'))
    expect(text.indexOf('Agents')).toBeLessThan(text.indexOf('Skills'))
  })

  it('shows no agent or skill section without such contributions', async () => {
    const wrapper = mountContributions({ ...none, tools: ['roll_dice'] })
    await flushPromises()
    expect(wrapper.find(`[data-testid="${testIds.pluginCustomizations}"]`).exists()).toBe(false)
  })
})
