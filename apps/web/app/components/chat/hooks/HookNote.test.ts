import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { hookData } from '~/utils/testing/fixtures'
import HookNote from './HookNote.vue'

describe('hookNote (P11-0b stub)', () => {
  it('renders its root as a named note with the event, the outcome, the source and the variant', () => {
    const data = hookData()
    const wrapper = mount(HookNote, { props: { data, variant: 'tool', pluginName: null } })
    const root = wrapper.get(`[data-testid="${testIds.hookNote}"]`)
    expect(root.attributes()).toMatchObject({
      'data-event': 'PreToolUse',
      'data-outcome': 'denied',
      'data-source': 'project',
      'data-variant': 'tool',
      'role': 'note',
    })
    expect(root.attributes('aria-label')).toMatch(/^Hook PreToolUse: /)
  })

  it('shows the reason as the body of a turn note', () => {
    const data = hookData({ event: 'Stop', outcome: 'continued', toolCallId: undefined, toolName: undefined, reason: 'Run the tests first.' })
    const wrapper = mount(HookNote, { props: { data, variant: 'turn' } })
    expect(wrapper.get(`[data-testid="${testIds.hookNote}"]`).attributes('data-variant')).toBe('turn')
    expect(wrapper.text()).toContain('Run the tests first.')
  })
})
