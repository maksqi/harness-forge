import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import StatusDot from './StatusDot.vue'

function mountDot(props: InstanceType<typeof StatusDot>['$props'], attrs: Record<string, string> = {}) {
  return mount({ render: () => h(TooltipProvider, null, { default: () => h(StatusDot, { ...props, ...attrs }) }) })
}

describe('statusDot', () => {
  it('renders a dot with a visually hidden label and the status as data attribute', () => {
    const wrapper = mountDot({ status: 'approval' }, { 'data-testid': 'chat-status-dot' })
    const root = wrapper.get('[data-testid="chat-status-dot"]')
    expect(root.attributes('data-status')).toBe('approval')
    expect(root.get('.sr-only').text()).toBe('Needs approval')
    expect(root.find('.bg-warning').exists()).toBe(true)
  })

  it('pulses while running and is hollow when off', () => {
    expect(mountDot({ status: 'running' }).find('.animate-hf-pulse').exists()).toBe(true)
    const off = mountDot({ status: 'off' })
    expect(off.find('.border-muted-foreground').exists()).toBe(true)
    expect(off.get('.sr-only').text()).toBe('Off')
  })

  it('accepts a custom label', () => {
    expect(mountDot({ status: 'error', label: 'Connection lost' }).get('.sr-only').text()).toBe('Connection lost')
  })
})
