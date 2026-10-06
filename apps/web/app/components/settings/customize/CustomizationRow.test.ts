import type { CustomizationEntry } from '@harness-forge/shared'
// CustomizationRow (docs/UI.md 9.12, 10.7, 14.2; W10.8-T2): the row's data attributes, name, description and meta
// line, the state badges with the diagnostics list, and the row menu per source (emitted once the menu has closed).
import type { VueWrapper } from '@vue/test-utils'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, provide } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { customizationEntry, customizationId, definitionDiagnostic, pluginSummary, styleEntry, trustCommandItem } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import CustomizationRow from './CustomizationRow.vue'
import { CUSTOMIZE_ROW_CONTEXT } from './customize-context'

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

function mountRow(entry: CustomizationEntry, busy = false) {
  const actions: string[] = []
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h('ul', null, [h(CustomizationRow, { entry, busy, onAction: (action: string) => actions.push(action) })]),
    }),
  })
  wrapper = mount(Host, { attachTo: document.body })
  return { actions, row: () => document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customizationRow}"]`)! }
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

async function openMenu(row: HTMLElement) {
  row.querySelector<HTMLElement>(`[data-testid="${testIds.customizationRowMenu}"]`)!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
}

async function choose(id: string) {
  byTestId(id)!.click()
  await flushPromises()
  await nextTick()
  await flushPromises()
}

const personal = customizationEntry({ name: 'code-reviewer', source: 'user', id: customizationId(1), path: undefined, modelRef: 'mock:echo', tools: ['read_file', 'search_files', 'shell', 'edit_file'] })

