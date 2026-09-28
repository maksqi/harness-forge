import { Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSourceEditor, placeDiagnostics } from './editor-setup'

const editors: Array<ReturnType<typeof createSourceEditor>> = []

function mountEditor(options: { dark?: boolean, readonly?: boolean } = {}) {
  const parent = document.createElement('div')
  document.body.append(parent)
  const onChange = vi.fn()
  const editor = createSourceEditor(parent, { dark: options.dark ?? true, readonly: options.readonly ?? false, onChange })
  editors.push(editor)
  return { editor, parent, onChange }
}

afterEach(() => {
  for (const editor of editors.splice(0))
    editor.destroy()
  document.body.replaceChildren()
})

describe('placeDiagnostics', () => {
  const doc = Text.of(['export default {', '  setup(ctx) {', '    const = 1', '  },', '}'])

  it('places 1-based lines and byte columns and underlines the word', () => {
    const [placed] = placeDiagnostics(doc, [{ severity: 'error', file: 'index.mjs', line: 3, column: 11, message: 'Expected identifier' }])
    const line = doc.line(3)
    expect(placed).toEqual({ from: line.from + 10, to: line.from + 11, severity: 'error', message: 'Expected identifier' })
    const [word] = placeDiagnostics(doc, [{ severity: 'warning', file: null, line: 2, column: 3, message: 'w' }])
    expect(doc.sliceString(word!.from, word!.to)).toBe('setup')
  })

  it('clamps lines and marks the whole line for a position at its end or without a column', () => {
    const [end] = placeDiagnostics(doc, [{ severity: 'error', file: null, line: 99, column: 99, message: 'eof' }])
    expect(doc.sliceString(end!.from, end!.to)).toBe('}')
    const [noColumn] = placeDiagnostics(doc, [{ severity: 'error', file: null, line: null, column: null, message: 'file' }])
    expect(noColumn!.from).toBe(0)
  })

  it('converts byte columns of non-ASCII lines', () => {
    const text = Text.of(['const s = \'\u00E9\u00E9\' + oops'])
    // "oops" starts at byte 19 (0-based) because each e-acute takes two bytes.
    const [placed] = placeDiagnostics(text, [{ severity: 'error', file: null, line: 1, column: 20, message: 'x' }])
    expect(text.sliceString(placed!.from, placed!.to)).toBe('oops')
  })
})

describe('createSourceEditor', () => {
  it('reports user edits, not programmatic replacements', () => {
    const { editor, onChange } = mountEditor()
    editor.show('index.mjs', 'const a = 1')
    expect(editor.content()).toBe('const a = 1')
    editor.view.dispatch({ changes: { from: 0, insert: '// hi\n' } })
    expect(onChange).toHaveBeenLastCalledWith('index.mjs', '// hi\nconst a = 1')
    onChange.mockClear()
    editor.replace('reloaded')
    expect(editor.content()).toBe('reloaded')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps one state per file while switching (edits and history survive)', () => {
    const { editor } = mountEditor()
    editor.show('a.mjs', 'a')
    editor.view.dispatch({ changes: { from: 1, insert: '!' } })
    editor.show('b.mjs', 'b')
    expect(editor.content()).toBe('b')
    editor.show('a.mjs', 'a!')
    expect(editor.content()).toBe('a!')
    // The same state (with its history) came back: undo restores the original text.
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)
    editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }))
    expect(editor.content()).toBe('a')
    // A different text for a known path starts a fresh state.
    editor.show('b.mjs', 'changed elsewhere')
    expect(editor.content()).toBe('changed elsewhere')
  })

  it('shows diagnostics as gutter markers and underlines', () => {
    const { editor, parent } = mountEditor()
    editor.show('index.mjs', 'export default {\n  setup() { const = 1 },\n}\n')
    editor.setDiagnostics([{ severity: 'error', file: 'index.mjs', line: 2, column: 19, message: 'Expected identifier but found "="' }])
    const marker = parent.querySelector('.cm-hf-lint-marker-error')
    expect(marker?.getAttribute('aria-label')).toBe('Expected identifier but found "="')
    expect(parent.querySelector('.cm-hf-diagnostic-error')?.textContent).toBe('=')
    editor.setDiagnostics([])
    expect(parent.querySelector('.cm-hf-lint-marker-error')).toBeNull()
  })

  it('switches between the one-dark and the light theme and honors read-only mode', () => {
    const { editor } = mountEditor({ dark: true })
    editor.show('plugin.json', '{}')
    expect(editor.view.state.facet(EditorView.darkTheme)).toBe(true)
    editor.setDark(false)
    expect(editor.view.state.facet(EditorView.darkTheme)).toBe(false)
    expect(editor.view.state.readOnly).toBe(false)
    editor.setReadOnly(true)
    expect(editor.view.state.readOnly).toBe(true)
    expect(editor.view.contentDOM.getAttribute('contenteditable')).toBe('false')
  })

  it('indents with Tab and moves to a diagnostic location', () => {
    const { editor } = mountEditor()
    editor.show('index.mjs', 'a\nb')
    editor.view.dispatch({ selection: { anchor: 0, head: 3 } })
    editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(editor.content()).toBe('  a\n  b')
    editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(editor.content()).toBe('a\nb')
    editor.goTo(2, 1)
    expect(editor.view.state.selection.main.head).toBe(2)
  })
})
