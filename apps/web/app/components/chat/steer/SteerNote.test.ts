import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { messageId, steerData } from '~/utils/testing/fixtures'
import SteerNote from './SteerNote.vue'

afterEach(() => {
  document.body.replaceChildren()
})

describe('steerNote', () => {
  it('renders a right-aligned note with the queued message id, the sr-only prefix and the text', () => {
    const wrapper = mount(SteerNote, { props: { steer: steerData({ id: messageId('steer2') }) } })
    const root = wrapper.get(`[data-testid="${testIds.steerNote}"]`)
    expect(root.attributes('data-message-id')).toBe(messageId('steer2'))
    expect(root.attributes('role')).toBe('note')
    expect(root.classes()).toEqual(expect.arrayContaining(['self-end', 'max-w-[85%]', 'items-end']))
    // Screen readers hear the prefix first, then the text; the visible caption is not read twice.
    const prefix = root.get('.sr-only')
    expect(prefix.text()).toBe('You said while the agent worked:')
    expect(root.element.firstElementChild).toBe(prefix.element)
    const bubble = root.get('[data-slot="steer-text"]')
    expect(bubble.text()).toBe('Use the vitest filter instead')
    expect(bubble.classes()).toEqual(expect.arrayContaining(['bg-muted/70', 'rounded-2xl', 'text-sm', 'whitespace-pre-wrap']))
    const caption = root.findAll('[aria-hidden="true"]').find(element => element.text() === 'You · while it worked')
    expect(caption).toBeDefined()
  })

  it('keeps the text plain and its line breaks, joining several text parts', () => {
    const wrapper = mount(SteerNote, {
      props: { steer: steerData({ parts: [{ type: 'text', text: '**not bold**\n  indented' }, { type: 'text', text: 'second' }] }) },
    })
    const bubble = wrapper.get('[data-slot="steer-text"]')
    expect(bubble.find('strong').exists()).toBe(false)
    expect(bubble.element.textContent).toBe('**not bold**\n  indented\n\nsecond')
  })

  it('shows its files as chips, also without text', () => {
    const wrapper = mount(SteerNote, {
      props: {
        steer: steerData({
          parts: [
            { type: 'file', mediaType: 'application/pdf', filename: 'spec.pdf', url: '/api/files/file_AAAAAAAAAAAAAAAA' },
            { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', url: '/api/files/file_BBBBBBBBBBBBBBBB' },
          ],
        }),
      },
    })
    const chips = wrapper.findAll(`[data-testid="${testIds.fileChip}"]`)
    expect(chips.map(chip => chip.text())).toEqual([expect.stringContaining('spec.pdf'), expect.stringContaining('notes.txt')])
    expect(wrapper.find('[data-slot="steer-text"]').exists()).toBe(false)
    expect(wrapper.get(`[data-testid="${testIds.steerNote}"]`).text()).toContain('You said while the agent worked:')
  })
})
