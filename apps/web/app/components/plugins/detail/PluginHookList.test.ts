// PluginHookList (docs/UI.md 8.8, 10.8, 13.12; W11.8-T9): the command hooks of a plugin (event, matcher or "All tools",
// the command in mono, the trust note) in event order, its code hooks as chips, and the link to the Hooks tab.
import type { VueWrapper } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { NuxtLinkStub } from '~/components/plugins/list/testing'
import { testIds } from '~/utils/testids'
import { hookEntry } from '~/utils/testing/fixtures'
import PluginHookList from './PluginHookList.vue'

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

function pluginHook(overrides: Parameters<typeof hookEntry>[0] = {}) {
  return hookEntry({ key: 'plugin:hook-pack:0', source: 'plugin', id: undefined, pluginId: 'hook-pack', ...overrides })
}

function mountList(props: { entries: ReturnType<typeof hookEntry>[], codeHooks: string[] }) {
  wrapper = mount(PluginHookList, { props, global: { stubs: { NuxtLink: NuxtLinkStub } } })
  return wrapper
}

describe('pluginHookList', () => {
  it('lists the command hooks in event order with the trust note, then the code hooks as chips', () => {
    const stop = pluginHook({ key: 'plugin:hook-pack:1', event: 'Stop', matcher: null, command: 'sh "$HARNESS_PLUGIN_ROOT/stop.sh"' })
    const guard = pluginHook({ event: 'PreToolUse', matcher: 'Bash', command: 'sh hooks/guard.sh' })
    const all = pluginHook({ key: 'plugin:hook-pack:2', event: 'PostToolUse', matcher: null, command: 'sh hooks/fmt.sh' })
    const list = mountList({ entries: [stop, guard, all], codeHooks: ['run.stop', 'prompt.submit'] })
    expect(list.get(`[data-testid="${testIds.pluginHooks}"]`).attributes('data-count')).toBe('5')
    const rows = list.findAll(`[data-testid="${testIds.pluginHook}"]`)
    expect(rows.map(row => [row.attributes('data-event'), row.attributes('data-kind')])).toEqual([
      ['PreToolUse', 'command'],
      ['PostToolUse', 'command'],
      ['Stop', 'command'],
      ['prompt.submit', 'code'],
      ['run.stop', 'code'],
    ])
    expect(rows[0]!.text()).toContain('Bash')
    expect(rows[0]!.text()).toContain('sh hooks/guard.sh')
    expect(rows[1]!.text()).toContain('All tools')
    expect(rows[2]!.text()).not.toContain('All tools')
    expect(list.get('[data-slot="plugin-hooks-trust-note"]').text()).toBe('Runs only while you trust this plugin.')
    expect(list.get('[data-slot="plugin-hooks-open"]').attributes('href')).toBe('/settings/customize?tab=hooks')
  })

  it('shows only the chips of a plugin with code hooks', () => {
    const list = mountList({ entries: [], codeHooks: ['prompt.submit'] })
    expect(list.get(`[data-testid="${testIds.pluginHooks}"]`).attributes('data-count')).toBe('1')
    expect(list.find('[data-slot="plugin-hooks-trust-note"]').exists()).toBe(false)
    expect(list.get(`[data-testid="${testIds.pluginHook}"]`).attributes('data-kind')).toBe('code')
  })

  it('shows a prompt hook with its prompt and data-kind="prompt"; prompt hooks alone need no trust note (Phase 12)', () => {
    const prompt = pluginHook({ key: 'plugin:review-kit:0', pluginId: 'review-kit', event: 'Stop', matcher: null, type: 'prompt', command: '', prompt: 'Did the tests run and pass?' })
    const list = mountList({ entries: [prompt], codeHooks: [] })
    const row = list.get(`[data-testid="${testIds.pluginHook}"]`)
    expect(row.attributes('data-kind')).toBe('prompt')
    expect(row.text()).toContain('Did the tests run and pass?')
    expect(row.text()).toContain('Prompt')
    expect(row.find('code').exists()).toBe(false)
    expect(list.find('[data-slot="plugin-hooks-trust-note"]').exists()).toBe(false)

    const command = pluginHook({ key: 'plugin:review-kit:1', pluginId: 'review-kit', event: 'PostToolUse', command: 'sh hooks/format.sh' })
    const both = mountList({ entries: [prompt, command], codeHooks: [] })
    expect(both.findAll(`[data-testid="${testIds.pluginHook}"]`).map(item => item.attributes('data-kind'))).toEqual(['command', 'prompt'])
    expect(both.find('[data-slot="plugin-hooks-trust-note"]').exists()).toBe(true)
  })
})
