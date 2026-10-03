import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import SendStopButton from './SendStopButton.vue'

type Props = InstanceType<typeof SendStopButton>['$props']

function mountButton(props: Props) {
  const events = { send: 0, stop: 0, queue: 0 }
  const wrapper = mount({
    render: () => h(TooltipProvider, null, {
      default: () => h(SendStopButton, {
        ...props,
        onSend: () => events.send++,
        onStop: () => events.stop++,
        onQueue: () => events.queue++,
      }),
    }),
  })
  const find = (id: string) => wrapper.find(`[data-testid="${id}"]`)
  return { wrapper, events, find }
}

describe('sendStopButton', () => {
  it('sends while idle and stops while running', async () => {
    const idle = mountButton({ running: false })
    expect(idle.find(testIds.composerStop).exists()).toBe(false)
    expect(idle.find(testIds.composerQueue).exists()).toBe(false)
    await idle.find(testIds.composerSend).trigger('click')
    expect(idle.events.send).toBe(1)

    const running = mountButton({ running: true })
    expect(running.find(testIds.composerSend).exists()).toBe(false)
    await running.find(testIds.composerStop).trigger('click')
    expect(running.events.stop).toBe(1)
  })

  it('adds "Queue message" left of Stop while running with content (canQueue)', async () => {
    const { wrapper, events, find } = mountButton({ running: true, canQueue: true })
    const queue = find(testIds.composerQueue)
    expect(queue.text()).toBe('Queue message')
    expect(queue.attributes('aria-disabled')).toBeUndefined()
    const buttons = wrapper.findAll('button').map(button => button.attributes('data-testid'))
    expect(buttons).toEqual([testIds.composerQueue, testIds.composerStop])
    await queue.trigger('click')
    expect(events).toEqual({ send: 0, stop: 0, queue: 1 })

    // canQueue without a run shows Send only.
    expect(mountButton({ running: false, canQueue: true }).find(testIds.composerQueue).exists()).toBe(false)
  })

  it('keeps the queue button focusable but inert while disabled or waiting for uploads', async () => {
    const disabled = mountButton({ running: true, canQueue: true, disabled: true, reason: 'Remove or retry the failed uploads' })
    expect(disabled.find(testIds.composerQueue).attributes('aria-disabled')).toBe('true')
    await disabled.find(testIds.composerQueue).trigger('click')
    expect(disabled.events.queue).toBe(0)

    const pending = mountButton({ running: true, canQueue: true, pending: true })
    expect(pending.find(testIds.composerQueue).attributes()).toMatchObject({ 'aria-disabled': 'true', 'aria-busy': 'true' })
    await pending.find(testIds.composerQueue).trigger('click')
    expect(pending.events.queue).toBe(0)
  })
})
