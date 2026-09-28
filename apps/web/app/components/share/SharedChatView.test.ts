import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import SharedChatView from './SharedChatView.vue'

// A token in the documented format: 16 alphanumeric characters + 22 base64url characters.
const TOKEN = '0bN3aK9xQ7fLm2PzRt5_uV-wXy8zAb1Cd2Ef3G'

describe('sharedChatView', () => {
  it('renders the share page root for its token without an active Pinia (store-free)', () => {
    const wrapper = mount(SharedChatView, { props: { token: TOKEN } })
    const root = wrapper.get(`[data-testid="${testIds.sharePage}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('data-state')).toBe('loading')
    expect(wrapper.props('token')).toBe(TOKEN)
    wrapper.unmount()
  })
})
