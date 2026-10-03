import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { messageId, steerData } from '~/utils/testing/fixtures'
import SteerNote from './SteerNote.vue'

describe('steerNote (P9-0b stub)', () => {
  it('renders a note with the queued message id and its text', () => {
    const wrapper = mount(SteerNote, { props: { steer: steerData({ id: messageId('steer2') }) } })
    const root = wrapper.get(`[data-testid="${testIds.steerNote}"]`)
    expect(root.attributes('data-message-id')).toBe(messageId('steer2'))
    expect(root.attributes('role')).toBe('note')
    expect(root.text()).toContain('You said while the agent worked:')
    expect(root.text()).toContain('Use the vitest filter instead')
  })
})
