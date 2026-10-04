import type { CustomizationEntry } from '@harness-forge/shared'
// The agents or skills of a plugin on its detail page (docs/UI.md 8.8, 10.7, 13.11): rows by name with the mono name,
// the description, the agent meta line (model, tools), the Shadowed badge and its tooltip, name-only rows for names
// without a catalog entry, and the "Open in Customize" link to the kind's tab.
import type { VueWrapper } from '@vue/test-utils'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NuxtLinkStub } from '~/components/plugins/list/testing'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { customizationEntry, pluginSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import PluginCustomizationList from './PluginCustomizationList.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

beforeEach(() => {
  mock.api = createMockApi()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

function pluginAgent(overrides: Partial<CustomizationEntry> = {}): CustomizationEntry {
  return customizationEntry({ source: 'plugin', pluginId: 'agent-pack', path: undefined, ...overrides })
}

function mountList(props: { kind: 'agent' | 'skill', entries: readonly CustomizationEntry[], missing?: readonly string[] }) {
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, { delayDuration: 0 }, {
      default: () => h(PluginCustomizationList, { pluginId: 'agent-pack', missing: [], ...props }),
    }),
  })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink: NuxtLinkStub } } })
  return wrapper
}

function rows(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.pluginCustomization}"]`)]
}

function row(name: string): HTMLElement {
  const found = rows().find(element => element.dataset.name === name)
  expect(found, name).toBeDefined()
  return found!
}

function meta(name: string): string | null {
  return row(name).querySelector('[data-slot="plugin-customization-meta"]')?.textContent?.trim() ?? null
}

describe('pluginCustomizationList', () => {
  it('lists the entries and the contributed names without an entry, by name', () => {
    const entry = pluginAgent({ name: 'sql-expert', description: 'Plans SQL migrations', state: 'shadowed', shadowedBy: { source: 'user' } })
    mountList({ kind: 'agent', entries: [entry], missing: ['indexer'] })
    const root = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.pluginCustomizations}"]`)!
    expect(root.dataset.kind).toBe('agent')
    expect(root.dataset.count).toBe('2')
    expect(rows().map(element => [element.dataset.name, element.dataset.state])).toEqual([['indexer', 'active'], ['sql-expert', 'shadowed']])
  })

  it('shows an agent\'s mono name, description, model and tools', () => {
    mountList({
      kind: 'agent',
      entries: [
        pluginAgent({ name: 'sql-expert', description: 'Plans SQL migrations', modelRef: 'anthropic:claude-haiku-5', tools: ['read_file', 'search_files'] }),
        pluginAgent({ name: 'reviewer', description: 'Reviews a diff', modelRef: undefined, tools: undefined }),
        pluginAgent({ name: 'echo', description: 'Answers with the same model', modelRef: 'inherit', tools: ['read_file'] }),
      ],
    })
    expect(rows().map(element => element.dataset.name)).toEqual(['echo', 'reviewer', 'sql-expert'])
    const name = row('sql-expert').querySelector('code')!
    expect(name.textContent).toBe('sql-expert')
    expect(name.className).toContain('font-mono')
    expect(row('sql-expert').textContent).toContain('Plans SQL migrations')
    expect(meta('sql-expert')).toBe('anthropic:claude-haiku-5 · 2 tools')
    expect(meta('reviewer')).toBe('Default model · All tools')
    expect(meta('echo')).toBe('Same as the chat · 1 tool')
    for (const element of rows())
      expect(element.dataset.state).toBe('active')
    expect(document.body.querySelector('[data-slot="plugin-customization-shadowed"]')).toBeNull()
  })

  it('shows skills with the name and the description only', () => {
    mountList({
      kind: 'skill',
      entries: [pluginAgent({ kind: 'skill', name: 'release-notes', description: 'Writes release notes from the git log', tools: undefined })],
    })
    expect(document.body.querySelector<HTMLElement>(`[data-testid="${testIds.pluginCustomizations}"]`)!.dataset.kind).toBe('skill')
    expect(row('release-notes').textContent).toContain('Writes release notes from the git log')
    expect(meta('release-notes')).toBeNull()
  })

  it('renders contributed names without an entry as name-only rows', () => {
    mountList({ kind: 'agent', entries: [pluginAgent({ name: 'sql-expert' })], missing: ['indexer', 'sql-expert'] })
    // A name listed in both shows once, with its entry.
    expect(rows().map(element => element.dataset.name)).toEqual(['indexer', 'sql-expert'])
    expect(row('indexer').textContent?.trim()).toBe('indexer')
    expect(meta('indexer')).toBeNull()
    expect(meta('sql-expert')).toBe('Default model · 2 tools')
  })

  it('marks a shadowed entry with a badge whose tooltip names the winner', async () => {
    usePluginsStore().items = [pluginSummary({ id: 'db-tools', name: 'Database tools' })]
    mountList({
      kind: 'agent',
      entries: [
        pluginAgent({ name: 'reviewer', state: 'shadowed', shadowedBy: { source: 'user' } }),
        pluginAgent({ name: 'sql-expert', state: 'shadowed', shadowedBy: { source: 'plugin', pluginId: 'db-tools' } }),
      ],
    })
    const badge = row('reviewer').querySelector<HTMLElement>('[data-slot="plugin-customization-shadowed"]')!
    expect(badge.textContent?.trim()).toBe('Shadowed')
    expect(badge.getAttribute('tabindex')).toBe('0')
    expect(badge.getAttribute('aria-description')).toBe('Not used: your personal agent wins.')
    expect(row('sql-expert').querySelector('[data-slot="plugin-customization-shadowed"]')!.getAttribute('aria-description'))
      .toBe('Not used: the agent from Database tools wins.')

    badge.focus()
    badge.dispatchEvent(new FocusEvent('focus'))
    await flushPromises()
    await vi.waitFor(() => expect(document.body.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain('Not used: your personal agent wins.'))
  })

  it('links to the kind\'s tab of Settings -> Customize, with a 40px target on coarse pointers', () => {
    mountList({ kind: 'agent', entries: [pluginAgent()] })
    let link = document.body.querySelector<HTMLAnchorElement>('[data-slot="plugin-customizations-open"]')!
    expect(link.textContent?.trim()).toBe('Open in Customize')
    expect(link.getAttribute('href')).toBe('/settings/customize?tab=agents')
    expect(link.className).toContain('pointer-coarse:h-10')
    wrapper!.unmount()
    wrapper = null
    document.body.replaceChildren()

    mountList({ kind: 'skill', entries: [], missing: ['release-notes'] })
    link = document.body.querySelector<HTMLAnchorElement>('[data-slot="plugin-customizations-open"]')!
    expect(link.getAttribute('href')).toBe('/settings/customize?tab=skills')
  })
})
