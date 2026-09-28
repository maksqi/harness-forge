// CodeMirror 6 setup of the Source tab (docs/UI.md 8.10): one EditorView whose state is swapped per open file (each
// file keeps its own undo history and selection), languages by extension, the one-dark theme in dark mode and a light
// theme from the design tokens, JetBrains Mono 13px, a read-only mode, Tab indentation (`@codemirror/commands`), and
// build diagnostics through `@codemirror/lint` (wavy underline, hover tooltip, the keyboard-accessible diagnostics
// panel on Mod-Shift-M and F8) plus a gutter marker per line (its title shows the messages on hover; the gutter is
// hidden from assistive technology, so new diagnostics are also announced through the editor's live region).
// Messages are text only.
// Loaded with a dynamic import by SourceEditor.vue, so CodeMirror is only downloaded when the Source tab opens.
import type { Diagnostic } from '@codemirror/lint'
import type { Extension, Text } from '@codemirror/state'
import type { BuildDiagnostic } from '@harness-forge/shared'
import type { SourceLanguage } from './source-files'
import { indentLess, indentMore } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { forEachDiagnostic, setDiagnostics } from '@codemirror/lint'
import { Compartment, EditorState, RangeSet } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, gutter, GutterMarker, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { byteColumnToIndex, languageOf } from './source-files'

/** A build diagnostic placed in the document (UTF-16 offsets), as `@codemirror/lint` shows it. */
export interface EditorDiagnostic extends Diagnostic {
  severity: 'error' | 'warning'
}

/** The indent unit (the `indentUnit` default, matching `tabSize` 2). */
const INDENT = '  '
const WORD_START = /^[\w$]+/

// ---------- diagnostics ----------

class DiagnosticMarker extends GutterMarker {
  constructor(readonly severity: 'error' | 'warning', readonly message: string) {
    super()
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof DiagnosticMarker && other.severity === this.severity && other.message === this.message
  }

  override toDOM(): Node {
    const marker = document.createElement('span')
    // An empty message is the invisible spacer that gives the gutter its width.
    if (this.message === '') {
      marker.className = 'cm-hf-lint-marker'
      return marker
    }
    marker.className = `cm-hf-lint-marker cm-hf-lint-marker-${this.severity}`
    marker.title = this.message
    return marker
  }
}

/** One marker per line with diagnostics, read from the `@codemirror/lint` state; hovering shows its messages. */
function diagnosticsGutter(): Extension {
  return gutter({
    class: 'cm-hf-lint-gutter',
    markers: (view) => {
      const { doc } = view.state
      const byLine = new Map<number, { error: boolean, messages: string[] }>()
      forEachDiagnostic(view.state, (diagnostic, from) => {
        const line = doc.lineAt(Math.min(from, doc.length))
        const entry = byLine.get(line.from) ?? { error: false, messages: [] }
        entry.error ||= diagnostic.severity === 'error'
        entry.messages.push(diagnostic.message)
        byLine.set(line.from, entry)
      })
      const markers = [...byLine].map(([from, entry]) => new DiagnosticMarker(entry.error ? 'error' : 'warning', entry.messages.join('\n')).range(from))
      return RangeSet.of(markers, true)
    },
    initialSpacer: () => new DiagnosticMarker('error', ''),
  })
}

/** Places build diagnostics of one file in `doc` (1-based lines, 1-based UTF-8 byte columns). */
export function placeDiagnostics(doc: Text, diagnostics: readonly BuildDiagnostic[]): EditorDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const lineNumber = Math.min(Math.max(diagnostic.line ?? 1, 1), doc.lines)
    const line = doc.line(lineNumber)
    const offset = diagnostic.column === null ? 0 : Math.min(byteColumnToIndex(line.text, diagnostic.column), line.length)
    // Underline the word at the position (or one character); a diagnostic at the end of a line marks the whole line.
    const markClass = `cm-hf-diagnostic-${diagnostic.severity}`
    if (offset >= line.length)
      return { from: line.from, to: line.to, severity: diagnostic.severity, message: diagnostic.message, markClass }
    const word = line.text.slice(offset).match(WORD_START)?.[0].length ?? 0
    const from = line.from + offset
    return { from, to: from + Math.max(word, 1), severity: diagnostic.severity, message: diagnostic.message, markClass }
  })
}

