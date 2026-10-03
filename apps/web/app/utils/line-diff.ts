// Line diff for approval previews (docs/UI.md 7.19, 11.4; W7.11): the client diffs only the small snippets of an
// `edit_file` approval (`old_string` -> `new_string`); finished edits show the server's hunks. No dependency: a small
// LCS over lines with 3 lines of context; past `maxCells` (the LCS table size) one hunk removes every old line, then
// adds every new line. CRLF is compared as LF; a missing trailing newline is not a change of its own.
// Signature frozen from Gate P7-0b (C15). Skeleton: returns no hunks until W7.11 implements it.
import type { DiffHunk } from '@harness-forge/shared'

export interface DiffLinesOptions {
  /** Unchanged lines kept around each change; default 3. */
  context?: number
  /** Cap of the LCS table (old lines x new lines); default 4e6. */
  maxCells?: number
}

/** The hunks that turn `a` into `b` (lines prefixed `' '`, `'+'` or `'-'`, like the server's `DiffHunk`). */
export function diffLines(_a: string, _b: string, _opts?: DiffLinesOptions): DiffHunk[] {
  return []
}
