import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { definitionDiagnostic } from '~/utils/testing/fixtures'
import MarkdownEditor from './MarkdownEditor.vue'

describe('markdownEditor (P10-0b stub)', () => {
  it('is a labelled field that emits its value, Mod+Enter as submit, and never captures Tab', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: { modelValue: 'Review the diff.', label: 'Instructions', diagnostics: [definitionDiagnostic()], minHeight: '12rem' },
      attrs: { 'data-testid': 'customization-body' },
    })
    const root = wrapper.get('[data-slot="markdown-editor"]')
    expect(root.attributes('data-testid')).toBe('customization-body')
    const field = wrapper.get('textarea')
    expect(field.attributes('aria-label')).toBe('Instructions')
    expect(field.element.value).toBe('Review the diff.')
    await field.setValue('Review the diff carefully.')
    expect(wrapper.emitted('update:modelValue')).toEqual([['Review the diff carefully.']])
    await field.trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(wrapper.emitted('submit')).toEqual([[]])
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true })
    field.element.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
  })

  it('is read-only on request', () => {
    const wrapper = mount(MarkdownEditor, { props: { modelValue: '# Notes', label: 'File', readonly: true } })
    expect(wrapper.get('textarea').attributes('readonly')).toBeDefined()
  })
})