/**
 * What screen readers hear when diagnostics arrive (CodeMirror's gutters are `aria-hidden`): the count and the first
 * problem, e.g. "2 problems in this file. Line 3: Expected identifier".
 */
export function diagnosticsAnnouncement(doc: Text, diagnostics: readonly EditorDiagnostic[]): string {
  const first = diagnostics[0]
  if (!first)
    return ''
  const count = diagnostics.length === 1 ? '1 problem' : `${diagnostics.length} problems`
  const line = doc.lineAt(Math.min(first.from, doc.length)).number
  return `${count} in this file. Line ${line}: ${first.message}`
}

// ---------- editing ----------

/**
 * Tab: the indent unit at the cursor when nothing is selected, else `indentMore` on the selected lines; Shift-Tab:
 * `indentLess`. Both do nothing in read-only mode.
 */
function insertIndent(view: EditorView): boolean {
  const { state } = view
  if (state.readOnly)
    return false
  if (state.selection.ranges.some(range => !range.empty))
    return indentMore(view)
  view.dispatch(state.update(state.replaceSelection(INDENT), { scrollIntoView: true, userEvent: 'input.indent' }))
  return true
}

const indentKeymap = keymap.of([{ key: 'Tab', run: insertIndent, shift: indentLess }])

// ---------- themes ----------

// `@codemirror/lint` draws its underlines and tooltips with fixed colors; these rules use the design tokens instead.
const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', fontVariantLigatures: 'none', fontFeatureSettings: '"calt" 0, "liga" 0' },
  '.cm-hf-lint-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 2px' },
  '.cm-hf-lint-marker': { display: 'inline-block', width: '8px', height: '8px', borderRadius: '9999px' },
  '.cm-hf-lint-marker-error': { backgroundColor: 'var(--destructive)' },
  '.cm-hf-lint-marker-warning': { backgroundColor: 'var(--warning)' },
  '.cm-lintRange-error, .cm-lintRange-warning': { backgroundImage: 'none', paddingBottom: '0', textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
  '.cm-lintRange-error': { textDecoration: 'underline wavy var(--destructive)' },
  '.cm-lintRange-warning': { textDecoration: 'underline wavy var(--warning)' },
  '.cm-lintRange-active': { backgroundColor: 'color-mix(in oklch, var(--warning) 22%, transparent)' },
  '.cm-tooltip.cm-tooltip-hover, .cm-tooltip.cm-tooltip-lint': { border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' },
  '.cm-tooltip-lint': { maxWidth: '36rem', fontFamily: 'var(--font-sans)', fontSize: '12px', backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)' },
  '.cm-diagnostic': { padding: '4px 8px', borderLeftWidth: '3px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--destructive)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
  '.cm-panel.cm-panel-lint': { fontFamily: 'var(--font-sans)', fontSize: '12px' },
  '.cm-panel.cm-panel-lint ul [aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)' },
})

