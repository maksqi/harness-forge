import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import PlanFileChip from './PlanFileChip.vue'

describe('planFileChip (P10-0b stub)', () => {
  it('shows a saved plan file with its path', () => {
    const wrapper = mount(PlanFileChip, { props: { planPath: '.harness/plans/2026-10-04-move-auth.md', planError: null, projectChat: true } })
    const root = wrapper.get(`[data-testid="${testIds.planFile}"]`)
    expect(root.attributes()).toMatchObject({ 'data-state': 'saved', 'data-path': '.harness/plans/2026-10-04-move-auth.md' })
    expect(root.text()).toContain('Saved to')
  })

  it('shows a failed write, and nothing without either', () => {
    const failed = mount(PlanFileChip, { props: { planPath: null, planError: 'The plan folder is a link.', projectChat: true } })
    expect(failed.get(`[data-testid="${testIds.planFile}"]`).attributes('data-state')).toBe('failed')
    expect(failed.text()).toBe('Couldn\'t save the plan file: The plan folder is a link.')
    const none = mount(PlanFileChip, { props: { planPath: null, planError: null, projectChat: false } })
    expect(none.find(`[data-testid="${testIds.planFile}"]`).exists()).toBe(false)
  })
})
