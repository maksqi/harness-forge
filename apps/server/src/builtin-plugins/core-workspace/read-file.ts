// The `read_file` tool of `core-workspace` (ADR-032; access `read`, timeout 30 s; policy: `ask` for a secret-looking
// path, else `safe`). Text files only: the first 8 KiB must look like UTF-8 text (`looksLikeText`), else the call fails.
// The file is opened through the frozen `openWorkspaceFile` (path guard, `O_NOFOLLOW | O_NONBLOCK`, regular files only)
// and read as a stream, so a huge file costs only its window:
//
// - the window starts at `offset` (1-based, default 1) and has at most `limit` lines (default and maximum 2000) and
//   48 KiB of text (`WORKSPACE_LIMITS.readMaxBytes`); lines are cut at 2000 characters; a trailing `\r` and a leading
//   BOM are dropped (the stored `content` has no line numbers);
// - after the window, the rest of the file is scanned for its line count while that costs at most
//   `READ_COUNT_MAX_BYTES`; else `totalLines` is null;
// - `truncated` is true when the file continues after `endLine`, a line was cut or the window hit its byte cap.
//
// The model sees `cat -n` lines (`readFileModelText`), then "[truncated; continue with offset=N]" when the file goes on.
import type { ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { ReadFileToolInput, ReadFileToolOutput } from '@harness-forge/shared'
import type { FileHandle } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { readFileToolInputSchema, readFileToolOutputSchema, WORKSPACE_LIMITS, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { looksLikeText } from '../../plugins/scaffold/paths.ts'
import { openWorkspaceFile, workspacePathError } from '../../workspace/paths.ts'
import { byteLength, plural } from '../../workspace/text.ts'
import { fitLines } from '../../workspace/trim.ts'
import { READ_TOOL_TIMEOUT_MS, requireWorkspace, textModelOutput } from './common.ts'
import { readFilePolicy } from './policies.ts'

export const READ_FILE_TOOL_NAME = 'read_file'

/** Bytes inspected by the text check. */
export const TEXT_SNIFF_BYTES = 8192
/** After the window, at most this many bytes are scanned for the line count (8 MiB). */
export const READ_COUNT_MAX_BYTES = 8_388_608
/** Read chunk size. */
const CHUNK_BYTES = 65_536

/** The refusal of a file that does not look like text. */
export function binaryFileError(rel: string): Error {
  return workspacePathError(`"${rel}" looks like a binary file: read_file reads text files only.`)
}

/** Fails when the first bytes of an opened file do not look like UTF-8 text. */
export async function assertTextFile(handle: FileHandle, rel: string): Promise<void> {
  const head = Buffer.alloc(TEXT_SNIFF_BYTES)
  const { bytesRead } = await handle.read(head, 0, TEXT_SNIFF_BYTES, 0)
  if (!looksLikeText(head.subarray(0, bytesRead)))
    throw binaryFileError(rel)
}

export interface ReadWindow {
  lines: string[]
  startLine: number
  endLine: number
  totalLines: number | null
  /** A line was cut or the window hit its byte cap. */
  cut: boolean
}

export interface ReadWindowOptions {
  offset: number
  limit: number
  signal?: AbortSignal
  /** Defaults: `WORKSPACE_LIMITS.readMaxBytes`, `WORKSPACE_LIMITS.lineMaxChars`, `READ_COUNT_MAX_BYTES`. */
  maxBytes?: number
  lineMaxChars?: number
  countMaxBytes?: number
}

/** Streams the window of an opened text file (see the module comment). Exported for tests. */
export async function readWindow(handle: FileHandle, options: ReadWindowOptions): Promise<ReadWindow> {
  const maxBytes = options.maxBytes ?? WORKSPACE_LIMITS.readMaxBytes
  const lineMaxChars = options.lineMaxChars ?? WORKSPACE_LIMITS.lineMaxChars
  const countMaxBytes = options.countMaxBytes ?? READ_COUNT_MAX_BYTES
  const { offset, limit, signal } = options
  const lastLine = offset + limit - 1
  // A UTF-8 decoder that drops a leading BOM and replaces invalid sequences.
  const decoder = new TextDecoder('utf-8')
  const chunk = Buffer.alloc(CHUNK_BYTES)
  const lines: string[] = []
  let windowBytes = 0
  let cut = false
  let windowDone = false
  let endLine = offset - 1
  // The line being read (1-based), its kept characters (only inside the window) and whether it has any character.
  let lineNo = 1
  let current = ''
  let lineHasText = false
  let position = 0
  let scannedAfterWindow = 0
  let countable = true

  const finishLine = (): void => {
    if (!windowDone && lineNo >= offset) {
      let line = current.endsWith('\r') ? current.slice(0, -1) : current
      if (line.length > lineMaxChars) {
        const code = line.charCodeAt(lineMaxChars - 1)
        line = line.slice(0, code >= 0xD800 && code <= 0xDBFF ? lineMaxChars - 1 : lineMaxChars)
        cut = true
      }
      const bytes = byteLength(line) + (lines.length === 0 ? 0 : 1)
      if (lines.length > 0 && windowBytes + bytes > maxBytes) {
        windowDone = true
        cut = true
      }
      else {
        lines.push(line)
        windowBytes += bytes
        endLine = lineNo
        if (lineNo >= lastLine)
          windowDone = true
      }
    }
    current = ''
  }

  const consume = (text: string): void => {
    let start = 0
    while (start <= text.length) {
      const newline = text.indexOf('\n', start)
      const end = newline === -1 ? text.length : newline
      if (end > start) {
        lineHasText = true
        // Keep two characters more than the cut, so a line of exactly the maximum plus `\r` is not marked as cut.
        if (!windowDone && lineNo >= offset && current.length <= lineMaxChars + 1)
          current += text.slice(start, Math.min(end, start + lineMaxChars + 2 - current.length))
      }
      if (newline === -1)
        break
      finishLine()
      lineNo++
      lineHasText = false
      start = newline + 1
    }
  }

  for (;;) {
    signal?.throwIfAborted()
    const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, position)
    if (bytesRead === 0) {
      consume(decoder.decode())
      break
    }
    position += bytesRead
    if (windowDone) {
      scannedAfterWindow += bytesRead
      if (scannedAfterWindow > countMaxBytes) {
        countable = false
        break
      }
    }
    consume(decoder.decode(chunk.subarray(0, bytesRead), { stream: true }))
  }

  let totalLines: number | null = null
  if (countable) {
    // The last line counts when it has text without a final newline.
    if (lineHasText)
      finishLine()
    totalLines = lineHasText ? lineNo : lineNo - 1
  }
  return { lines, startLine: offset, endLine, totalLines, cut }
}

/** The stored output of a window, trimmed to `WORKSPACE_LIMITS.outputMaxBytes`. Exported for tests. */
export function readFileOutput(path: string, window: ReadWindow): ReadFileToolOutput {
  const base: ReadFileToolOutput = { path, content: '', startLine: window.startLine, endLine: window.endLine, totalLines: window.totalLines, truncated: true }
  const { kept, cut } = fitLines(base, window.lines)
  const endLine = cut ? window.startLine + kept.length - 1 : window.endLine
  const continues = endLine >= window.startLine && (window.totalLines === null || endLine < window.totalLines)
  return { ...base, content: kept.join('\n'), endLine, truncated: window.cut || cut || continues }
}

/** The text the model sees for a `read_file` output (`cat -n` lines). */
export function readFileModelText(output: ReadFileToolOutput): string {
  const { path, content, startLine, endLine, totalLines } = output
  const parts: string[] = []
  if (endLine >= startLine) {
    content.split('\n').forEach((line, index) => parts.push(`${String(startLine + index).padStart(6)}\t${line}`))
  }
  else if (totalLines === 0) {
    parts.push(`(${path} is empty)`)
  }
  else if (totalLines !== null) {
    parts.push(`(${path} has ${plural(totalLines, 'line')}; offset ${startLine} is past the end)`)
  }
  else {
    parts.push(`(no lines at offset ${startLine})`)
  }
  const continues = endLine >= startLine && (totalLines === null || endLine < totalLines)
  if (continues)
    parts.push(`[truncated; continue with offset=${endLine + 1}]`)
  else if (output.truncated)
    parts.push(`[lines longer than ${WORKSPACE_LIMITS.lineMaxChars} characters were cut]`)
  return parts.join('\n')
}

export function createReadFileTool(): ToolDefinition<ReadFileToolInput, ReadFileToolOutput> {
  return {
    name: READ_FILE_TOOL_NAME,
    description: 'Read a text file of the project folder. Returns its lines with line numbers (like cat -n), at most 2000 lines or 48 KiB per call; for a longer file, continue with offset (1-based first line) and limit. Paths are relative to the project folder.',
    inputSchema: readFileToolInputSchema,
    policy: readFilePolicy,
    timeoutMs: READ_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.read_file,
    async execute(input, c) {
      const { root } = requireWorkspace(c)
      const { resolved, handle } = await openWorkspaceFile(root, input.path)
      try {
        await assertTextFile(handle, resolved.rel)
        const window = await readWindow(handle, {
          offset: input.offset ?? 1,
          limit: input.limit ?? WORKSPACE_LIMITS.readMaxLines,
          signal: c.signal,
        })
        return readFileOutput(resolved.rel, window)
      }
      finally {
        await handle.close()
      }
    },
    toModelOutput(output): ToolResultOutput {
      return textModelOutput(readFileToolOutputSchema, output, readFileModelText)
    },
  }
}
