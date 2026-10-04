// CodeMirror 6 setup of the Source tab (docs/UI.md 8.10): one EditorView whose state is swapped per open file (each
// file keeps its own undo history and selection), languages by extension, the one-dark theme in dark mode and a light
// theme from the design tokens, JetBrains Mono 13px, a read-only mode, Tab indentation (`@codemirror/commands`), and
// build diagnostics through `@codemirror/lint` (wavy underline, hover tooltip, the keyboard-accessible diagnostics
// panel on Mod-Shift-M and F8) plus a gutter marker per line (its title shows the messages on hover; the gutter is
// hidden from assistive technology, so new diagnostics are also announced through the editor's live region).
// Messages are text only.
// Loaded with a dynamic import by SourceEditor.vue, so CodeMirror is only downloaded when the Source tab opens.
// Phase 10 (docs/UI.md 9.12, 11.7): `createMarkdownEditor`, the markdown field of Settings -> Customize (MarkdownEditor):
// line wrapping, no Tab capture (Tab and Shift+Tab move focus: no keyboard trap), Mod+Enter submits, the definition
// diagnostics that have a line as lint markers; loaded with a dynamic import by MarkdownEditor.vue.
import type { Diagnostic } from '@codemirror/lint'
import type { Extension, Text } from '@codemirror/state'
import type { BuildDiagnostic, DefinitionDiagnostic } from '@harness-forge/shared'
import type { SourceLanguage } from './source-files'
import { indentLess, indentMore } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { forEachDiagnostic, lintKeymap, setDiagnostics } from '@codemirror/lint'
import { Compartment, EditorState, Prec, RangeSet } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, gutter, GutterMarker, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { basicSetup, minimalSetup } from 'codemirror'
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

// ---------- the markdown field (Phase 10) ----------

/** A definition diagnostic placed in the document: the whole line it names. */
export interface MarkdownEditorDiagnostic extends Diagnostic {
  severity: 'error' | 'warning' | 'info'
}

/**
 * Places definition diagnostics (`parseDefinition`, the catalog) in `doc`: only those with a line, each marking that
 * whole line (clamped to the document). Their messages already start with "Line N: " and are shown as they are.
 */
export function placeDefinitionDiagnostics(doc: Text, diagnostics: readonly DefinitionDiagnostic[]): MarkdownEditorDiagnostic[] {
  const placed: MarkdownEditorDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    if (diagnostic.line === undefined)
      continue
    const line = doc.line(Math.min(Math.max(diagnostic.line, 1), doc.lines))
    placed.push({
      from: line.from,
      to: line.to,
      severity: diagnostic.level,
      message: diagnostic.message,
      markClass: `cm-hf-diagnostic-${diagnostic.level}`,
    })
  }
  return placed
}

export interface MarkdownEditorOptions {
  dark: boolean
  readonly: boolean
  /** The accessible name of the editable area (the field label). */
  label: string
  /** The id of the element that describes the editable area (help text, errors). */
  describedBy?: string
  /** A document change by the user (typing, paste, undo); never for `setValue`. */
  onChange: (value: string) => void
  /** Mod+Enter (the form saves). */
  onSubmit: () => void
}

export interface MarkdownEditorController {
  readonly view: EditorView
  /** Replaces the text (a new value from the parent); no change event, the diagnostics are cleared. */
  setValue: (value: string) => void
  /** Lint markers for the diagnostics that have a line. */
  setDiagnostics: (diagnostics: readonly DefinitionDiagnostic[]) => void
  setDark: (dark: boolean) => void
  setReadOnly: (readonly: boolean) => void
  /** A new accessible name (and description) of the editable area. */
  setLabel: (label: string, describedBy?: string) => void
  focus: () => void
  destroy: () => void
}

/** The field's height rules: the host sets the min / max height, the editor follows it and scrolls inside. */
const markdownFieldTheme = EditorView.theme({
  '&': { height: 'auto', minHeight: 'inherit', maxHeight: 'inherit', fontSize: '13px' },
  '.cm-scroller': { overflow: 'auto', minHeight: 'inherit' },
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 10px 0 6px' },
})

/**
 * The markdown field of Settings -> Customize (docs/UI.md 9.12, 11.7): CodeMirror with markdown highlighting, line
 * numbers, line wrapping and undo, the one-dark theme in dark mode, a read-only mode (`aria-readonly`), lint markers
 * from definition diagnostics. Tab is never bound (no `indentWithTab`), so Tab and Shift+Tab move focus; Mod+Enter
 * calls `onSubmit` (it outranks the default "insert blank line").
 */
export function createMarkdownEditor(parent: HTMLElement, options: MarkdownEditorOptions): MarkdownEditorController {
  const theme = new Compartment()
  const editable = new Compartment()
  const labelled = new Compartment()
  let dark = options.dark
  let readonly = options.readonly

  let describedBy = options.describedBy
  const labelExtension = (label: string): Extension => EditorView.contentAttributes.of({
    'aria-label': label,
    'aria-multiline': 'true',
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
  })
  const readOnlyExtension = (value: boolean): Extension => [
    EditorState.readOnly.of(value),
    EditorView.editable.of(!value),
    EditorView.contentAttributes.of(value ? { 'aria-readonly': 'true' } : {}),
  ]

  const submitKeymap = Prec.highest(keymap.of([{
    key: 'Mod-Enter',
    run: () => {
      options.onSubmit()
      return true
    },
  }]))

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        submitKeymap,
        minimalSetup,
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        keymap.of(lintKeymap),
        EditorView.lineWrapping,
        markdown(),
        theme.of(themeExtension(dark)),
        markdownFieldTheme,
        editable.of(readOnlyExtension(readonly)),
        diagnosticsGutter(),
        labelled.of(labelExtension(options.label)),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged)
            return
          if (update.transactions.every(transaction => transaction.isUserEvent(SILENT_USER_EVENT)))
            return
          options.onChange(update.state.doc.toString())
        }),
      ],
    }),
  })

  return {
    view,
    setValue: (value) => {
      if (view.state.doc.toString() === value)
        return
      view.dispatch({
        ...setDiagnostics(view.state, []),
        changes: { from: 0, to: view.state.doc.length, insert: value },
        userEvent: SILENT_USER_EVENT,
      })
    },
    setDiagnostics: (diagnostics) => {
      view.dispatch(setDiagnostics(view.state, placeDefinitionDiagnostics(view.state.doc, diagnostics)))
    },
    setDark: (value) => {
      if (value === dark)
        return
      dark = value
      view.dispatch({ effects: theme.reconfigure(themeExtension(dark)) })
    },
    setReadOnly: (value) => {
      if (value === readonly)
        return
      readonly = value
      view.dispatch({ effects: editable.reconfigure(readOnlyExtension(readonly)) })
    },
    setLabel: (label, nextDescribedBy) => {
      describedBy = nextDescribedBy
      view.dispatch({ effects: labelled.reconfigure(labelExtension(label)) })
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  }
}
