import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { hookEntry } from '~/utils/testing/fixtures'
import HookSection from './HookSection.vue'

describe('hookSection (P11-0b stub)', () => {
  it('renders its rows and re-emits their actions with the entry', async () => {
    const entry = hookEntry()
    const wrapper = mount(HookSection, { props: { source: 'personal', entries: [entry], busyIds: [] } })
    const root = wrapper.get(`[data-testid="${testIds.hooksSection}"]`)
    expect(root.attributes()).toMatchObject({ 'data-source': 'personal', 'data-count': '1' })
    expect(root.text()).toContain('Personal · 1')
    wrapper.findComponent({ name: 'HookRow' }).vm.$emit('action', 'toggle')
    expect(wrapper.emitted('action')).toEqual([['toggle', entry]])
  })

  it('shows the empty state of a project section and accepts the project props', () => {
    const wrapper = mount(HookSection, { props: { source: 'project', entries: [], projectName: 'website', files: ['.claude/settings.json'], pending: 2, issue: null } })
    expect(wrapper.get(`[data-testid="${testIds.hooksSection}"]`).text()).toContain('In website · 0')
    expect(wrapper.get(`[data-testid="${testIds.hooksEmpty}"]`).attributes('data-source')).toBe('project')
  })
})
