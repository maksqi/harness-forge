// The project file of a run (Phase 7, ADR-031, ARCHITECTURE.md 6.13 "openWorkspace"). Owner: W7.1.
//
// `AGENTS.md`, else `CLAUDE.md` (`PROJECT_INSTRUCTIONS_FILES`), from the project root only, opened through the frozen
// path guard (`openWorkspaceFile`: realpath containment, `O_NOFOLLOW | O_NONBLOCK`, regular files only). A file that
// cannot be opened that way (missing, a folder, a FIFO, a link out of the root) or that looks binary (a NUL byte in its
// first 8 KiB) is skipped, and the next name is tried.
//
// A line made only of `@relative.md` (surrounding spaces allowed) is replaced by that file, one level deep (the
// imported text is not scanned again), resolved inside the root through the same guard; the target must be a relative
// path ending in `.md`. A line whose target is refused, missing or binary stays as written. At most
// `PROJECT_FILE_IMPORTS_MAX` lines are expanded. The whole text is at most `LIMITS.projectFileBytes` (32 KiB, UTF-8
// bytes, cut at a character boundary); a cut text ends with `PROJECT_FILE_TRUNCATED_MARKER`. Read again on every run.
import type { ProjectInstructionsFile } from '@harness-forge/shared'
import type { ProjectFile } from './types.ts'
import { Buffer } from 'node:buffer'
import { isAbsolute } from 'node:path'
import { LIMITS, PROJECT_INSTRUCTIONS_FILES } from '@harness-forge/shared'
import { openWorkspaceFile } from '../../workspace/paths.ts'

/** Bytes checked for a NUL byte: a file with one is binary and never becomes instructions. */
export const BINARY_PROBE_BYTES = 8192

/** `@file.md` lines expanded at most per project file (later ones stay as written). */
export const PROJECT_FILE_IMPORTS_MAX = 64

/** Appended to a project file cut at `LIMITS.projectFileBytes`. */
export const PROJECT_FILE_TRUNCATED_MARKER = `\n\n[The project file was cut at ${LIMITS.projectFileBytes / 1024} KiB.]`

const IMPORT_LINE = /^@(\S+)$/
const MARKDOWN_FILE = /\.md$/i
const WINDOWS_DRIVE = /^[a-z]:/i

interface CappedRead {
  /** At most the requested bytes. */
  readonly bytes: Buffer
  /** The file has more bytes than were returned. */
  readonly more: boolean
}

/**
 * Reads at most `maxBytes` of a project file through the path guard; null when it cannot be opened as a regular file
 * inside the root, fails to read, or has a NUL byte in its first `BINARY_PROBE_BYTES` (binary). Never throws.
 */
async function readCapped(root: string, rel: string, maxBytes: number): Promise<CappedRead | null> {
  let opened: Awaited<ReturnType<typeof openWorkspaceFile>>
  try {
    opened = await openWorkspaceFile(root, rel)
  }
  catch {
    return null
  }
  try {
    // One byte more than asked tells a file that fits exactly from a longer one.
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await opened.handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0)
        break
      length += bytesRead
    }
    const bytes = buffer.subarray(0, Math.min(length, maxBytes))
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0))
      return null
    return { bytes, more: length > maxBytes }
  }
  catch {
    return null
  }
  finally {
    await opened.handle.close().catch(() => {})
  }
}

/** The longest prefix of `bytes` of at most `max` bytes that does not end inside a UTF-8 sequence. */
function utf8Prefix(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length <= max)
    return bytes
  let end = max
  // Back off over continuation bytes (10xxxxxx) so the cut lands before the lead byte of a split character.
  while (end > 0 && (bytes[end]! & 0xC0) === 0x80)
    end -= 1
  return bytes.subarray(0, end)
}

