// Line diff for approval previews (docs/UI.md 7.19, 11.4; W7.11): the client diffs only the small snippets of an
// `edit_file` approval (`old_string` -> `new_string`); finished edits show the server's hunks. No dependency: a small
// LCS over lines with 3 lines of context; past `maxCells` (the LCS table size) one hunk removes every old line, then
// adds every new line. CRLF is compared as LF; a missing trailing newline is not a change of its own.
// Signature frozen from Gate P7-0b (C15).
import type { DiffHunk } from '@harness-forge/shared'

export interface DiffLinesOptions {
  /** Unchanged lines kept around each change; default 3. */
  context?: number
  /** Cap of the LCS table (old lines x new lines); default 4e6. */
  maxCells?: number
}

const DEFAULT_CONTEXT = 3
const DEFAULT_MAX_CELLS = 4e6

/** One step of the edit script: a kept, removed or added line. */
interface DiffOp {
  sign: ' ' | '-' | '+'
  text: string
}

/** The lines of `text` with LF endings; one trailing newline ends the last line instead of adding an empty one. */
export function splitLines(text: string): string[] {
  if (text === '')
    return []
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.at(-1) === '')
    lines.pop()
  return lines
}

/** The edit script of a longest common subsequence (removals before additions inside a change). */
function lcsScript(a: readonly string[], b: readonly string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  const width = m + 1
  // suffix[i * width + j] = LCS length of a[i..] and b[j..]; under the default cap min(n, m) <= 2000.
  const suffix = Math.min(n, m) < 0xFFFF ? new Uint16Array((n + 1) * width) : new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      suffix[i * width + j] = a[i] === b[j]
        ? suffix[(i + 1) * width + j + 1]! + 1
        : Math.max(suffix[(i + 1) * width + j]!, suffix[i * width + j + 1]!)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ sign: ' ', text: a[i]! })
      i++
      j++
    }
    else if (suffix[(i + 1) * width + j]! >= suffix[i * width + j + 1]!) {
      ops.push({ sign: '-', text: a[i]! })
      i++
    }
    else {
      ops.push({ sign: '+', text: b[j]! })
      j++
    }
  }
  while (i < n)
    ops.push({ sign: '-', text: a[i++]! })
  while (j < m)
    ops.push({ sign: '+', text: b[j++]! })
  return ops
}

/** Groups an edit script into unified-diff hunks with `context` kept lines around each change. */
function toHunks(ops: readonly DiffOp[], context: number): DiffHunk[] {
  // Line numbers before each op (0-based counts of old / new lines already passed).
  const oldBefore: number[] = []
  const newBefore: number[] = []
  let oldCount = 0
  let newCount = 0
  for (const op of ops) {
    oldBefore.push(oldCount)
    newBefore.push(newCount)
    if (op.sign !== '+')
      oldCount++
    if (op.sign !== '-')
      newCount++
  }

  const changes = ops.flatMap((op, index) => (op.sign === ' ' ? [] : [index]))
  const hunks: DiffHunk[] = []
  let cursor = 0
  while (cursor < changes.length) {
    const first = changes[cursor]!
    let last = first
    // Merge the next change while the kept lines between them fit in two contexts.
    while (cursor + 1 < changes.length && changes[cursor + 1]! - last - 1 <= 2 * context) {
      cursor++
      last = changes[cursor]!
    }
    cursor++
    const start = Math.max(0, first - context)
    const end = Math.min(ops.length - 1, last + context)
    const slice = ops.slice(start, end + 1)
    const oldLines = slice.filter(op => op.sign !== '+').length
    const newLines = slice.filter(op => op.sign !== '-').length
    hunks.push({
      // 1-based first line; for an empty side the count of lines before it (0 at the top of the file).
      oldStart: oldLines === 0 ? oldBefore[start]! : oldBefore[start]! + 1,
      oldLines,
      newStart: newLines === 0 ? newBefore[start]! : newBefore[start]! + 1,
      newLines,
      lines: slice.map(op => `${op.sign}${op.text}`),
    })
  }
  return hunks
}

/** The hunks that turn `a` into `b` (lines prefixed `' '`, `'+'` or `'-'`, like the server's `DiffHunk`). */
export function diffLines(a: string, b: string, opts?: DiffLinesOptions): DiffHunk[] {
  const context = Math.max(0, Math.floor(opts?.context ?? DEFAULT_CONTEXT))
  const maxCells = opts?.maxCells ?? DEFAULT_MAX_CELLS
  const oldLines = splitLines(a)
  const newLines = splitLines(b)
  if (oldLines.length === newLines.length && oldLines.every((line, index) => line === newLines[index]))
    return []
  if (oldLines.length * newLines.length > maxCells) {
    return [{
      oldStart: oldLines.length === 0 ? 0 : 1,
      oldLines: oldLines.length,
      newStart: newLines.length === 0 ? 0 : 1,
      newLines: newLines.length,
      lines: [...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)],
    }]
  }
  return toHunks(lcsScript(oldLines, newLines), context)
}
