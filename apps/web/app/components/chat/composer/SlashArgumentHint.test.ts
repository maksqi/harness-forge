// SlashArgumentHint (docs/UI.md 7.28, 14.2; W10.9-T2): the aria-hidden ghost mirror and the sr-only description, shown
// only while the text is exactly `/name` plus blanks on one line and a hint is set.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import SlashArgumentHint from './SlashArgumentHint.vue'

describe('slashArgumentHint', () => {
  it('mirrors the typed command invisibly, then the muted hint, while the text is the command plus blanks', () => {
    const wrapper = mount(SlashArgumentHint, { props: { text: '/review  ', hint: '<file> [focus]', describedById: 'hint-1' } })
    const mirror = wrapper.get(`[data-testid="${testIds.slashArgumentHint}"]`)
    expect(mirror.attributes('aria-hidden')).toBe('true')
    // It never takes keys or clicks and lies over the textarea with its padding, font size, line height and wrapping.
    expect(mirror.attributes('tabindex')).toBeUndefined()
    expect(mirror.classes()).toEqual(expect.arrayContaining([
      'pointer-events-none',
      'absolute',
      'inset-0',
      'px-4',
      'pt-3',
      'pb-1',
      'text-base',
      'leading-6',
      'md:text-[15px]',
      'whitespace-pre-wrap',
    ]))
    const [typed, hint] = mirror.findAll('span')
    expect(typed!.classes()).toContain('invisible')
    expect(typed!.element.textContent).toBe('/review  ')
    expect(hint!.text()).toBe('<file> [focus]')
    expect(hint!.classes()).toContain('text-muted-foreground')
    const described = wrapper.get('#hint-1')
    expect(described.text()).toBe('Arguments: <file> [focus]')
    expect(described.classes()).toContain('sr-only')
  })

  it('accepts tabs as blanks and any case of the name', () => {
    const wrapper = mount(SlashArgumentHint, { props: { text: '/Review\t', hint: '<file>', describedById: 'hint-3' } })
    expect(wrapper.find(`[data-testid="${testIds.slashArgumentHint}"]`).exists()).toBe(true)
  })

  it('renders nothing without a hint, before the blank, at the first argument character or on a second line', () => {
    const cases: { text: string, hint: string | null, describedById: string }[] = [
      { text: '/review ', hint: null, describedById: 'hint-2' },
      { text: '/review ', hint: '', describedById: 'hint-2' },
      { text: '/review src', hint: '<file>', describedById: 'hint-2' },
      { text: '/review', hint: '<file>', describedById: 'hint-2' },
      { text: '/review \n', hint: '<file>', describedById: 'hint-2' },
      { text: ' /review ', hint: '<file>', describedById: 'hint-2' },
      { text: 'review ', hint: '<file>', describedById: 'hint-2' },
    ]
    for (const props of cases) {
      const wrapper = mount(SlashArgumentHint, { props })
      expect(wrapper.find(`[data-testid="${testIds.slashArgumentHint}"]`).exists(), JSON.stringify(props.text)).toBe(false)
      expect(wrapper.find('#hint-2').exists()).toBe(false)
    }
  })

  it('hides as soon as the text gets an argument', async () => {
    const wrapper = mount(SlashArgumentHint, { props: { text: '/review ', hint: '<file>', describedById: 'hint-4' } })
    expect(wrapper.find(`[data-testid="${testIds.slashArgumentHint}"]`).exists()).toBe(true)
    await wrapper.setProps({ text: '/review s' })
    expect(wrapper.find(`[data-testid="${testIds.slashArgumentHint}"]`).exists()).toBe(false)
    expect(wrapper.find('#hint-4').exists()).toBe(false)
  })
})
