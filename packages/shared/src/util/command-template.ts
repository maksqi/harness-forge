/**
 * Command file extras (Phase 11, ADR-052): `` !`cmd` `` spans (one line, a non-empty command, no backtick inside) run
 * in the project folder before the model call and their output replaces them; `@path` references (the `mentions.ts`
 * grammar, holding a `.` or `/`, never inside a span) inline a project file. The body is scanned BEFORE the arguments
 * are expanded, and `expandArguments` then runs on the text parts only, so arguments are never substituted inside a
 * span. The server runs the spans and reads the files; this module only scans and renders. Pure and isomorphic; never
 * throws. Contract skeleton written by the coordinator in P11-0a (K1); implemented by C35.
 *
 * Scanning rules:
 * - Fenced code blocks (a line starting with up to three spaces and at least three backticks or tildes, closed by a
 *   line with at least as many of the same character, else running to the end) are plain text: neither spans nor
 *   references are recognized inside them.
 * - A span is `!` + a backtick + the command + a backtick on one line; the command (trimmed) must not be empty (an
 *   `empty-span` warning; it stays text). Spans after the tenth stay text (`too-many-spans`).
 * - A reference is a mention of `parseMentions` (an `@` at the start or after whitespace; e-mail addresses never match)
 *   whose path holds `.` or `/`, outside fences and spans (a mention that overlaps a span is not a reference). Absolute
 *   paths, `~` and `..` segments stay text (`invalid-path`); paths are normalized (`./` and `.` segments removed,
 *   slashes collapsed). Distinct paths after the tenth stay text (`too-many-files`).
 * - Only the first `SCAN_MAX_CHARS` characters are scanned; the rest is text.
 */
import { expandArguments } from './arguments.ts'
import { parseMentions } from './mentions.ts'

/** Mirrored by the Phase 11 group of `LIMITS`. */
export const COMMAND_TEMPLATE_LIMITS = {
  shellSpansMax: 10,
  fileRefsMax: 10,
  /** Output kept per span. */
  shellOutputBytes: 16_384,
  /** Content kept per inlined file. */
  fileRefBytes: 32_768,
} as const

export type CommandTemplatePart
  = | { readonly kind: 'text', readonly text: string }
    | { readonly kind: 'shell', readonly command: string, readonly index: number }
    | { readonly kind: 'file', readonly path: string, readonly raw: string, readonly index: number }

export interface CommandTemplateDiagnostic {
  readonly level: 'error' | 'warning' | 'info'
  readonly code: 'too-many-spans' | 'too-many-files' | 'empty-span' | 'invalid-path'
  readonly message: string
}

export interface CommandTemplatePlan {
  readonly parts: readonly CommandTemplatePart[]
  /** The span commands, in order (≤ `COMMAND_TEMPLATE_LIMITS.shellSpansMax`; later spans stay text). */
  readonly shellCommands: readonly string[]
  /** The referenced paths, in order, without duplicates (≤ `COMMAND_TEMPLATE_LIMITS.fileRefsMax`). */
  readonly filePaths: readonly string[]
  readonly diagnostics: readonly CommandTemplateDiagnostic[]
}

/** Characters scanned for spans and references (command bodies are ≤ 64 KiB). */
const SCAN_MAX_CHARS = 262_144

interface Range {
  readonly start: number
  readonly end: number
}

type Token
  = | { readonly kind: 'shell', readonly start: number, readonly end: number, readonly command: string }
    | { readonly kind: 'file', readonly start: number, readonly end: number, readonly path: string }

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

/** The ranges of fenced code blocks (whole lines, the fence lines included). */
function fenceRanges(text: string): Range[] {
  const ranges: Range[] = []
  let fence: { char: string, length: number, start: number } | null = null
  let lineStart = 0
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(lineStart, lineEnd)
    const next = newline === -1 ? text.length + 1 : newline + 1
    if (fence === null) {
      const open = line.match(FENCE_OPEN)
      // A backtick fence's info string may not hold a backtick.
      if (open !== null && !(open[1]?.startsWith('`') && line.slice((open[0] ?? '').length).includes('`')))
        fence = { char: open[1]?.[0] ?? '`', length: open[1]?.length ?? 3, start: lineStart }
    }
    else {
      const trimmed = line.replace(/^ {0,3}/, '')
      let count = 0
      while (trimmed[count] === fence.char)
        count++
      if (count >= fence.length && trimmed.slice(count).trim() === '') {
        ranges.push({ start: fence.start, end: lineEnd })
        fence = null
      }
    }
    lineStart = next
  }
  if (fence !== null)
    ranges.push({ start: fence.start, end: text.length })
  return ranges
}

