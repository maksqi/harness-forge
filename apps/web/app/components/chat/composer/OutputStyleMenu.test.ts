import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { styleEntry } from '~/utils/testing/fixtures'
import { styleOptions } from './output-style'
import OutputStyleMenu from './OutputStyleMenu.vue'

describe('outputStyleMenu (P11-0b stub)', () => {
  const options = styleOptions([styleEntry()])

  it('renders the trigger with the automatic style', () => {
    const wrapper = mount(OutputStyleMenu, { props: { open: false, modelValue: null, options, automatic: options[0]! } })
    const trigger = wrapper.get(`[data-testid="${testIds.outputStyleTrigger}"]`)
    expect(trigger.attributes()).toMatchObject({ 'data-value': 'default', 'data-source': 'automatic', 'aria-label': 'Output style: Default (automatic)' })
  })

  it('renders the chat\'s own choice and asks to open', async () => {
    const wrapper = mount(OutputStyleMenu, { props: { open: false, modelValue: 'terse', options, automatic: null, returnFocusTo: null } })
    const trigger = wrapper.get(`[data-testid="${testIds.outputStyleTrigger}"]`)
    expect(trigger.attributes()).toMatchObject({ 'data-value': 'terse', 'data-source': 'chat', 'aria-label': 'Output style: Terse' })
    await trigger.trigger('click')
    expect(wrapper.emitted('update:open')).toEqual([[true]])
  })
})