describe('customizationRow', () => {
  it('renders a personal agent with its data attributes, name, description and meta line', () => {
    const { row } = mountRow(personal)
    expect(row().tagName).toBe('LI')
    expect(row().dataset).toMatchObject({ kind: 'agent', name: 'code-reviewer', source: 'user', state: 'active', customizationId: customizationId(1) })
    expect(row().dataset.path).toBeUndefined()
    expect(row().textContent).toContain('code-reviewer')
    expect(row().textContent).toContain('Reviews a diff and reports bugs')
    expect(row().textContent).toContain('Personal')
    expect(row().textContent).toContain('mock:echo')
    expect(row().textContent).toContain('4 tools')
    expect(row().querySelector(`[data-testid="${testIds.customizationRowMenu}"]`)?.getAttribute('aria-label')).toBe('Actions for code-reviewer')
  })

  it('shows commands as /name with their argument hint and project paths and plugin ids as data attributes', () => {
    usePluginsStore().items = [pluginSummary({ id: 'db-tools', name: 'DB tools' })]
    const { row } = mountRow(customizationEntry({ kind: 'command', name: 'review', path: '.harness/commands/frontend/review.md', namespace: 'frontend', argumentHint: '<file> [focus]', tools: ['read_file'] }))
    expect(row().dataset).toMatchObject({ kind: 'command', source: 'project', path: '.harness/commands/frontend/review.md' })
    expect(row().textContent).toContain('/review')
    expect(row().textContent).toContain('frontend')
    expect(row().textContent).toContain('Tools limited to 1')
    expect(row().textContent).toContain('<file> [focus]')
    wrapper!.unmount()
    const plugin = mountRow(customizationEntry({ name: 'sql-expert', source: 'plugin', pluginId: 'db-tools', path: undefined, tools: undefined }))
    expect(plugin.row().dataset.pluginId).toBe('db-tools')
    expect(plugin.row().textContent).toContain('DB tools')
    expect(plugin.row().textContent).toContain('All tools')
  })

  it('marks a shadowed row with its badge and the winner as the badge description', () => {
    const { row } = mountRow({ ...personal, state: 'shadowed', shadowedBy: { source: 'project', path: '.harness/agents/code-reviewer.md' } })
    expect(row().dataset.state).toBe('shadowed')
    const badge = [...row().querySelectorAll<HTMLElement>('[aria-describedby]')].find(element => element.textContent?.includes('Shadowed'))!
    expect(document.getElementById(badge.getAttribute('aria-describedby')!)?.textContent).toBe('Not used: the project\'s .harness/agents/code-reviewer.md wins.')
  })

  it('expands the diagnostics of an invalid row as the server wrote them', () => {
    const { row } = mountRow(customizationEntry({
      name: 'broken',
      state: 'invalid',
      diagnostics: [definitionDiagnostic({ level: 'error', code: 'missing-field', message: 'Line 2: Add a description.', line: 2 })],
    }))
    expect(row().textContent).toContain('Invalid')
    const list = row().querySelector<HTMLElement>(`[data-testid="${testIds.customizationDiagnostics}"]`)!
    expect(list.tagName).toBe('UL')
    expect(list.dataset.count).toBe('1')
    expect(list.getAttribute('aria-label')).toBe('Problems in broken')
    expect(list.textContent?.trim()).toBe('Line 2: Add a description.')
  })

  it('toggles the warnings list from the "{n} warnings" badge and shows Off for turned-off rows', async () => {
    const { row } = mountRow(customizationEntry({ diagnostics: [definitionDiagnostic(), definitionDiagnostic({ message: 'Line 5: The key "color" is ignored.', level: 'info' })] }))
    const toggle = [...row().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('1 warning'))!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(row().querySelector(`[data-testid="${testIds.customizationDiagnostics}"]`)).toBeNull()
    toggle.click()
    await nextTick()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(row().querySelector(`[data-testid="${testIds.customizationDiagnostics}"]`)?.textContent).toContain('NotebookEdit')
    wrapper!.unmount()
    const off = mountRow({ ...personal, enabled: false, state: 'off' })
    expect(off.row().dataset.state).toBe('off')
    expect(off.row().textContent).toContain('Off')
  })

  it('offers Edit, Duplicate, Export, Turn off and Delete for personal rows and emits after the menu closes', async () => {
    const { row, actions } = mountRow(personal)
    await openMenu(row())
    expect(byTestId(testIds.customizationEdit)?.textContent?.trim()).toBe('Edit…')
    expect(byTestId(testIds.customizationDuplicate)?.textContent?.trim()).toBe('Duplicate')
    expect(byTestId(testIds.customizationExport)?.textContent?.trim()).toBe('Export .md')
    expect(byTestId(testIds.customizationToggle)?.textContent?.trim()).toBe('Turn off')
    expect(byTestId(testIds.customizationToggle)?.dataset.state).toBe('on')
    expect(byTestId(testIds.customizationDelete)?.textContent?.trim()).toBe('Delete…')
    expect(byTestId(testIds.customizationView)).toBeNull()
    await choose(testIds.customizationEdit)
    expect(actions).toEqual(['edit'])
    await openMenu(row())
    await choose(testIds.customizationToggle)
    await openMenu(row())
    await choose(testIds.customizationDelete)
    expect(actions).toEqual(['edit', 'toggle', 'delete'])
  })

  it('offers View, Copy to personal, Export and Open plugin for the others; built-in commands have no menu', async () => {
    const plugin = mountRow(customizationEntry({ name: 'sql-expert', source: 'plugin', pluginId: 'db-tools', path: undefined }))
    await openMenu(plugin.row())
    expect(byTestId(testIds.customizationView)?.textContent?.trim()).toBe('View…')
    expect(byTestId(testIds.customizationDuplicate)?.textContent?.trim()).toBe('Copy to personal')
    expect(byTestId(testIds.customizationEdit)).toBeNull()
    expect(byTestId(testIds.customizationToggle)).toBeNull()
    const open = document.body.querySelector<HTMLElement>('[data-action="open-plugin"]')!
    expect(open.textContent?.trim()).toBe('Open plugin')
    open.click()
    await flushPromises()
    await nextTick()
    expect(plugin.actions).toEqual(['open-plugin'])
    wrapper!.unmount()
    document.body.replaceChildren()

    const builtin = mountRow({ kind: 'command', name: 'compact', description: 'Summarize', source: 'builtin', enabled: true, state: 'active', diagnostics: [] })
    expect(builtin.row().querySelector(`[data-testid="${testIds.customizationRowMenu}"]`)).toBeNull()
    expect(builtin.row().textContent).toContain('Reserved: a personal or project command can\'t use this name.')
  })

  it('disables Turn off and Delete while the row is busy', async () => {
    const { row } = mountRow(personal, true)
    expect(row().getAttribute('aria-busy')).toBe('true')
    await openMenu(row())
    expect(byTestId(testIds.customizationToggle)?.hasAttribute('data-disabled')).toBe(true)
    expect(byTestId(testIds.customizationDelete)?.hasAttribute('data-disabled')).toBe(true)
  })

  describe('phase 11 rows (W11.8)', () => {
    function mountWithContext(entry: CustomizationEntry, defaults: { global: string, project: string | null, projectName: string | null }, pending = false) {
      const actions: string[] = []
      const Host = defineComponent({
        setup() {
          provide(CUSTOMIZE_ROW_CONTEXT, {
            styleDefaults: computed(() => defaults),
            pendingTrust: () => (pending ? trustCommandItem({ state: 'pending' }) : null),
          })
          return () => h(TooltipProvider, null, {
            default: () => h('ul', null, [h(CustomizationRow, { entry, onAction: (action: string) => actions.push(action) })]),
          })
        },
      })
      wrapper = mount(Host, { attachTo: document.body })
      return { actions, row: () => document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customizationRow}"]`)! }
    }

    it('shows a style by its label with its default badges and offers Use by default', async () => {
      const { row, actions } = mountWithContext(styleEntry({ name: 'terse', label: 'Terse Mode', source: 'user', id: customizationId(3), path: undefined }), { global: 'terse', project: 'terse', projectName: 'website' })
      expect(row().dataset.kind).toBe('style')
      expect(row().textContent).toContain('Terse Mode')
      expect(row().textContent).toContain('terse')
      expect(row().textContent).toContain('Keeps coding instructions')
      expect([...row().querySelectorAll('[data-slot="style-default-badge"]')].map(badge => badge.textContent?.trim())).toEqual(['Your default', 'Default in website'])
      await openMenu(row())
      // Already the project's style: Use by default is disabled.
      expect(byTestId(testIds.customizationSetDefault)?.hasAttribute('data-disabled')).toBe(true)
      wrapper!.unmount()

      const other = mountWithContext(styleEntry({ source: 'builtin', name: 'learning', label: 'Learning', path: undefined }), { global: 'default', project: null, projectName: null })
      expect(other.row().querySelector('[data-slot="style-default-badge"]')).toBeNull()
      await openMenu(other.row())
      const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent?.trim())
      expect(items).toEqual(['View…', 'Copy to personal', 'Export .md', 'Use by default'])
      await choose(testIds.customizationSetDefault)
      expect(other.actions).toEqual(['set-default'])
      expect(actions).toEqual([])
    })

    it('marks a project command whose shell lines wait for approval and offers Review…', async () => {
      const { row, actions } = mountWithContext(customizationEntry({ kind: 'command', name: 'deploy', path: '.harness/commands/deploy.md', tools: undefined }), { global: 'default', project: null, projectName: 'website' }, true)
      expect(row().querySelector('[data-slot="customization-needs-approval"]')?.textContent?.trim()).toBe('Needs approval')
      await openMenu(row())
      expect(document.body.querySelector('[role="menuitem"]')?.textContent?.trim()).toBe('Review…')
      await choose(testIds.customizationReview)
      expect(actions).toEqual(['review'])
    })

    it('shows neither without the page context', () => {
      const { row } = mountRow(styleEntry())
      expect(row().querySelector('[data-slot="style-default-badge"]')).toBeNull()
      expect(row().querySelector('[data-slot="customization-needs-approval"]')).toBeNull()
    })
  })
})
