// `@path` references of a command file (Phase 11, ADR-052; ARCHITECTURE.md 6.32 "Execution"). Owner: W11.5.
//
// A referenced project file is read only through the workspace path guard: never a secret-looking name or a `.git`
// path; `resolveWorkspacePath` (containment) must answer the path as written (`rel` equality: no symbolic link anywhere
// on the path); `openWorkspaceFile` (`O_NOFOLLOW | O_NONBLOCK`, `fstat`: a regular file) with the same equality on the
// opened path. At most `LIMITS.commandFileRefBytes` are read (a longer file is cut: `truncated`); a NUL byte in the first
// 8 KiB makes it binary (a marker block, no content). A refused, missing or unreadable file answers null: the reference
// stays text and no block is added. Contents are never logged.
import type { FileBlock } from '@harness-forge/shared'
import type { OpenedWorkspaceFile } from '../../workspace/paths.ts'
import { Buffer } from 'node:buffer'
import { LIMITS } from '@harness-forge/shared'
import { hasGitSegment, openWorkspaceFile, resolveWorkspacePath } from '../../workspace/paths.ts'
import { isSecretLookingPath } from '../../workspace/sensitive.ts'

/** Leading bytes checked for a NUL (binary file), as in the definition discovery. */
const BINARY_PROBE_BYTES = 8192

/** True when a project-relative path may never be inlined (a secret-looking name or a `.git` segment). */
export function isRefusedCommandFilePath(path: string): boolean {
  return isSecretLookingPath(path) || hasGitSegment(path)
}

/** `bytes` without a UTF-8 sequence cut at its end (only when the read stopped early). */
function completeUtf8(bytes: Buffer, cut: boolean): Buffer {
  if (!cut || bytes.length === 0)
    return bytes
  let lead = bytes.length - 1
  while (lead > 0 && ((bytes[lead] as number) & 0xC0) === 0x80)
    lead -= 1
  const first = bytes[lead] as number
  const size = first >= 0xF0 ? 4 : first >= 0xE0 ? 3 : first >= 0xC0 ? 2 : 1
  return lead + size <= bytes.length ? bytes : bytes.subarray(0, lead)
}

/** The block of one referenced file of the project folder `root` (a canonical realpath), or null. Never throws. */
export async function readCommandFile(root: string, path: string, maxBytes: number = LIMITS.commandFileRefBytes): Promise<FileBlock | null> {
  if (isRefusedCommandFilePath(path))
    return null
  try {
    if ((await resolveWorkspacePath(root, path)).rel !== path)
      return null
  }
  catch {
    return null
  }
  let opened: OpenedWorkspaceFile
  try {
    opened = await openWorkspaceFile(root, path)
  }
  catch {
    return null
  }
  try {
    if (opened.resolved.rel !== path || !opened.stats.isFile())
      return null
    const cap = Math.max(0, Math.floor(maxBytes))
    // One byte more than kept tells a file that fits exactly from a longer one.
    const buffer = Buffer.alloc(cap + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await opened.handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0)
        break
      length += bytesRead
    }
    const cut = length > cap
    const bytes = buffer.subarray(0, Math.min(length, cap))
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0))
      return { path, content: '', truncated: false, binary: true }
    return { path, content: new TextDecoder('utf-8').decode(completeUtf8(bytes, cut)), truncated: cut }
  }
  catch {
    return null
  }
  finally {
    await opened.handle.close().catch(() => {})
  }
}

/**
 * The blocks of the referenced files, in order (null = not inlined). The files are read one after another; rejects
 * only when `signal` aborts.
 */
export async function readCommandFiles(root: string, paths: readonly string[], signal?: AbortSignal): Promise<(FileBlock | null)[]> {
  const blocks: (FileBlock | null)[] = []
  for (const path of paths.slice(0, LIMITS.commandFileRefsMax)) {
    signal?.throwIfAborted()
    blocks.push(await readCommandFile(root, path))
  }
  signal?.throwIfAborted()
  return blocks
}
