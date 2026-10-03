import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import PlanBody from './PlanBody.vue'

vi.mock('~/components/chat/nuxt-imports', () => ({ useColorMode: () => ({ value: 'dark' }) }))

describe('planBody', () => {
  it('renders the plan as Markdown and the feedback below it', () => {
    const wrapper = mount(PlanBody, { props: { plan: '# Plan\n1. Create notes.txt', feedback: 'Split step 1' } })
    const root = wrapper.get('[data-slot="plan-body"]')
    expect(root.find('[data-slot="markdown"]').exists()).toBe(true)
    expect(root.text()).toContain('Create notes.txt')
    expect(root.get('[data-slot="plan-feedback-text"]').text()).toBe('Your feedback: Split step 1')
    expect(mount(PlanBody, { props: { plan: 'x' } }).text()).not.toContain('Your feedback')
  })

  it('never renders raw HTML from the plan', () => {
    const wrapper = mount(PlanBody, { props: { plan: 'Hi <img src=x onerror="alert(1)"> there' } })
    expect(wrapper.find('img[onerror]').exists()).toBe(false)
  })
})
