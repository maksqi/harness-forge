import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { customizationEntry, customizationId } from '~/utils/testing/fixtures'
import CustomizationRow from './CustomizationRow.vue'

describe('customizationRow (P10-0b stub)', () => {
  it('renders its root with the entry\'s data attributes', () => {
    const wrapper = mount(CustomizationRow, { props: { entry: customizationEntry({ state: 'shadowed' }) } })
    const root = wrapper.get(`[data-testid="${testIds.customizationRow}"]`)
    expect(root.attributes()).toMatchObject({ 'data-kind': 'agent', 'data-name': 'reviewer', 'data-source': 'project', 'data-state': 'shadowed', 'data-path': '.harness/agents/reviewer.md' })
    expect(root.text()).toContain('Reviews a diff and reports bugs')
  })

  it('names a personal row by its id and a command with its slash', () => {
    const entry = customizationEntry({ kind: 'command', name: 'review', source: 'user', id: customizationId(1), path: undefined })
    const wrapper = mount(CustomizationRow, { props: { entry, busy: true } })
    const root = wrapper.get(`[data-testid="${testIds.customizationRow}"]`)
    expect(root.attributes('data-customization-id')).toBe(customizationId(1))
    expect(root.attributes('data-path')).toBeUndefined()
    expect(root.attributes('aria-busy')).toBe('true')
    expect(root.text()).toContain('/review')
  })
})
