// Diffs of `write_file` and `edit_file` (Phase 7, ADR-032): `structuredPatch` of `diff` with 3 lines of context, in its
// async mode with a 2 s timeout (`null` when it gives up), turned into the shared `WorkspaceDiff`: `added` / `removed`
// count the whole change, lines are cut at `WORKSPACE_LIMITS.diffLineMaxChars` (a trailing `\r` is dropped for display)
// and the hunks are cut to `WORKSPACE_LIMITS.diffMaxBytes` of serialized JSON (`truncated: true`; a hunk cut in the
// middle keeps its header). An empty side of a hunk starts at the line before it (0 for an empty file), as in a printed
// unified diff.
import type { WorkspaceDiff } from '@harness-forge/shared'
import type { StructuredPatch } from 'diff'
import { WORKSPACE_LIMITS } from '@harness-forge/shared'
import { structuredPatch } from 'diff'
import { cutLine, jsonBytes } from './text.ts'

/** Lines of context around each change. */
export const DIFF_CONTEXT_LINES = 3
/** `structuredPatch` gives up after this long (`diff: null`). */
export const DIFF_TIMEOUT_MS = 2000

export interface DiffOptions {
  /** Default `DIFF_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Default `WORKSPACE_LIMITS.diffMaxBytes`. */
  maxBytes?: number
  /** Default `WORKSPACE_LIMITS.diffLineMaxChars`. */
  lineMaxChars?: number
}

/** The raw structured patch, or null when the diff timed out. */
function patchOf(oldText: string, newText: string, timeoutMs: number): Promise<StructuredPatch | null> {
  return new Promise((resolve, reject) => {
    try {
      structuredPatch('a', 'b', oldText, newText, undefined, undefined, {
        context: DIFF_CONTEXT_LINES,
        timeout: timeoutMs,
        callback: patch => resolve(patch ?? null),
      })
    }
    catch (error) {
      reject(error)
    }
  })
}

/** A diff line for display: a trailing `\r` dropped, cut at `maxChars` (the prefix character included). */
function displayLine(line: string, maxChars: number): { text: string, cut: boolean } {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
  const kept = cutLine(text, maxChars)
  return { text: kept, cut: kept.length < text.length }
}

/**
 * Turns a structured patch into a `WorkspaceDiff` (counts of the whole change, lines and hunks cut to the limits).
 * Exported for tests.
 */
export function toWorkspaceDiff(patch: Pick<StructuredPatch, 'hunks'>, options: DiffOptions = {}): WorkspaceDiff {
  const maxBytes = options.maxBytes ?? WORKSPACE_LIMITS.diffMaxBytes
  const lineMaxChars = options.lineMaxChars ?? WORKSPACE_LIMITS.diffLineMaxChars
  let added = 0
  let removed = 0
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+'))
        added++
      else if (line.startsWith('-'))
        removed++
    }
  }

  const diff: WorkspaceDiff = { hunks: [], added, removed, truncated: false }
  let bytes = jsonBytes(diff)
  for (const hunk of patch.hunks) {
    // Unified diff convention (as `formatPatch` prints it): an empty side starts at the line before it (0 for an empty file).
    const header = {
      oldStart: hunk.oldLines === 0 ? Math.max(hunk.oldStart - 1, 0) : hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newLines === 0 ? Math.max(hunk.newStart - 1, 0) : hunk.newStart,
      newLines: hunk.newLines,
      lines: [] as string[],
    }
    // The hunk object plus the comma before it.
    const headerBytes = jsonBytes(header) + 1
    if (bytes + headerBytes > maxBytes) {
      diff.truncated = true
      break
    }
    bytes += headerBytes
    diff.hunks.push(header)
    let cut = false
    for (const raw of hunk.lines) {
      const { text: line, cut: lineCut } = displayLine(raw, lineMaxChars)
      if (lineCut)
        diff.truncated = true
      const lineBytes = jsonBytes(line) + 1
      if (bytes + lineBytes > maxBytes) {
        cut = true
        break
      }
      bytes += lineBytes
      header.lines.push(line)
    }
    if (cut) {
      diff.truncated = true
      break
    }
  }
  return diff
}

/**
 * The diff from `oldText` to `newText` for the UI, or null when `structuredPatch` did not finish within the timeout.
 * The computation is async (it yields to the event loop between its steps).
 */
export async function computeWorkspaceDiff(oldText: string, newText: string, options: DiffOptions = {}): Promise<WorkspaceDiff | null> {
  const patch = await patchOf(oldText, newText, options.timeoutMs ?? DIFF_TIMEOUT_MS)
  return patch === null ? null : toWorkspaceDiff(patch, options)
}
