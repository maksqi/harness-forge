import type { ToolSummary } from '@harness-forge/shared'
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

async function mountTable(missing: string[] = [], tools: ToolSummary[] = TOOLS) {
  const plugins = usePluginsStore()
  api.tools.list.mockResolvedValue({ items: tools })
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
    // A policy function (policy null) is decided per call (Phase 9; was "Dynamic").
    expect(policies).toEqual(['Safe', 'Always ask', 'Decided per call'])
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

  it('offers no Allow where the server refuses it and shows a stale allow as Default (Phase 9)', async () => {
    const tools = [
      toolSummary({ name: 'exit_plan_mode', pluginId: 'core-agent', policy: 'always' }),
      toolSummary({ name: 'shell', pluginId: 'core-workspace', policy: null, workspace: 'execute', override: 'allow' }),
      toolSummary({ name: 'write_file', pluginId: 'core-workspace', policy: 'ask', workspace: 'write', override: 'allow' }),
    ]
    api.tools.update.mockImplementation(async ({ params, body }: { params: { name: string }, body: Record<string, unknown> }) => ({
      ...tools.find(tool => tool.name === params.name)!,
      ...body,
    }))
    await mountTable([], tools)
    expect(row('shell').querySelector('[data-value="dynamic"]')?.textContent?.trim()).toBe('Decided per call')
    // The effective override: the approval ignores an allow on an execute tool.
    expect(['exit_plan_mode', 'shell', 'write_file'].map(name => approvalOf(name).dataset.value)).toEqual(['default', 'default', 'allow'])

    async function options(name: string): Promise<Array<string | undefined>> {
      approvalOf(name).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await settle()
      const values = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].map(item => item.dataset.value)
      document.body.querySelector('[data-slot="select-content"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await settle()
      return values
    }
    expect(await options('shell')).toEqual(['default', 'ask', 'deny'])
    expect(await options('exit_plan_mode')).toEqual(['default', 'ask', 'deny'])
    expect(await options('write_file')).toEqual(['default', 'allow', 'ask', 'deny'])

    // A stray allow never reaches the server; Ask replaces the stale override.
    const selects = wrapper!.findAllComponents(SelectRoot)
    selects[0]!.vm.$emit('update:modelValue', 'allow')
    selects[1]!.vm.$emit('update:modelValue', 'allow')
    await settle()
    expect(api.tools.update).not.toHaveBeenCalled()
    selects[1]!.vm.$emit('update:modelValue', 'ask')
    await settle()
    expect(api.tools.update).toHaveBeenLastCalledWith({ params: { name: 'shell' }, body: { override: 'ask' } })
    expect(approvalOf('shell').dataset.value).toBe('ask')
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
