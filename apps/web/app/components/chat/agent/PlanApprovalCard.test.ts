import type { ToolPartLike } from '../chat-format'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { planApprovalPart } from '~/utils/testing/fixtures'
import PlanApprovalCard from './PlanApprovalCard.vue'

afterEach(() => {
  document.body.replaceChildren()
})

describe('planApprovalCard (P9-0b stub)', () => {
  it('renders its root as a group and passes the decision on', async () => {
    const wrapper = mount(PlanApprovalCard, { props: { part: planApprovalPart() as ToolPartLike, source: 'core-agent' }, attachTo: document.body })
    const root = wrapper.get(`[data-testid="${testIds.planApproval}"]`)
    expect(root.attributes()).toMatchObject({ 'data-state': 'pending', 'role': 'group', 'aria-label': 'Plan ready for review' })
    await root.get(`[data-testid="${testIds.toolApprovalDeny}"]`).trigger('click')
    expect(wrapper.emitted('decide')).toEqual([[{ approved: false }]])
  })

  it('shows the sending state while disabled', () => {
    const wrapper = mount(PlanApprovalCard, { props: { part: planApprovalPart() as ToolPartLike, disabled: true }, attachTo: document.body })
    expect(wrapper.get(`[data-testid="${testIds.planApproval}"]`).attributes('data-state')).toBe('sending')
  })
})
