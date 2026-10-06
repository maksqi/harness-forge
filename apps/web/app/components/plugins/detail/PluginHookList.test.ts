import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { hookEntry } from '~/utils/testing/fixtures'
import PluginHookList from './PluginHookList.vue'

describe('pluginHookList (P11-0b stub)', () => {
  it('lists the command hooks, then the code hooks', () => {
    const entry = hookEntry({ key: 'plugin:hook-pack:0', source: 'plugin', id: undefined, pluginId: 'hook-pack', event: 'PreToolUse', matcher: 'Bash', command: 'sh hooks/guard.sh' })
    const wrapper = mount(PluginHookList, { props: { entries: [entry], codeHooks: ['prompt.submit'] } })
    expect(wrapper.get(`[data-testid="${testIds.pluginHooks}"]`).attributes('data-count')).toBe('2')
    const rows = wrapper.findAll(`[data-testid="${testIds.pluginHook}"]`)
    expect(rows.map(row => [row.attributes('data-event'), row.attributes('data-kind')])).toEqual([['PreToolUse', 'command'], ['prompt.submit', 'code']])
  })
})
