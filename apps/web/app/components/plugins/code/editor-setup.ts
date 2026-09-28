// CodeMirror 6 setup of the Source tab (docs/UI.md 8.10): one EditorView whose state is swapped per open file (each
// file keeps its own undo history and selection), languages by extension, the one-dark theme in dark mode and a light
// theme from the design tokens, JetBrains Mono 13px, a read-only mode, Tab indentation, and build diagnostics shown as
// lint markers: a gutter marker per line, a wavy underline and a hover tooltip (all rendered with textContent).
// Loaded with a dynamic import by SourceEditor.vue, so CodeMirror is only downloaded when the Source tab opens.
import type { ChangeSpec, Extension, Text } from '@codemirror/state'
import type { DecorationSet, Tooltip } from '@codemirror/view'
import type { BuildDiagnostic } from '@harness-forge/shared'
import type { SourceLanguage } from './source-files'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorSelection, EditorState, RangeSet, StateEffect, StateField } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { Decoration, EditorView, gutter, GutterMarker, hoverTooltip, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { byteColumnToIndex, languageOf } from './source-files'

/** A diagnostic placed in the document (UTF-16 offsets). */
export interface EditorDiagnostic {
  from: number
  to: number
  severity: 'error' | 'warning'
  message: string
}

const INDENT = '  '
const WORD_START = /^[\w$]+/
const LEADING_INDENT = /^ {0,2}/

// ---------- diagnostics ----------

const setDiagnosticsEffect = StateEffect.define<EditorDiagnostic[]>()

interface DiagnosticsValue {
  items: EditorDiagnostic[]
  marks: DecorationSet
}

function markDecorations(items: readonly EditorDiagnostic[], length: number): DecorationSet {
  const ranges = items
    .map((item) => {
      const from = Math.min(item.from, length)
      const to = Math.min(Math.max(item.to, from + 1), length)
      return to > from ? Decoration.mark({ class: `cm-hf-diagnostic-${item.severity}` }).range(from, to) : null
    })
    .filter(range => range !== null)
  return Decoration.set(ranges, true)
}

const diagnosticsField = StateField.define<DiagnosticsValue>({
  create: () => ({ items: [], marks: Decoration.none }),
  update(value, transaction) {
    let next = value
    if (transaction.docChanged) {
      next = {
        items: value.items.map(item => ({ ...item, from: transaction.changes.mapPos(item.from), to: transaction.changes.mapPos(item.to, 1) })),
        marks: value.marks.map(transaction.changes),
      }
    }
    for (const effect of transaction.effects) {
      if (effect.is(setDiagnosticsEffect))
        next = { items: effect.value, marks: markDecorations(effect.value, transaction.state.doc.length) }
    }
    return next
  },
  provide: field => EditorView.decorations.from(field, value => value.marks),
})

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
    marker.setAttribute('aria-label', this.message)
    marker.setAttribute('role', 'img')
    return marker
  }
}

function lintGutter(): Extension {
  return gutter({
    class: 'cm-hf-lint-gutter',
    markers: (view) => {
      const { items } = view.state.field(diagnosticsField)
      const byLine = new Map<number, EditorDiagnostic[]>()
      for (const item of items) {
        const line = view.state.doc.lineAt(Math.min(item.from, view.state.doc.length))
        byLine.set(line.from, [...(byLine.get(line.from) ?? []), item])
      }
      const markers = [...byLine.entries()].map(([from, lineItems]) => {
        const severity = lineItems.some(item => item.severity === 'error') ? 'error' : 'warning'
        return new DiagnosticMarker(severity, lineItems.map(item => item.message).join('\n')).range(from)
      })
      return RangeSet.of(markers, true)
    },
    initialSpacer: () => new DiagnosticMarker('error', ''),
  })
}

const diagnosticsTooltip = hoverTooltip((view, pos): Tooltip | null => {
  const hits = view.state.field(diagnosticsField).items.filter(item => pos >= item.from && pos <= Math.max(item.to, item.from + 1))
  if (hits.length === 0)
    return null
  return {
    pos: Math.min(...hits.map(item => item.from)),
    end: Math.max(...hits.map(item => item.to)),
    above: true,
    create: () => {
      const dom = document.createElement('div')
      dom.className = 'cm-hf-lint-tooltip'
      for (const hit of hits) {
        const row = document.createElement('div')
        row.className = `cm-hf-lint-tooltip-row cm-hf-lint-tooltip-${hit.severity}`
        row.textContent = hit.message
        dom.append(row)
      }
      return { dom }
    },
  }
})

