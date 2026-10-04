import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { customizationEntry } from '~/utils/testing/fixtures'
import PluginCustomizationList from './PluginCustomizationList.vue'

describe('pluginCustomizationList (P10-0b stub)', () => {
  it('lists the entries and the contributed names without an entry, by name', () => {
    const entry = customizationEntry({ name: 'sql-expert', description: 'Plans SQL migrations', source: 'plugin', pluginId: 'db-tools', path: undefined, state: 'shadowed' })
    const wrapper = mount(PluginCustomizationList, { props: { kind: 'agent', pluginId: 'db-tools', entries: [entry], missing: ['indexer'] } })
    const root = wrapper.get(`[data-testid="${testIds.pluginCustomizations}"]`)
    expect(root.attributes()).toMatchObject({ 'data-kind': 'agent', 'data-count': '2' })
    expect(wrapper.findAll(`[data-testid="${testIds.pluginCustomization}"]`).map(row => [row.attributes('data-name'), row.attributes('data-state')]))
      .toEqual([['indexer', 'active'], ['sql-expert', 'shadowed']])
  })
})
