import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import SlashArgumentHint from './SlashArgumentHint.vue'

describe('slashArgumentHint (P10-0b stub)', () => {
  it('mirrors the typed command with its hint while the text is the command plus blanks', () => {
    const wrapper = mount(SlashArgumentHint, { props: { text: '/review ', hint: '<file> [focus]', describedById: 'hint-1' } })
    const mirror = wrapper.get(`[data-testid="${testIds.slashArgumentHint}"]`)
    expect(mirror.attributes('aria-hidden')).toBe('true')
    expect(mirror.text()).toContain('<file> [focus]')
    expect(wrapper.get('#hint-1').text()).toBe('Arguments: <file> [focus]')
  })

  it('renders nothing without a hint or once an argument is typed', () => {
    const cases: { text: string, hint: string | null, describedById: string }[] = [
      { text: '/review ', hint: null, describedById: 'hint-2' },
      { text: '/review src', hint: '<file>', describedById: 'hint-2' },
      { text: '/review', hint: '<file>', describedById: 'hint-2' },
    ]
    for (const props of cases) {
      const wrapper = mount(SlashArgumentHint, { props })
      expect(wrapper.find(`[data-testid="${testIds.slashArgumentHint}"]`).exists()).toBe(false)
      expect(wrapper.find('#hint-2').exists()).toBe(false)
    }
  })
})
