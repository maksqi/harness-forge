import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PlanBody from './PlanBody.vue'

describe('planBody (P9-0b stub)', () => {
  it('renders the plan and the feedback', () => {
    const wrapper = mount(PlanBody, { props: { plan: '# Plan\n1. Create notes.txt', feedback: 'Split step 1' } })
    const root = wrapper.get('[data-slot="plan-body"]')
    expect(root.text()).toContain('1. Create notes.txt')
    expect(root.text()).toContain('Your feedback: Split step 1')
    expect(mount(PlanBody, { props: { plan: 'x' } }).text()).not.toContain('Your feedback')
  })
})