const lightTheme = EditorView.theme({
  '&': { color: 'var(--foreground)', backgroundColor: 'var(--background)' },
  '.cm-content': { caretColor: 'var(--foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-gutters': { backgroundColor: 'var(--background)', color: 'var(--muted-foreground)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in oklch, var(--muted) 70%, transparent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 22%, transparent)',
  },
  '.cm-panels': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' },
}, { dark: false })

function themeExtension(dark: boolean): Extension {
  return dark ? [oneDark, baseTheme] : [lightTheme, baseTheme]
}

function languageExtension(language: SourceLanguage): Extension {
  switch (language) {
    case 'javascript':
      return javascript()
    case 'typescript':
      return javascript({ typescript: true })
    case 'json':
      return json()
    case 'markdown':
      return markdown()
    default:
      return []
  }
}

// ---------- the editor ----------

export interface SourceEditorOptions {
  dark: boolean
  readonly: boolean
  /** A document change of `path` (typing, paste, undo). */
  onChange: (path: string, content: string) => void
}

export interface SourceEditorController {
  /** Shows `path` with `content` (a stored state is reused when its text matches, keeping its history). */
  show: (path: string, content: string) => void
  /** Replaces the text of the shown file (a reload from the server); no change event. */
  replace: (content: string) => void
  /** Build diagnostics of the shown file. */
  setDiagnostics: (diagnostics: readonly BuildDiagnostic[]) => void
  setDark: (dark: boolean) => void
  setReadOnly: (readonly: boolean) => void
  /** Drops the stored state of a closed or renamed file. */
  forget: (path: string) => void
  focus: () => void
  /** Moves the cursor to a 1-based line and byte column and scrolls it into view. */
  goTo: (line: number, column?: number | null) => void
  /** The text of the shown file. */
  content: () => string
  readonly view: EditorView
  destroy: () => void
}

/** Marks programmatic replacements so they do not report a change. */
const SILENT_USER_EVENT = 'hf.replace'

export function createSourceEditor(parent: HTMLElement, options: SourceEditorOptions): SourceEditorController {
  const theme = new Compartment()
  const editable = new Compartment()
  const states = new Map<string, EditorState>()
  let dark = options.dark
  let readonly = options.readonly
  let activePath: string | null = null

  const readOnlyExtension = (value: boolean): Extension => [EditorState.readOnly.of(value), EditorView.editable.of(!value)]

  function createState(path: string, content: string): EditorState {
    return EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        indentKeymap,
        EditorState.tabSize.of(2),
        languageExtension(languageOf(path)),
        theme.of(themeExtension(dark)),
        editable.of(readOnlyExtension(readonly)),
        diagnosticsGutter(),
        EditorView.contentAttributes.of({ 'aria-label': `Contents of ${path}` }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || activePath === null)
            return
          if (update.transactions.every(transaction => transaction.isUserEvent(SILENT_USER_EVENT)))
            return
          options.onChange(activePath, update.state.doc.toString())
        }),
      ],
    })
  }

  /** A stored state with the current theme and read-only mode. */
  function refreshed(state: EditorState): EditorState {
    return state.update({
      effects: [theme.reconfigure(themeExtension(dark)), editable.reconfigure(readOnlyExtension(readonly))],
    }).state
  }

  const view = new EditorView({ parent, state: createState('untitled', '') })

  return {
    view,
    show: (path, content) => {
      if (path === activePath && view.state.doc.toString() === content)
        return
      if (activePath !== null)
        states.set(activePath, view.state)
      const stored = states.get(path)
      const state = stored && stored.doc.toString() === content ? refreshed(stored) : createState(path, content)
      activePath = path
      view.setState(state)
    },
    replace: (content) => {
      if (view.state.doc.toString() === content)
        return
      view.dispatch({
        ...setDiagnostics(view.state, []),
        changes: { from: 0, to: view.state.doc.length, insert: content },
        userEvent: SILENT_USER_EVENT,
      })
    },
    setDiagnostics: (diagnostics) => {
      const placed = placeDiagnostics(view.state.doc, diagnostics)
      const spec = setDiagnostics(view.state, placed)
      const announcement = diagnosticsAnnouncement(view.state.doc, placed)
      const effects = [spec.effects ?? []].flat()
      view.dispatch(announcement ? { ...spec, effects: [...effects, EditorView.announce.of(announcement)] } : spec)
    },
    setDark: (value) => {
      dark = value
      view.dispatch({ effects: theme.reconfigure(themeExtension(dark)) })
      for (const [path, state] of states)
        states.set(path, refreshed(state))
    },
    setReadOnly: (value) => {
      readonly = value
      view.dispatch({ effects: editable.reconfigure(readOnlyExtension(readonly)) })
      for (const [path, state] of states)
        states.set(path, refreshed(state))
    },
    forget: (path) => {
      states.delete(path)
    },
    focus: () => view.focus(),
    goTo: (line, column) => {
      const doc = view.state.doc
      const target = doc.line(Math.min(Math.max(line, 1), doc.lines))
      const offset = column == null ? 0 : Math.min(byteColumnToIndex(target.text, column), target.length)
      const position = target.from + offset
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) })
      view.focus()
    },
    content: () => view.state.doc.toString(),
    destroy: () => {
      states.clear()
      view.destroy()
    },
  }
}