/**
 * An overlap test for sorted, non-overlapping ranges, asked with non-decreasing `start` values (amortized linear: the
 * pointer only moves forward).
 */
function overlapChecker(ranges: readonly Range[]): (start: number, end: number) => boolean {
  let pointer = 0
  return (start, end) => {
    while (pointer < ranges.length && (ranges[pointer] as Range).end <= start)
      pointer++
    for (let index = pointer; index < ranges.length; index++) {
      const range = ranges[index] as Range
      if (range.start >= end)
        return false
      if (start < range.end && end > range.start)
        return true
    }
    return false
  }
}

interface SpanScan {
  readonly spans: { readonly start: number, readonly end: number, readonly command: string }[]
  readonly empty: number
}

/** Every `` !`cmd` `` outside the fences (the command trimmed; empty commands are counted, not returned). */
function scanSpans(text: string, fences: readonly Range[]): SpanScan {
  const spans: { start: number, end: number, command: string }[] = []
  const inFence = overlapChecker(fences)
  let empty = 0
  let newline = text.indexOf('\n')
  let index = text.indexOf('!`')
  while (index !== -1) {
    const close = text.indexOf('`', index + 2)
    if (close === -1)
      break
    if (newline !== -1 && newline < index + 2)
      newline = text.indexOf('\n', index + 2)
    if (newline !== -1 && newline < close) {
      index = text.indexOf('!`', newline + 1)
      continue
    }
    const end = close + 1
    if (inFence(index, end)) {
      index = text.indexOf('!`', index + 1)
      continue
    }
    const command = text.slice(index + 2, close).trim()
    if (command === '') {
      empty++
      index = text.indexOf('!`', end)
      continue
    }
    spans.push({ start: index, end, command })
    index = text.indexOf('!`', end)
  }
  return { spans, empty }
}

/** The normal form of a referenced path, or null when it may not be referenced. */
function normalizePath(path: string): string | null {
  if (path.startsWith('/') || path.startsWith('~') || path.startsWith('\\') || /^[A-Z]:/i.test(path))
    return null
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index)
    if (code < 0x20 || code === 0x7F)
      return null
  }
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.')
      continue
    if (segment === '..')
      return null
    segments.push(segment)
  }
  if (segments.length === 0)
    return null
  return `${segments.join('/')}${path.endsWith('/') ? '/' : ''}`
}

/** Scans a command body for spans and file references. */
export function planCommandExpansion(body: string): CommandTemplatePlan {
  const source = typeof body === 'string' ? body : ''
  try {
    return planUnchecked(source)
  }
  catch {
    return { parts: source === '' ? [] : [{ kind: 'text', text: source }], shellCommands: [], filePaths: [], diagnostics: [] }
  }
}

