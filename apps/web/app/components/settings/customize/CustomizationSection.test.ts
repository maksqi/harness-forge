// CustomizationSection (docs/UI.md 9.12, 10.7; W10.8-T2): the heading with its count and folders, the rows, the empty
// states of the personal and project sections, the unavailable folder, the slots and the action chain.
import type { VueWrapper } from '@vue/test-utils'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { customizationEntry, customizationId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import CustomizationSection from './CustomizationSection.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => createMockApi() }))

let wrapper: VueWrapper | null = null

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

function mountSection(props: Record<string, unknown>, slots: Record<string, () => unknown> = {}) {
  const actions: Array<[string, string]> = []
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(CustomizationSection, {
        ...props,
        onAction: (action: string, entry: { name: string }) => {
          actions.push([action, entry.name])
        },
      } as never, slots),
    }),
  })
  wrapper = mount(Host, { attachTo: document.body })
  return { actions, section: () => document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customizeSection}"]`)! }
}

describe('customizationSection', () => {
  it('titles the project section, lists its folders and rows, and re-emits row actions with the entry', async () => {
    const { section, actions } = mountSection({
      source: 'project',
      kind: 'agent',
      entries: [customizationEntry(), customizationEntry({ name: 'test-writer', path: '.claude/agents/test-writer.md' })],
      projectName: 'harness-forge',
      folders: ['.claude/agents', '.harness/agents'],
    })
    expect(section().dataset).toMatchObject({ source: 'project', count: '2' })
    expect(section().querySelector('h2')?.textContent?.trim()).toBe('In harness-forge · 2')
    expect(section().textContent).toContain('.claude/agents · .harness/agents')
    expect(section().querySelectorAll(`ul > [data-testid="${testIds.customizationRow}"]`)).toHaveLength(2)
    section().querySelector<HTMLElement>(`[data-testid="${testIds.customizationRowMenu}"]`)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customizationView}"]`)!.click()
    await flushPromises()
    await nextTick()
    expect(actions).toEqual([['view', 'reviewer']])
  })

  it('shows the personal empty state with the parent\'s buttons', () => {
    const { section } = mountSection({ source: 'user', kind: 'command', entries: [] }, { 'empty-actions': () => h('button', { 'data-action': 'new' }, 'New command') })
    expect(section().querySelector('h2')?.textContent?.trim()).toBe('Personal · 0')
    const empty = section().querySelector<HTMLElement>(`[data-testid="${testIds.customizeEmpty}"]`)!
    expect(empty.dataset).toMatchObject({ kind: 'command', source: 'user' })
    expect(empty.textContent).toContain('No personal commands yet. A command is a saved prompt you run with /name.')
    expect(empty.querySelector('[data-action="new"]')).not.toBeNull()
  })

  it('shows the project empty state, or the unavailable folder instead of the rows', () => {
    const empty = mountSection({ source: 'project', kind: 'skill', entries: [], projectName: 'notes' })
    expect(empty.section().textContent).toContain('No skills in notes. Add a folder with a SKILL.md to .harness/skills/ (or .claude/skills/) in the project folder.')
    wrapper!.unmount()
    const missing = mountSection({ source: 'project', kind: 'agent', entries: [customizationEntry()], projectName: 'notes', issue: 'The project folder is unavailable: it does not exist.' })
    expect(missing.section().dataset.count).toBe('0')
    expect(missing.section().querySelector('[role="alert"]')?.textContent).toContain('The project folder is unavailable: it does not exist.')
    expect(missing.section().querySelector(`[data-testid="${testIds.customizationRow}"]`)).toBeNull()
    expect(missing.section().querySelector(`[data-testid="${testIds.customizeEmpty}"]`)).toBeNull()
  })

  it('renders folder notices, marks busy rows and titles the plugin and built-in sections', () => {
    const busy = mountSection(
      { source: 'user', kind: 'agent', entries: [customizationEntry({ source: 'user', id: customizationId(1), path: undefined })], busyIds: [customizationId(1)] },
      { notices: () => h('p', { 'data-slot': 'notice' }, '.claude/agents is a link.') },
    )
    expect(busy.section().querySelector('[data-slot="notice"]')).not.toBeNull()
    expect(busy.section().querySelector(`[data-testid="${testIds.customizationRow}"]`)?.getAttribute('aria-busy')).toBe('true')
    wrapper!.unmount()
    expect(mountSection({ source: 'plugin', kind: 'agent', entries: [] }).section().querySelector('h2')?.textContent?.trim()).toBe('From plugins · 0')
    wrapper!.unmount()
    const builtin = mountSection({ source: 'builtin', kind: 'agent', entries: [] })
    expect(builtin.section().querySelector('h2')?.textContent?.trim()).toBe('Built-in · 0')
    expect(builtin.section().querySelector(`[data-testid="${testIds.customizeEmpty}"]`)).toBeNull()
  })
})
