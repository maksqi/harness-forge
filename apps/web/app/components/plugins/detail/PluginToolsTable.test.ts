import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { SelectRoot } from 'reka-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { allByTestId, mountInShell, settle } from '~/components/plugins/list/testing'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { pluginDetail, providerSummary, toolSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import PluginContributions from './PluginContributions.vue'
import PluginToolsTable from './PluginToolsTable.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

const TOOLS = [
  toolSummary({ name: 'roll_dice', title: 'Roll dice', description: 'Roll N dice', policy: 'safe' }),
  toolSummary({ name: 'wipe', description: 'Deletes things', policy: 'always', override: 'allow' }),
  toolSummary({ name: 'dynamic_tool', description: 'Decides per call', policy: null, enabled: false }),
]

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

function row(name: string): HTMLElement {
  const found = allByTestId(testIds.pluginToolRow).find(element => element.dataset.toolName === name)
  expect(found, name).toBeDefined()
  return found!
}

function approvalOf(name: string) {
  return row(name).querySelector<HTMLElement>(`[data-testid="${testIds.pluginToolApproval}"]`)!
}

function switchOf(name: string) {
  return row(name).querySelector<HTMLButtonElement>(`[data-testid="${testIds.pluginToolEnabled}"]`)!
}

async function mountTable(missing: string[] = []) {
  const plugins = usePluginsStore()
  api.tools.list.mockResolvedValue({ items: TOOLS })
  await plugins.fetchTools()
  wrapper = mountInShell({
    setup: () => () => h(PluginToolsTable, { tools: plugins.tools, missing }),
  })
  await settle()
  return wrapper
}

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.toast.error.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  api.tools.update.mockImplementation(async ({ params, body }: { params: { name: string }, body: Record<string, unknown> }) => ({
    ...TOOLS.find(tool => tool.name === params.name)!,
    ...body,
  }))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

describe('pluginToolsTable', () => {
  it('lists name, description, policy, approval and the enabled switch', async () => {
    await mountTable()
    expect(allByTestId(testIds.pluginToolRow).map(item => item.dataset.toolName)).toEqual(['roll_dice', 'wipe', 'dynamic_tool'])
    expect(row('roll_dice').textContent).toContain('Roll dice')
    expect(row('roll_dice').textContent).toContain('Roll N dice')
    const policies = ['roll_dice', 'wipe', 'dynamic_tool'].map(name => row(name).querySelector<HTMLElement>('[data-slot="badge"], [data-variant]:not(button)')?.textContent?.trim())
    expect(policies).toEqual(['Safe', 'Always ask', 'Dynamic'])
    expect(['roll_dice', 'wipe', 'dynamic_tool'].map(name => approvalOf(name).dataset.value)).toEqual(['default', 'allow', 'default'])
    expect(approvalOf('wipe').textContent?.trim()).toBe('Allow')
    expect(['roll_dice', 'wipe', 'dynamic_tool'].map(name => switchOf(name).getAttribute('aria-checked'))).toEqual(['true', 'true', 'false'])
  })

  it('saves the approval override with PATCH /tools/:name (Default clears it)', async () => {
    await mountTable()
    const selects = wrapper!.findAllComponents(SelectRoot)
    selects[0]!.vm.$emit('update:modelValue', 'deny')
    await settle()
    expect(api.tools.update).toHaveBeenLastCalledWith({ params: { name: 'roll_dice' }, body: { override: 'deny' } })
    expect(approvalOf('roll_dice').dataset.value).toBe('deny')

    selects[1]!.vm.$emit('update:modelValue', 'default')
    await settle()
    expect(api.tools.update).toHaveBeenLastCalledWith({ params: { name: 'wipe' }, body: { override: null } })
    expect(approvalOf('wipe').dataset.value).toBe('default')
  })

  it('turns a tool off and rolls back with a toast when saving fails', async () => {
    await mountTable()
    switchOf('roll_dice').click()
    await settle()
    expect(api.tools.update).toHaveBeenLastCalledWith({ params: { name: 'roll_dice' }, body: { enabled: false } })
    expect(switchOf('roll_dice').getAttribute('aria-checked')).toBe('false')

    api.tools.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom' }))
    switchOf('dynamic_tool').click()
    await settle()
    expect(mocks.toast.error).toHaveBeenCalledWith('Something went wrong', { description: 'Boom' })
    expect(switchOf('dynamic_tool').getAttribute('aria-checked')).toBe('false')
  })

  it('lists tools the tools API does not know without controls', async () => {
    await mountTable(['later_tool'])
    expect(row('later_tool').textContent).toContain('Tool settings are not available yet.')
    expect(switchOf('later_tool').disabled).toBe(true)
    expect(approvalOf('later_tool').hasAttribute('disabled') || approvalOf('later_tool').dataset.disabled !== undefined).toBe(true)
  })
})

describe('pluginContributions', () => {
  it('falls back to the registered names when the tool list cannot be loaded', async () => {
    api.tools.list.mockRejectedValue(new HarnessError({ code: 'not_implemented', message: 'Not implemented yet.' }))
    api.commands.list.mockResolvedValue({ items: [{ name: 'roll', description: 'Roll dice from a formula', pluginId: 'dice-roller' }] })
    const plugin = pluginDetail({ contributions: { providers: [], models: 0, tools: ['roll_dice'], mcpServers: [], commands: ['roll', 'reroll'], hooks: ['chat.before'] } })
    wrapper = mountInShell(PluginContributions, { plugin })
    await settle(5)
    expect(row('roll_dice').textContent).toContain('Tool settings are not available yet.')
    expect(document.body.textContent).toContain('/roll')
    expect(document.body.textContent).toContain('Roll dice from a formula')
    expect(document.body.textContent).toContain('/reroll')
    expect(document.body.textContent).toContain('chat.before')
  })

  it('shows providers with status and a link to their key', async () => {
    api.providers.list.mockResolvedValue({ items: [providerSummary({ id: 'fireworks', name: 'Fireworks AI', pluginId: 'fireworks', status: 'not_configured', modelCount: 0 })] })
    api.tools.list.mockResolvedValue({ items: [] })
    const plugin = pluginDetail({ id: 'fireworks', kind: 'declarative', contributions: { providers: ['fireworks'], models: 12, tools: [], mcpServers: [], commands: [], hooks: [] } })
    wrapper = mountInShell(PluginContributions, { plugin })
    await settle(5)
    const provider = document.querySelector<HTMLElement>('[data-provider-id="fireworks"]')!
    expect(provider.textContent).toContain('Fireworks AI')
    expect(provider.querySelector('[data-status="not_configured"]')).not.toBeNull()
    expect(provider.querySelector('a')?.getAttribute('href')).toBe('/settings/providers?configure=fireworks')
    expect(provider.querySelector('a')?.textContent?.trim()).toBe('Add key')
    const manage = Array.from(document.querySelectorAll('a')).find(link => link.textContent?.includes('Manage models'))
    expect(manage?.getAttribute('href')).toBe('/settings/models')
  })
})
