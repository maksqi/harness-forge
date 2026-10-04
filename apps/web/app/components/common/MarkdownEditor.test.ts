// MarkdownEditor (docs/UI.md 9.12, 10.7; W10.8-T3): the CodeMirror markdown field of Settings -> Customize: the
// value both ways, Mod+Enter as submit, Tab never captured, lint markers, read-only, the theme, the fallback textarea.
import type { VueWrapper } from '@vue/test-utils'
import { diagnosticCount } from '@codemirror/lint'
import { EditorView } from '@codemirror/view'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { definitionDiagnostic } from '~/utils/testing/fixtures'
import MarkdownEditor from './MarkdownEditor.vue'

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  document.documentElement.classList.remove('dark')
  vi.restoreAllMocks()
  vi.doUnmock('~/components/plugins/code/editor-setup')
})

async function mountEditor(props: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}) {
  wrapper = mount(MarkdownEditor, {
    props: { modelValue: 'Review the diff.', label: 'Instructions', ...props },
    attrs,
    attachTo: document.body,
  })
  await vi.waitFor(() => expect(wrapper!.get('[data-slot="markdown-editor"]').attributes('data-ready')).toBe('true'))
  await flushPromises()
  return wrapper
}

function view(): EditorView {
  const element = document.body.querySelector<HTMLElement>('.cm-editor')!
  const found = EditorView.findFromDOM(element)
  if (!found)
    throw new Error('no editor view')
  return found
}

function keydown(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('markdownEditor', () => {
  it('is a labelled CodeMirror field that shows and emits its value; the test id lands on the root', async () => {
    const editor = await mountEditor({ minHeight: '12rem' }, { 'data-testid': 'customization-body', 'aria-describedby': 'body-help' })
    const root = editor.get('[data-slot="markdown-editor"]')
    expect(root.attributes('data-testid')).toBe('customization-body')
    const content = view().contentDOM
    expect(content.getAttribute('aria-label')).toBe('Instructions')
    expect(content.getAttribute('aria-multiline')).toBe('true')
    expect(content.getAttribute('aria-describedby')).toBe('body-help')
    expect(view().state.doc.toString()).toBe('Review the diff.')

    view().dispatch({ changes: { from: view().state.doc.length, insert: ' Carefully.' } })
    expect(editor.emitted('update:modelValue')).toEqual([['Review the diff. Carefully.']])

    // A new value from the parent replaces the text without an echo.
    await editor.setProps({ modelValue: 'Something else.' })
    expect(view().state.doc.toString()).toBe('Something else.')
    expect(editor.emitted('update:modelValue')).toHaveLength(1)
    await editor.setProps({ label: 'Prompt' })
    expect(content.getAttribute('aria-label')).toBe('Prompt')
  })

  it('emits submit on Mod+Enter and never captures Tab', async () => {
    const editor = await mountEditor()
    const content = view().contentDOM
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)
    expect(keydown(content, { key: 'Enter', metaKey: mac, ctrlKey: !mac }).defaultPrevented).toBe(true)
    expect(editor.emitted('submit')).toEqual([[]])
    expect(keydown(content, { key: 'Tab' }).defaultPrevented).toBe(false)
    expect(keydown(content, { key: 'Tab', shiftKey: true }).defaultPrevented).toBe(false)
    expect(view().state.doc.toString()).toBe('Review the diff.')
  })

  it('shows the diagnostics that have a line as lint markers and follows read-only and the theme', async () => {
    document.documentElement.classList.add('dark')
    const editor = await mountEditor({
      modelValue: '---\nname: reviewer\ndescription: x\ntools: Read, NotebookEdit\n---\nBody',
      diagnostics: [definitionDiagnostic(), definitionDiagnostic({ line: undefined, message: 'No line.' })],
      readonly: true,
    })
    expect(diagnosticCount(view().state)).toBe(1)
    expect(view().state.readOnly).toBe(true)
    expect(view().contentDOM.getAttribute('aria-readonly')).toBe('true')
    expect(view().state.facet(EditorView.darkTheme)).toBe(true)
    document.documentElement.classList.remove('dark')
    await vi.waitFor(() => expect(view().state.facet(EditorView.darkTheme)).toBe(false))
    await editor.setProps({ diagnostics: [], readonly: false })
    expect(diagnosticCount(view().state)).toBe(0)
    expect(view().state.readOnly).toBe(false)
  })

  it('falls back to a textarea with the same contract when CodeMirror cannot load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.doMock('~/components/plugins/code/editor-setup', () => {
      throw new Error('chunk failed')
    })
    vi.resetModules()
    const { default: Fresh } = await import('./MarkdownEditor.vue')
    wrapper = mount(Fresh, { props: { modelValue: 'Hello', label: 'Prompt', readonly: false }, attachTo: document.body })
    await vi.waitFor(() => expect(wrapper!.find('textarea').exists()).toBe(true))
    const field = wrapper.get('textarea')
    expect(field.attributes('aria-label')).toBe('Prompt')
    await field.setValue('Hello there')
    expect(wrapper.emitted('update:modelValue')).toEqual([['Hello there']])
    await field.trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(wrapper.emitted('submit')).toEqual([[]])
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true })
    field.element.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
  })
})
