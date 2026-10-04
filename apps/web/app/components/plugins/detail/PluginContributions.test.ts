// The plugin Overview's contribution sections (docs/UI.md 8.8); Phase 10: Agents and Skills after Commands, from the
// global customization catalog (`customizations.catalog(null)`, fetched when the plugin contributes agents or skills).
import type { CustomizationList, PluginContributions as PluginContributionsData, PluginDetail } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, shallowRef } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NuxtLinkStub } from '~/components/plugins/list/testing'
import { useCustomizationsStore } from '~/stores/customizations'
import { testIds } from '~/utils/testids'
import { customizationEntry, customizationList, pluginDetail } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import PluginContributions from './PluginContributions.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const none: PluginContributionsData = { providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [] }

let api: MockApi
/** The plugin the mounted sections show (swapped to simulate a plugin reload). */
const plugin = shallowRef<PluginDetail>(pluginDetail())
const mounted: VueWrapper[] = []

beforeEach(() => {
  api = createMockApi()
  api.tools.list.mockResolvedValue({ items: [] })
  mock.api = api
  setActivePinia(createPinia())
})

afterEach(() => {
  for (const wrapper of mounted.splice(0))
    wrapper.unmount()
  document.body.replaceChildren()
})

/** Mounts the sections inside the app's TooltipProvider; `plugin.value` can be swapped (a plugin reload). */
function mountContributions(contributions: PluginContributionsData) {
  plugin.value = pluginDetail({ id: 'agent-pack', name: 'Agent pack', contributions })
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, { default: () => h(PluginContributions, { plugin: plugin.value }) }),
  })
  const wrapper = mount(Host, { global: { stubs: { NuxtLink: NuxtLinkStub, LazyMcpServersPanel: true } } })
  mounted.push(wrapper)
  return wrapper
}

/** The global catalog: builtin agents, the plugin's agent and skill, another plugin's agent and a personal agent. */
function globalCatalog(): CustomizationList {
  return customizationList({
    project: null,
    items: [
      customizationEntry({ name: 'explore', description: 'Read-only research', source: 'builtin', path: undefined, tools: undefined }),
      customizationEntry({ name: 'reviewer', description: 'My reviewer', source: 'user', path: undefined, id: 'cus_01HZY3K9X2V7N4M8Q6R1T5W0AB' as never }),
      customizationEntry({ name: 'reviewer', description: 'Reviews a diff', source: 'plugin', pluginId: 'agent-pack', path: undefined, tools: undefined, state: 'shadowed', shadowedBy: { source: 'user' } }),
      customizationEntry({ name: 'sql-expert', description: 'Plans SQL migrations', source: 'plugin', pluginId: 'agent-pack', path: undefined, modelRef: 'anthropic:claude-haiku-5' }),
      customizationEntry({ name: 'sql-expert', description: 'Another pack', source: 'plugin', pluginId: 'db-tools', path: undefined, state: 'shadowed', shadowedBy: { source: 'plugin', pluginId: 'agent-pack' } }),
      customizationEntry({ kind: 'skill', name: 'release-notes', description: 'Writes release notes', source: 'plugin', pluginId: 'agent-pack', path: undefined, tools: undefined }),
    ],
  })
}

function rowsOf(wrapper: ReturnType<typeof mountContributions>, kind: 'agent' | 'skill') {
  return wrapper.get(`[data-testid="${testIds.pluginCustomizations}"][data-kind="${kind}"]`)
    .findAll(`[data-testid="${testIds.pluginCustomization}"]`)
}

