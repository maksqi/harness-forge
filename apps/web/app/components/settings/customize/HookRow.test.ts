import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { codeHookEntry, hookEntry, hookId, trustSha } from '~/utils/testing/fixtures'
import HookRow from './HookRow.vue'

describe('hookRow (P11-0b stub)', () => {
  it('renders a personal command hook with its id', () => {
    const wrapper = mount(HookRow, { props: { entry: hookEntry(), busy: true } })
    const root = wrapper.get(`[data-testid="${testIds.hookRow}"]`)
    expect(root.attributes()).toMatchObject({
      'data-source': 'personal',
      'data-event': 'PostToolUse',
      'data-kind': 'command',
      'data-state': 'active',
      'data-hook-id': hookId(1),
      'aria-busy': 'true',
    })
    expect(root.attributes('data-path')).toBeUndefined()
    expect(root.text()).toContain('sh .claude/hooks/format.sh')
  })

  it('renders a project hook with its path and a plugin code hook with its plugin', () => {
    const project = mount(HookRow, { props: { entry: hookEntry({ source: 'project', id: undefined, state: 'pending', path: '.claude/settings.json', sha256: trustSha(1) }) } })
    expect(project.get(`[data-testid="${testIds.hookRow}"]`).attributes()).toMatchObject({ 'data-source': 'project', 'data-path': '.claude/settings.json', 'data-state': 'pending' })
    const plugin = mount(HookRow, { props: { entry: codeHookEntry() } })
    expect(plugin.get(`[data-testid="${testIds.hookRow}"]`).attributes()).toMatchObject({ 'data-kind': 'code', 'data-event': 'prompt.submit', 'data-plugin-id': 'hook-pack' })
  })
})
