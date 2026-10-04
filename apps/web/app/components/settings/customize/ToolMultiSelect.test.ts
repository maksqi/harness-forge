import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { toolSummary } from '~/utils/testing/fixtures'
import ToolMultiSelect from './ToolMultiSelect.vue'

describe('toolMultiSelect (P10-0b stub)', () => {
  it('shows the chosen tools as chips, unknown names as unknown', () => {
    const wrapper = mount(ToolMultiSelect, { props: { modelValue: ['roll_dice', 'Task'], tools: [toolSummary()], label: 'Tools', disabled: false } })
    expect(wrapper.findAll(`[data-testid="${testIds.customizationToolChip}"]`).map(chip => [chip.attributes('data-tool-name'), chip.attributes('data-state')]))
      .toEqual([['roll_dice', 'known'], ['Task', 'unknown']])
    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('Tools')
  })

  it('shows no chip without a restriction', () => {
    const wrapper = mount(ToolMultiSelect, { props: { modelValue: null, tools: [], label: 'Allowed tools' } })
    expect(wrapper.findAll(`[data-testid="${testIds.customizationToolChip}"]`)).toHaveLength(0)
  })
})
