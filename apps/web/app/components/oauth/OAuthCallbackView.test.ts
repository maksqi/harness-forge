// OAuthCallbackView (Phase 14, ADR-059; docs/UI.md 8.14, 10.10): the C54 stub's contract (no props, no emits, the root
// test id with `data-state`); W14.7 implements the page.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import OAuthCallbackView from './OAuthCallbackView.vue'

describe('oAuthCallbackView (stub)', () => {
  it('renders its root test id in the working state with a status line', () => {
    const wrapper = mount(OAuthCallbackView)
    const root = wrapper.get(`[data-testid="${testIds.oauthCallback}"]`)
    expect(root.attributes('data-state')).toBe('working')
    expect(root.get('[role="status"]').text()).toBe('Finishing sign-in…')
    wrapper.unmount()
  })
})
