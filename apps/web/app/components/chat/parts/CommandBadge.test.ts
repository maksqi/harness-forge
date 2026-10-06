import type { CommandInvocation } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MODEL_LABEL_RESOLVER } from '~/components/providers/model-label'
import { usePluginsStore } from '~/stores/plugins'
import { commandSummary, pluginSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import CommandBadge from './CommandBadge.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => vi.fn() }))

function badge(command: CommandInvocation | null, resolve = true) {
  return mount({
    render: () => h(TooltipProvider, { delayDuration: 0 }, { default: () => h(CommandBadge, { name: command?.name ?? 'review', command, class: 'mb-1.5' }) }),
  }, {
    attachTo: document.body,
    global: { provide: resolve ? { [MODEL_LABEL_RESOLVER as symbol]: (ref: string) => (ref === 'openai:gpt-6' ? { name: 'GPT-6' } : null) } : {} },
  })
}

function invocation(overrides: Partial<CommandInvocation> = {}): CommandInvocation {
  return { name: 'review', input: 'src/auth.ts', type: 'prompt', ...overrides }
}

beforeEach(() => {
  mock.api = createMockApi()
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('commandBadge', () => {
  it('names a skill invocation "Skill" (Phase 11: the invocation\'s kind, or the kind prop)', () => {
    const wrapper = badge(invocation({ name: 'deploy', kind: 'skill' }))
    expect(wrapper.get('[data-slot="command-badge"]').text()).toBe('Skill/deploy')
    wrapper.unmount()
    const explicit = mount(CommandBadge, { props: { name: 'deploy', kind: 'skill' } })
    expect(explicit.get('[data-slot="command-badge"]').text()).toBe('Skill/deploy')
  })

  it('stays a plain badge without a command (share pages) or a command from before v1.6', () => {
    for (const command of [null, invocation()]) {
      const wrapper = badge(command)
      const root = wrapper.get('[data-slot="command-badge"]')
      expect(root.text()).toBe('Command/review')
      expect(root.attributes('tabindex')).toBeUndefined()
      expect(root.classes()).toContain('mb-1.5')
      wrapper.unmount()
    }
  })

  it('shows the model of a command that runs on its own model, and lists source, model and tools for screen readers', () => {
    const wrapper = badge(invocation({ source: 'project', modelRef: 'openai:gpt-6', allowedTools: ['read_file', 'search_files'] }))
    const root = wrapper.get('[data-slot="command-badge"]')
    expect(root.attributes('tabindex')).toBe('0')
    expect(root.classes()).toContain('mb-1.5')
    expect(root.get('[data-slot="command-badge-model"]').text()).toBe('· GPT-6')
    expect(root.text()).toContain('/review')
    expect(root.text()).toContain(', Project command, Runs on GPT-6, Tools limited to read_file, search_files')
  })

  it('shows the source, the model and the tools in its tooltip on focus', async () => {
    vi.useFakeTimers()
    const wrapper = badge(invocation({ source: 'user', modelRef: 'anthropic:claude-sonnet-5' }), false)
    const root = wrapper.get('[data-slot="command-badge"]')
    // Without a resolver the model id stands in for its name.
    expect(root.get('[data-slot="command-badge-model"]').text()).toBe('· claude-sonnet-5')
    await root.trigger('focus')
    await vi.advanceTimersByTimeAsync(10)
    await flushPromises()
    expect(document.querySelector('[data-slot="command-badge-source"]')?.textContent).toBe('Personal command')
    expect(document.querySelector('[data-slot="command-badge-runs-on"]')?.textContent).toBe('Runs on claude-sonnet-5')
    expect(document.querySelector('[data-slot="command-badge-tools"]')).toBeNull()
    wrapper.unmount()
  })

  it('names the plugin of a plugin command from the plugins store', () => {
    const plugins = usePluginsStore()
    plugins.items = [pluginSummary({ id: 'summaries', name: 'Summaries' })]
    plugins.commands = [commandSummary({ name: 'tldr', pluginId: 'summaries' })]
    const wrapper = badge(invocation({ name: 'tldr', source: 'plugin' }))
    expect(wrapper.get('[data-slot="command-badge"]').text()).toContain(', From Summaries')
    wrapper.unmount()

    const unknown = badge(invocation({ name: 'other', source: 'plugin' }))
    expect(unknown.get('[data-slot="command-badge"]').text()).toContain(', From a plugin')
  })

  it('reads the built-in source of a harness command', () => {
    const wrapper = badge(invocation({ name: 'compact', type: 'compact', source: 'harness' }))
    expect(wrapper.get('[data-slot="command-badge"]').text()).toContain(', Built-in command')
  })
})