function planUnchecked(source: string): CommandTemplatePlan {
  const text = source.slice(0, SCAN_MAX_CHARS)
  const diagnostics: CommandTemplateDiagnostic[] = []
  const fences = fenceRanges(text)
  const scan = scanSpans(text, fences)
  if (scan.empty > 0) {
    const message = scan.empty === 1 ? 'A !`…` span has no command; it stays text.' : `${scan.empty} !\`…\` spans have no command; they stay text.`
    diagnostics.push({ level: 'warning', code: 'empty-span', message })
  }
  const max = COMMAND_TEMPLATE_LIMITS.shellSpansMax
  if (scan.spans.length > max) {
    const more = scan.spans.length - max
    diagnostics.push({ level: 'warning', code: 'too-many-spans', message: `Only the first ${max} !\`…\` spans run; ${more} more ${more === 1 ? 'stays' : 'stay'} text.` })
  }
  const spans = scan.spans.slice(0, max)
  const tokens: Token[] = spans.map(span => ({ kind: 'shell', ...span }))

  const filePaths: string[] = []
  const inFence = overlapChecker(fences)
  const inSpan = overlapChecker(scan.spans)
  let invalid = 0
  let dropped = 0
  for (const mention of parseMentions(text)) {
    if (!mention.path.includes('.') && !mention.path.includes('/'))
      continue
    if (inFence(mention.start, mention.end) || inSpan(mention.start, mention.end))
      continue
    const path = normalizePath(mention.path)
    if (path === null) {
      invalid++
      continue
    }
    if (!filePaths.includes(path)) {
      if (filePaths.length >= COMMAND_TEMPLATE_LIMITS.fileRefsMax) {
        dropped++
        continue
      }
      filePaths.push(path)
    }
    tokens.push({ kind: 'file', start: mention.start, end: mention.end, path })
  }
  if (invalid > 0) {
    const message = invalid === 1
      ? 'A file reference points outside the project (an absolute path, "~" or ".."); it stays text.'
      : `${invalid} file references point outside the project (an absolute path, "~" or ".."); they stay text.`
    diagnostics.push({ level: 'warning', code: 'invalid-path', message })
  }
  if (dropped > 0) {
    const fileMax = COMMAND_TEMPLATE_LIMITS.fileRefsMax
    diagnostics.push({ level: 'warning', code: 'too-many-files', message: `Only the first ${fileMax} files are inlined; ${dropped} more ${dropped === 1 ? 'reference stays' : 'references stay'} text.` })
  }

  tokens.sort((a, b) => a.start - b.start)
  const parts: CommandTemplatePart[] = []
  let cursor = 0
  const pushText = (value: string): void => {
    if (value === '')
      return
    const last = parts.at(-1)
    if (last?.kind === 'text')
      parts[parts.length - 1] = { kind: 'text', text: last.text + value }
    else
      parts.push({ kind: 'text', text: value })
  }
  let shellIndex = 0
  for (const token of tokens) {
    if (token.start < cursor)
      continue
    pushText(text.slice(cursor, token.start))
    if (token.kind === 'shell')
      parts.push({ kind: 'shell', command: token.command, index: shellIndex++ })
    else
      parts.push({ kind: 'file', path: token.path, raw: text.slice(token.start, token.end), index: filePaths.indexOf(token.path) })
    cursor = token.end
  }
  pushText(source.slice(cursor))
  return { parts, shellCommands: spans.map(span => span.command), filePaths, diagnostics }
}

export interface ShellSpanResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  /** stdout + stderr as captured (already capped by the runner). */
  readonly output: string
  readonly truncated: boolean
  /** Set when the span did not run (`time-limit`: the total budget was used up). */
  readonly skipped?: 'time-limit'
}

export interface FileBlock {
  readonly path: string
  readonly content: string
  readonly truncated: boolean
  /** True when the file is binary (its content is not inlined). */
  readonly binary?: boolean
}

/** UTF-8 length of `text`; stops counting once it passes `limit`. */
function utf8LengthUpTo(text: string, limit: number): number {
  let bytes = 0
  for (let index = 0; index < text.length && bytes <= limit; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    }
    else if (code < 0x800) {
      bytes += 2
    }
    else if (code >= 0xD800 && code <= 0xDBFF && (text.charCodeAt(index + 1) & 0xFC00) === 0xDC00) {
      bytes += 4
      index++
    }
    else {
      bytes += 3
    }
  }
  return bytes
}

