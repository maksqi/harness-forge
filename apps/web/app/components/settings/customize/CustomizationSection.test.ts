import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { customizationEntry } from '~/utils/testing/fixtures'
import CustomizationSection from './CustomizationSection.vue'

describe('customizationSection (P10-0b stub)', () => {
  it('renders its root with the source and the count, a row per entry, and re-emits row actions', async () => {
    const entry = customizationEntry()
    const wrapper = mount(CustomizationSection, {
      props: { source: 'project', kind: 'agent', entries: [entry], projectName: 'harness-forge', folders: ['.harness/agents'], busyIds: [] },
    })
    const root = wrapper.get(`[data-testid="${testIds.customizeSection}"]`)
    expect(root.attributes()).toMatchObject({ 'data-source': 'project', 'data-count': '1' })
    expect(root.text()).toContain('In harness-forge · 1')
    expect(wrapper.findAll(`[data-testid="${testIds.customizationRow}"]`)).toHaveLength(1)
    wrapper.findComponent({ name: 'CustomizationRow' }).vm.$emit('action', 'view')
    expect(wrapper.emitted('action')).toEqual([['view', entry]])
  })

  it('shows the empty state of a personal section, and the issue instead of the rows', () => {
    const empty = mount(CustomizationSection, { props: { source: 'user', kind: 'command', entries: [] } })
    const state = empty.get(`[data-testid="${testIds.customizeEmpty}"]`)
    expect(state.attributes()).toMatchObject({ 'data-kind': 'command', 'data-source': 'user' })
    expect(state.text()).toBe('No personal commands yet. A command is a saved prompt you run with /name.')
    const unavailable = mount(CustomizationSection, { props: { source: 'project', kind: 'agent', entries: [], issue: 'The project folder is unavailable.' } })
    expect(unavailable.find(`[data-testid="${testIds.customizeEmpty}"]`).exists()).toBe(false)
    expect(unavailable.get('[role="alert"]').text()).toBe('The project folder is unavailable.')
  })
})
