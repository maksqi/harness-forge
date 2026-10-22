// ElicitationCard (Phase 14, ADR-060; docs/UI.md 7.35, 10.10): the C54 stub's contract (props, the exposed focusFirst,
// the root test id with `data-state` and `data-server-id`); W14.9 implements the card.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { mcpElicitation } from '~/utils/testing/fixtures'
import ElicitationCard from './ElicitationCard.vue'

describe('elicitationCard (stub)', () => {
  it('renders the request as a named region with its message as plain text', async () => {
    const request = mcpElicitation({ message: '<b>Which</b> team?' })
    const wrapper = mount(ElicitationCard, { props: { request }, attachTo: document.body })
    const root = wrapper.get(`[data-testid="${testIds.elicitationCard}"]`)
    expect(root.attributes('role')).toBe('region')
    expect(root.attributes('data-state')).toBe('pending')
    expect(root.attributes('data-server-id')).toBe('fixture')
    expect(root.text()).toContain('Fixture needs more information')
    expect(wrapper.get(`[data-testid="${testIds.elicitationMessage}"]`).text()).toBe('<b>Which</b> team?')
    expect(root.find('b').exists()).toBe(false)
    await wrapper.setProps({ busy: true, issues: [], gone: false })
    expect(root.attributes('data-state')).toBe('submitting')
    expect(typeof (wrapper.vm as unknown as { focusFirst: () => void }).focusFirst).toBe('function')
    wrapper.unmount()
  })
})
