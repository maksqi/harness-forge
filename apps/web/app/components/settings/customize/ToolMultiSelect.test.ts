// ToolMultiSelect (docs/UI.md 9.12, 10.7; W10.8-T3): the trigger with the editor's test id and the count, the
// options grouped by plugin (MCP tools by server) with their checked state, the chips (unknown names as warning chips)
// with their remove buttons, and the 64-tool cap.
import type { VueWrapper } from '@vue/test-utils'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { pluginSummary, toolSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ToolMultiSelect from './ToolMultiSelect.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => createMockApi() }))

let wrapper: VueWrapper | null = null

const tools = [
  toolSummary({ name: 'read_file', pluginId: 'core-workspace' }),
  toolSummary({ name: 'search_files', pluginId: 'core-workspace' }),
  toolSummary({ name: 'roll_dice', pluginId: 'dice-roller' }),
  toolSummary({ name: 'mcp__github__issues', pluginId: undefined, mcpServerId: 'mcp_github' }),
]

beforeEach(() => {
  setActivePinia(createPinia())
  const plugins = usePluginsStore()
  plugins.items = [pluginSummary({ id: 'core-workspace', name: 'Workspace' }), pluginSummary({ id: 'dice-roller', name: 'Dice roller' })]
  plugins.mcp = [{ id: 'mcp_github', name: 'GitHub' } as (typeof plugins.mcp)[number]]
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

function mountPicker(initial: string[] | null, options: { tools?: typeof tools } = {}) {
  const value = ref<string[] | null>(initial)
  const updates: Array<string[] | null> = []
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(ToolMultiSelect, {
        'modelValue': value.value,
        'tools': options.tools ?? tools,
        'label': 'Tools',
        'data-testid': testIds.customizationTools,
        'onUpdate:modelValue': (next: string[] | null) => {
          updates.push(next)
          value.value = next
        },
      }),
    }),
  })
  wrapper = mount(Host, { attachTo: document.body })
  return { value, updates }
}

function trigger(): HTMLElement {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customizationTools}"]`)!
}

function chips(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.customizationToolChip}"]`)]
}

function options(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.customizationToolOption}"]`)]
}

async function open() {
  trigger().click()
  await flushPromises()
}

describe('toolMultiSelect', () => {
  it('puts the editor\'s test id on the trigger with the count, and shows the chosen tools as chips', () => {
    mountPicker(['read_file', 'Task'])
    expect(trigger().tagName).toBe('BUTTON')
    expect(trigger().dataset.count).toBe('2')
    expect(trigger().textContent).toContain('2 tools chosen')
    expect(chips().map(chip => [chip.dataset.toolName, chip.dataset.state])).toEqual([['read_file', 'known'], ['Task', 'unknown']])
    expect(chips()[1]!.textContent).toContain('Task, not available now')
    expect(chips()[0]!.querySelector('button')?.getAttribute('aria-label')).toBe('Remove read_file')
  })

  it('lists the tools grouped by plugin and MCP server, checked when chosen, and toggles them', async () => {
    const { updates } = mountPicker(['read_file'])
    await open()
    const text = document.body.textContent ?? ''
    // Groups by name: Dice roller, MCP: GitHub, Workspace.
    expect(text.indexOf('Dice roller')).toBeLessThan(text.indexOf('MCP: GitHub'))
    expect(text.indexOf('MCP: GitHub')).toBeLessThan(text.indexOf('Workspace'))
    expect(options().map(option => [option.dataset.toolName, option.dataset.state])).toEqual([
      ['roll_dice', 'unchecked'],
      ['mcp__github__issues', 'unchecked'],
      ['read_file', 'checked'],
      ['search_files', 'unchecked'],
    ])
    options().find(option => option.dataset.toolName === 'search_files')!.click()
    await flushPromises()
    expect(updates.at(-1)).toEqual(['read_file', 'search_files'])
    options().find(option => option.dataset.toolName === 'read_file')!.click()
    await flushPromises()
    expect(updates.at(-1)).toEqual(['search_files'])
  })

  it('removes a chip and starts from no tool for null', async () => {
    const { updates } = mountPicker(['read_file', 'roll_dice'])
    chips()[0]!.querySelector('button')!.click()
    await flushPromises()
    expect(updates).toEqual([['roll_dice']])
    wrapper!.unmount()
    mountPicker(null)
    expect(trigger().dataset.count).toBe('0')
    expect(trigger().textContent).toContain('Choose tools…')
    expect(chips()).toHaveLength(0)
  })

  it('stops at 64 tools: the other options are disabled', async () => {
    const many = Array.from({ length: 65 }, (_, index) => toolSummary({ name: `tool_${String(index).padStart(2, '0')}`, pluginId: 'dice-roller' }))
    mountPicker(many.slice(0, 64).map(tool => tool.name), { tools: many })
    await open()
    const last = options().find(option => option.dataset.toolName === 'tool_64')!
    expect(last.hasAttribute('data-disabled')).toBe(true)
    expect(options().find(option => option.dataset.toolName === 'tool_00')!.hasAttribute('data-disabled')).toBe(false)
  })
})