describe('pluginContributions: agents and skills (Phase 10)', () => {
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

  it('shows no agent or skill section without such contributions, and does not load the catalog', async () => {
    const wrapper = mountContributions({ ...none, tools: ['roll_dice'] })
    await flushPromises()
    expect(wrapper.find(`[data-testid="${testIds.pluginCustomizations}"]`).exists()).toBe(false)
    expect(api.customizations.list).not.toHaveBeenCalled()
  })

  it('loads the global catalog and shows the plugin\'s own entries only, name-only rows while it loads', async () => {
    let answer!: (list: CustomizationList) => void
    api.customizations.list.mockImplementation(() => new Promise<CustomizationList>((resolve) => {
      answer = resolve
    }))
    const wrapper = mountContributions({ ...none, agents: ['reviewer', 'sql-expert'], skills: ['release-notes'] })
    await flushPromises()
    expect(api.customizations.list).toHaveBeenCalledTimes(1)
    expect(api.customizations.list).toHaveBeenCalledWith({ query: {} })
    // While the catalog loads: the contributed names only.
    expect(rowsOf(wrapper, 'agent').map(row => [row.attributes('data-name'), row.text()])).toEqual([['reviewer', 'reviewer'], ['sql-expert', 'sql-expert']])
    expect(rowsOf(wrapper, 'skill').map(row => row.attributes('data-name'))).toEqual(['release-notes'])

    answer(globalCatalog())
    await flushPromises()
    const agents = rowsOf(wrapper, 'agent')
    expect(agents.map(row => [row.attributes('data-name'), row.attributes('data-state')])).toEqual([['reviewer', 'shadowed'], ['sql-expert', 'active']])
    expect(agents[0]!.text()).toContain('Reviews a diff')
    expect(agents[0]!.text()).not.toContain('My reviewer')
    expect(agents[1]!.text()).toContain('Plans SQL migrations')
    expect(agents[1]!.text()).toContain('anthropic:claude-haiku-5 · 2 tools')
    expect(wrapper.text()).not.toContain('Another pack')
    expect(rowsOf(wrapper, 'skill')[0]!.text()).toContain('Writes release notes')
    // The section counts follow the rows.
    const headings = wrapper.findAll('[data-slot="plugin-detail-section"] h2').map(heading => heading.text())
    expect(headings).toEqual(['Agents 2', 'Skills 1'])
  })

  it('reuses a fresh global catalog and keeps the names when the catalog cannot be loaded', async () => {
    api.customizations.list.mockResolvedValueOnce(globalCatalog())
    const first = mountContributions({ ...none, skills: ['release-notes'] })
    await flushPromises()
    expect(rowsOf(first, 'skill')[0]!.text()).toContain('Writes release notes')

    const second = mountContributions({ ...none, agents: ['sql-expert'] })
    await flushPromises()
    expect(api.customizations.list).toHaveBeenCalledTimes(1)
    expect(rowsOf(second, 'agent')[0]!.text()).toContain('Plans SQL migrations')
    for (const wrapper of mounted.splice(0))
      wrapper.unmount()

    setActivePinia(createPinia())
    api.customizations.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    const failed = mountContributions({ ...none, agents: ['sql-expert'] })
    await flushPromises()
    expect(api.customizations.list).toHaveBeenCalledTimes(2)
    expect(rowsOf(failed, 'agent').map(row => row.text())).toEqual(['sql-expert'])
  })

  it('loads the catalog again when a reload adds agents to the plugin', async () => {
    api.customizations.list.mockResolvedValue(globalCatalog())
    const wrapper = mountContributions({ ...none, agents: ['sql-expert'] })
    await flushPromises()
    expect(api.customizations.list).toHaveBeenCalledTimes(1)
    // A plugin.changed event marks the catalog stale; the new contributions fetch it again.
    useCustomizationsStore().applyEvent(createServerEvent('plugin.changed', { id: 'agent-pack', plugin: null }))
    plugin.value = pluginDetail({ id: 'agent-pack', name: 'Agent pack', contributions: { ...none, agents: ['reviewer', 'sql-expert'] } })
    await flushPromises()
    expect(api.customizations.list.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(rowsOf(wrapper, 'agent').map(row => row.attributes('data-name'))).toEqual(['reviewer', 'sql-expert'])
    expect(rowsOf(wrapper, 'agent')[0]!.text()).toContain('Reviews a diff')
  })

  it('explains why a shadowed plugin agent is not used', async () => {
    api.customizations.list.mockResolvedValue(globalCatalog())
    const wrapper = mountContributions({ ...none, agents: ['reviewer'] })
    await flushPromises()
    expect(wrapper.get('[data-slot="plugin-customization-shadowed"]').attributes('aria-description')).toBe('Not used: your personal agent wins.')
  })
})
