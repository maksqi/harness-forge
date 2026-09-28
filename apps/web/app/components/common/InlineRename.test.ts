import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import InlineRename from './InlineRename.vue'

function mountRename(modelValue = 'Refactor auth flow', editing = true) {
  return mount(InlineRename, {
    props: { 'modelValue': modelValue, 'editing': editing, 'data-testid': 'chat-row-rename-input' },
    attachTo: document.body,
  })
}

describe('inlineRename', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('shows plain text while not editing', () => {
    const wrapper = mountRename('Kimi vs Qwen', false)
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.text()).toBe('Kimi vs Qwen')
    expect(wrapper.find('[data-testid="chat-row-rename-input"]').exists()).toBe(false)
  })

  it('focuses and selects the input when editing starts', async () => {
    const wrapper = mountRename()
    await nextTick()
    const input = wrapper.get<HTMLInputElement>('[data-testid="chat-row-rename-input"]')
    expect(document.activeElement).toBe(input.element)
    expect(input.element.value).toBe('Refactor auth flow')
    expect(input.attributes('maxlength')).toBe('200')
  })

  it('saves the trimmed value on Enter, once', async () => {
    const wrapper = mountRename()
    const input = wrapper.get('input')
    await input.setValue('  Server sessions  ')
    await input.trigger('keydown', { key: 'Enter' })
    await input.trigger('blur')
    expect(wrapper.emitted('update:modelValue')).toEqual([['Server sessions']])
    expect(wrapper.emitted('update:editing')).toEqual([[false]])
  })

  it('does not emit a value when nothing changed', async () => {
    const wrapper = mountRename()
    await wrapper.get('input').trigger('blur')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.emitted('update:editing')).toEqual([[false]])
  })

  it('cancels on Escape and on an empty value', async () => {
    const escape = mountRename()
    await escape.get('input').setValue('Something else')
    await escape.get('input').trigger('keydown', { key: 'Escape' })
    expect(escape.emitted('update:modelValue')).toBeUndefined()
    expect(escape.emitted('cancel')).toHaveLength(1)
    expect(escape.emitted('update:editing')).toEqual([[false]])

    const empty = mountRename()
    await empty.get('input').setValue('   ')
    await empty.get('input').trigger('keydown', { key: 'Enter' })
    expect(empty.emitted('update:modelValue')).toBeUndefined()
    expect(empty.emitted('cancel')).toHaveLength(1)
  })

  it('ignores Enter while an IME composition is active', async () => {
    const wrapper = mountRename()
    await wrapper.get('input').setValue('New title')
    await wrapper.get('input').trigger('keydown', { key: 'Enter', isComposing: true })
    expect(wrapper.emitted('update:editing')).toBeUndefined()
  })
})