/** Drops an incomplete UTF-8 sequence at the end of a cut read (so it never decodes to a replacement character). */
function completeUtf8(bytes: Uint8Array, cut: boolean): Uint8Array {
  if (!cut || bytes.length === 0)
    return bytes
  // Find the lead byte of the last character and keep it only when all its continuation bytes are there.
  let lead = bytes.length - 1
  while (lead > 0 && (bytes[lead]! & 0xC0) === 0x80)
    lead -= 1
  const first = bytes[lead]!
  const size = first >= 0xF0 ? 4 : first >= 0xE0 ? 3 : first >= 0xC0 ? 2 : 1
  return lead + size <= bytes.length ? bytes : bytes.subarray(0, lead)
}

/** UTF-8 text (a leading BOM dropped, invalid sequences replaced). */
function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

/** The target of an `@relative.md` line, or null when the line is ordinary text. */
export function importTarget(line: string): string | null {
  const target = line.trim().match(IMPORT_LINE)?.[1]
  if (target === undefined || !MARKDOWN_FILE.test(target))
    return null
  if (isAbsolute(target) || target.startsWith('~') || target.startsWith('\\') || WINDOWS_DRIVE.test(target))
    return null
  return target
}

/** Collects text up to `max` UTF-8 bytes; the first piece that does not fit is cut and ends the collection. */
class CappedText {
  private readonly parts: string[] = []
  private bytes = 0
  truncated = false

  constructor(private readonly max: number) {}

  get remaining(): number {
    return this.max - this.bytes
  }

  push(text: string): void {
    if (this.truncated || text === '')
      return
    const size = Buffer.byteLength(text, 'utf8')
    if (size <= this.remaining) {
      this.parts.push(text)
      this.bytes += size
      return
    }
    const cut = decode(utf8Prefix(Buffer.from(text, 'utf8'), this.remaining))
    this.parts.push(cut)
    this.bytes += Buffer.byteLength(cut, 'utf8')
    this.truncated = true
  }

  text(): string {
    return this.parts.join('')
  }
}

async function expand(root: string, name: ProjectInstructionsFile, main: CappedRead): Promise<ProjectFile> {
  const out = new CappedText(LIMITS.projectFileBytes)
  const lines = decode(completeUtf8(main.bytes, main.more)).split(/(?<=\n)/)
  let imports = 0
  for (const [index, line] of lines.entries()) {
    if (out.truncated)
      break
    // The last line of a cut file may be a partial `@name.md`: never expand it.
    const partial = main.more && index === lines.length - 1
    const target = partial || imports >= PROJECT_FILE_IMPORTS_MAX ? null : importTarget(line)
    if (target === null) {
      out.push(line)
      continue
    }
    imports += 1
    const imported = await readCapped(root, target, out.remaining)
    if (imported === null) {
      out.push(line)
      continue
    }
    const text = decode(completeUtf8(imported.bytes, imported.more))
    out.push(text)
    if (imported.more) {
      out.truncated = true
      break
    }
    const ending = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
    if (ending !== '' && !text.endsWith('\n'))
      out.push(ending)
  }
  const truncated = out.truncated || main.more
  const content = out.text()
  return Object.freeze({ name, content: truncated ? `${content}${PROJECT_FILE_TRUNCATED_MARKER}` : content, truncated })
}

/**
 * The project file of the folder `root` (a canonical realpath): `AGENTS.md`, else `CLAUDE.md`, with its `@relative.md`
 * lines expanded and cut at `LIMITS.projectFileBytes`; null when neither is a readable text file. Never throws.
 */
export async function readProjectFile(root: string): Promise<ProjectFile | null> {
  for (const name of PROJECT_INSTRUCTIONS_FILES) {
    const main = await readCapped(root, name, LIMITS.projectFileBytes)
    if (main !== null)
      return expand(root, name, main)
  }
  return null
}

/**
 * The name of the project file `readProjectFile` would use (`ProjectSummary.instructionsFile`), from a short probe of
 * each candidate (opened through the path guard, first `BINARY_PROBE_BYTES` free of NUL bytes); null when none.
 */
export async function probeProjectFile(root: string): Promise<ProjectInstructionsFile | null> {
  for (const name of PROJECT_INSTRUCTIONS_FILES) {
    if (await readCapped(root, name, BINARY_PROBE_BYTES) !== null)
      return name
  }
  return null
}
