import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { messageId, queueItem } from '~/utils/testing/fixtures'
import QueuedMessages from './QueuedMessages.vue'

describe('queuedMessages (P9-0b stub)', () => {
  it('renders its root with the count and the state', () => {
    const items = [queueItem(), queueItem({ id: messageId('queued2'), text: 'Check the lexer too' })]
    const wrapper = mount(QueuedMessages, { props: { items, cancelling: [messageId('queued2')] } })
    expect(wrapper.get(`[data-testid="${testIds.queuedMessages}"]`).attributes()).toMatchObject({ 'data-count': '2', 'data-state': 'queued' })
    const waiting = mount(QueuedMessages, { props: { items, waitingForApproval: true } })
    expect(waiting.get(`[data-testid="${testIds.queuedMessages}"]`).attributes('data-state')).toBe('approval')
  })

  it('renders nothing while the queue is empty', () => {
    expect(mount(QueuedMessages, { props: { items: [] } }).find(`[data-testid="${testIds.queuedMessages}"]`).exists()).toBe(false)
  })
})