/** `text` cut to at most `maxBytes` UTF-8 bytes (never inside a surrogate pair); `cut` tells whether it was cut. */
function cutBytes(text: string, maxBytes: number): { text: string, cut: boolean } {
  if (utf8LengthUpTo(text, maxBytes) <= maxBytes)
    return { text, cut: false }
  let bytes = 0
  let index = 0
  while (index < text.length) {
    const code = text.charCodeAt(index)
    const pair = code >= 0xD800 && code <= 0xDBFF && (text.charCodeAt(index + 1) & 0xFC00) === 0xDC00
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3
    if (bytes + size > maxBytes)
      break
    bytes += size
    index += pair ? 2 : 1
  }
  return { text: text.slice(0, index), cut: true }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * The text that replaces one span: the output (trailing whitespace removed, cut to
 * `COMMAND_TEMPLATE_LIMITS.shellOutputBytes`), then a note on its own line for a cut output (`[output truncated]`), a
 * timeout (`[timed out]`), a non-zero exit (`[exit code N]`) or a process that did not exit (`[did not finish]`); a
 * skipped span is `[skipped: time limit]`. An empty successful output is ''.
 */
export function formatShellSpanOutput(result: ShellSpanResult): string {
  if (typeof result !== 'object' || result === null)
    return '[skipped]'
  if (result.skipped === 'time-limit')
    return '[skipped: time limit]'
  const raw = typeof result.output === 'string' ? result.output : ''
  const capped = cutBytes(raw, COMMAND_TEMPLATE_LIMITS.shellOutputBytes)
  const notes: string[] = []
  if (capped.cut || result.truncated === true)
    notes.push('[output truncated]')
  if (result.timedOut === true)
    notes.push('[timed out]')
  else if (typeof result.exitCode === 'number' && result.exitCode !== 0)
    notes.push(`[exit code ${result.exitCode}]`)
  else if (result.exitCode === null)
    notes.push('[did not finish]')
  return [capped.text.trimEnd(), ...notes].filter(line => line !== '').join('\n')
}

export interface RenderedCommand {
  readonly text: string
  /** True when the text parts contained an argument placeholder (`expandArguments`); otherwise the input is appended. */
  readonly usedPlaceholder: boolean
}

function fileBlockText(path: string, block: FileBlock): string {
  const attributes = [`path="${escapeAttribute(path)}"`]
  if (block.binary === true)
    return `<file ${attributes.join(' ')} binary="true">\n[binary file not inlined]\n</file>`
  const content = typeof block.content === 'string' ? block.content : ''
  const capped = cutBytes(content, COMMAND_TEMPLATE_LIMITS.fileRefBytes)
  if (capped.cut || block.truncated === true)
    attributes.push('truncated="true"')
  return `<file ${attributes.join(' ')}>\n${capped.text.replace(/\n$/, '')}\n</file>`
}

/**
 * Renders the expansion: span outputs in place (`formatShellSpanOutput`; a span without a result is `[skipped]`), file
 * references kept as written, arguments expanded on the text parts only (`expandArguments`; never inside a span, a span
 * output or a file), the trimmed input appended after a blank line when no text part used a placeholder (the Phase 10
 * rule), then one `<file path="…">…</file>` block per file that was read (null = not read: no block), in reference
 * order, each after a blank line. A body without spans and references renders exactly like `expandArguments`.
 */
export function renderCommandExpansion(
  plan: CommandTemplatePlan,
  results: { readonly shell: readonly ShellSpanResult[], readonly files: readonly (FileBlock | null)[] },
  input: string,
): RenderedCommand {
  const parts = typeof plan === 'object' && plan !== null && Array.isArray(plan.parts) ? plan.parts : []
  const filePaths = typeof plan === 'object' && plan !== null && Array.isArray(plan.filePaths) ? plan.filePaths : []
  const shell = typeof results === 'object' && results !== null && Array.isArray(results.shell) ? results.shell : []
  const files = typeof results === 'object' && results !== null && Array.isArray(results.files) ? results.files : []
  const trimmed = typeof input === 'string' ? input.trim() : ''
  let usedPlaceholder = false
  let text = ''
  for (const part of parts) {
    if (part.kind === 'text') {
      const expanded = expandArguments(part.text, trimmed)
      if (expanded.usedPlaceholder) {
        usedPlaceholder = true
        text += expanded.text
      }
      else {
        text += part.text
      }
    }
    else if (part.kind === 'shell') {
      const result = shell[part.index]
      text += result === undefined ? '[skipped]' : formatShellSpanOutput(result)
    }
    else {
      text += part.raw
    }
  }
  if (!usedPlaceholder && trimmed !== '')
    text = `${text}\n\n${trimmed}`
  const blocks: string[] = []
  filePaths.forEach((path, index) => {
    const block = files[index]
    if (typeof block === 'object' && block !== null)
      blocks.push(fileBlockText(path, block))
  })
  if (blocks.length > 0)
    text = `${text}\n\n${blocks.join('\n\n')}`
  return { text, usedPlaceholder }
}