/** Places build diagnostics of one file in `doc` (1-based lines, 1-based UTF-8 byte columns). */
export function placeDiagnostics(doc: Text, diagnostics: readonly BuildDiagnostic[]): EditorDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const lineNumber = Math.min(Math.max(diagnostic.line ?? 1, 1), doc.lines)
    const line = doc.line(lineNumber)
    const offset = diagnostic.column === null ? 0 : Math.min(byteColumnToIndex(line.text, diagnostic.column), line.length)
    // Underline the word at the position (or one character); a diagnostic at the end of a line marks the whole line.
    if (offset >= line.length)
      return { from: line.from, to: line.to, severity: diagnostic.severity, message: diagnostic.message }
    const word = line.text.slice(offset).match(WORD_START)?.[0].length ?? 0
    const from = line.from + offset
    return { from, to: from + Math.max(word, 1), severity: diagnostic.severity, message: diagnostic.message }
  })
}

// ---------- editing ----------

/** Tab: two spaces at an empty cursor, else indents the selected lines; Shift-Tab removes up to two spaces. */
function indentSelection(view: EditorView, direction: 1 | -1): boolean {
  const { state } = view
  if (state.readOnly)
    return false
  const transaction = state.changeByRange((range) => {
    if (direction === 1 && range.empty)
      return { changes: { from: range.from, insert: INDENT }, range: EditorSelection.cursor(range.from + INDENT.length) }
    const changes: ChangeSpec[] = []
    const first = state.doc.lineAt(range.from)
    const last = state.doc.lineAt(range.to)
    for (let number = first.number; number <= last.number; number++) {
      const line = state.doc.line(number)
      if (number > first.number && number === last.number && range.to === line.from)
        break
      if (direction === 1) {
        changes.push({ from: line.from, insert: INDENT })
      }
      else {
        const spaces = line.text.match(LEADING_INDENT)?.[0].length ?? 0
        if (spaces > 0)
          changes.push({ from: line.from, to: line.from + spaces })
      }
    }
    const set = state.changes(changes)
    return { changes: set, range: EditorSelection.range(set.mapPos(range.anchor, 1), set.mapPos(range.head, 1)) }
  })
  view.dispatch(state.update(transaction, { scrollIntoView: true, userEvent: direction === 1 ? 'input.indent' : 'delete.dedent' }))
  return true
}

const indentKeymap = keymap.of([
  { key: 'Tab', run: view => indentSelection(view, 1), shift: view => indentSelection(view, -1) },
])

// ---------- themes ----------

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-hf-lint-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 2px' },
  '.cm-hf-lint-marker': { display: 'inline-block', width: '8px', height: '8px', borderRadius: '9999px' },
  '.cm-hf-lint-marker-error': { backgroundColor: 'var(--destructive)' },
  '.cm-hf-lint-marker-warning': { backgroundColor: 'var(--warning)' },
  '.cm-hf-diagnostic-error': { textDecoration: 'underline wavy var(--destructive)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
  '.cm-hf-diagnostic-warning': { textDecoration: 'underline wavy var(--warning)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
  '.cm-tooltip.cm-tooltip-hover': { border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' },
  '.cm-hf-lint-tooltip': { maxWidth: '36rem', fontFamily: 'var(--font-sans)', fontSize: '12px', backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)' },
  '.cm-hf-lint-tooltip-row': { padding: '4px 8px', whiteSpace: 'pre-wrap', borderLeft: '3px solid transparent' },
  '.cm-hf-lint-tooltip-error': { borderLeftColor: 'var(--destructive)' },
  '.cm-hf-lint-tooltip-warning': { borderLeftColor: 'var(--warning)' },
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
        diagnosticsField,
        lintGutter(),
        diagnosticsTooltip,
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
        changes: { from: 0, to: view.state.doc.length, insert: content },
        userEvent: SILENT_USER_EVENT,
        effects: setDiagnosticsEffect.of([]),
      })
    },
    setDiagnostics: (diagnostics) => {
      view.dispatch({ effects: setDiagnosticsEffect.of(placeDiagnostics(view.state.doc, diagnostics)) })
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
