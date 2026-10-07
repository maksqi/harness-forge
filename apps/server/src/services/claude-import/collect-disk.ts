// The disk intake of the home-folder import (ADR-055; W12.3-T1): `POST /claude-import/scan` reads the allowlist of
// `HF_CLAUDE_HOME` and nothing else.
//
// - The root is resolved once with `realpath`; it must be a folder (else `not_found`). The root itself is never
//   listed: `settings.json` and `CLAUDE.md` are opened by name, and only the folders `agents/`, `commands/` (3 levels
//   below), `skills/` and `output-styles/` are listed with `opendir` (at most 2000 entries each; hidden names ignored);
//   a skill folder is never listed (its `SKILL.md` is opened by name). So `.credentials.json`, `projects/`,
//   `history.jsonl`, `todos/`, `shell-snapshots/`, `statsig/`, `plugins/` and `settings.local.json` are never opened.
// - `.claude.json` is read next to a root named `.claude` (`~/.claude.json`; the configured path decides, so a linked
//   `~/.claude` still finds it), else inside the root; it is reduced at once to its MCP server maps (./collected.ts).
// - Files are opened read-only with `O_NONBLOCK` (a FIFO never blocks the scan) and must be regular files (`fstat`);
//   the caps are checked against the `fstat` size before a byte is read, and again while reading.
// - Symbolic links are followed (dotfile managers link these files and folders); a file reached through a link is
//   marked `linked` and must be a regular file outside `HF_DATA_DIR` (the realpath of the file must be the opened file:
//   same device and inode).
// - A deadline (10 s, `LIMITS.claudeImportScanTimeoutMs`) is checked before every file system call: past it the scan
//   ends with what it read and a `timeout` warning. An abort (shutdown) rejects.
// Never logs (the service logs counts; the root path only at `debug`).
import type { Dirent, Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { CollectedHome } from './collected.ts'
import { constants } from 'node:fs'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { CLAUDE_HOME_LIMITS, CLAUDE_JSON_PATH, HarnessError, isClaudeHomeImportPath, LIMITS } from '@harness-forge/shared'
import { HomeCollector } from './collected.ts'

/** Entries read from one listed folder. */
export const SCAN_FOLDER_ENTRIES_MAX = 2000

/** An open folder as `opendir` returns it: async-iterable entries (closed when the iteration ends). */
export type DiskDirectory = AsyncIterable<Dirent>

/** The file system calls of the scan (injectable, so tests can watch every `open`). */
export interface DiskFs {
  readonly realpath: (path: string) => Promise<string>
  readonly stat: (path: string) => Promise<Stats>
  readonly opendir: (path: string) => Promise<DiskDirectory>
  readonly open: (path: string, flags: number) => Promise<FileHandle>
}

export const NODE_DISK_FS: DiskFs = Object.freeze({
  realpath: (path: string) => realpath(path),
  stat: (path: string) => stat(path),
  opendir: (path: string) => opendir(path),
  open: (path: string, flags: number) => open(path, flags),
})

export interface CollectDiskOptions {
  /** `env.claudeHome`: the configured folder (absolute). */
  readonly root: string
  /** `HF_DATA_DIR`: a linked file must resolve outside it. */
  readonly dataDir: string
  /** Aborts the scan (shutdown): it rejects. */
  readonly signal?: AbortSignal
  /** Milliseconds the scan may take (default `LIMITS.claudeImportScanTimeoutMs`). */
  readonly timeoutMs?: number
  /** Clock (default `Date.now`). */
  readonly now?: () => number
  readonly fs?: DiskFs
}

/** The folders that are listed, below the root. */
const LISTED_FOLDERS = ['agents', 'commands', 'output-styles', 'skills'] as const

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK

/** `stat` / `open` errors that mean "nothing there". */
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

class DeadlineError extends Error {}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function isInsideOrEqual(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The scan was stopped (shutdown): the plan is not kept. */
function stoppedError(): HarnessError {
  return new HarnessError({ code: 'conflict', message: 'The scan of the Claude Code folder was stopped.' })
}

/** `not_found` for a root that is missing or not a folder. */
function missingRoot(): HarnessError {
  return new HarnessError({ code: 'not_found', message: 'The Claude Code folder was not found on the server.' })
}

/** Reads the allowlist of a Claude Code folder (see the module comment). */
export async function collectDiskHome(options: CollectDiskOptions): Promise<CollectedHome> {
  const fs = options.fs ?? NODE_DISK_FS
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMs ?? LIMITS.claudeImportScanTimeoutMs)
  const collector = new HomeCollector()

  const check = (): void => {
    if (options.signal?.aborted === true)
      throw stoppedError()
    if (now() > deadline)
      throw new DeadlineError()
  }

  let realRoot: string
  try {
    check()
    realRoot = await fs.realpath(options.root)
    const info = await fs.stat(realRoot)
    if (!info.isDirectory())
      throw missingRoot()
  }
  catch (error) {
    if (error instanceof HarnessError)
      throw error
    if (error instanceof DeadlineError)
      throw new HarnessError({ code: 'conflict', message: 'The Claude Code folder could not be read in time.', details: { reason: 'busy' } })
    if (MISSING_CODES.has(errorCode(error) ?? ''))
      throw missingRoot()
    throw new HarnessError({ code: 'not_found', message: 'The Claude Code folder on the server cannot be read.' })
  }
  let realData: string
  try {
    realData = await fs.realpath(options.dataDir)
  }
  catch {
    realData = resolve(options.dataDir)
  }

  /**
   * Reads one allowlisted file. `expected` is where the file would be without any link (its realpath otherwise
   * differs); a missing file is no problem.
   */
  async function readFile(path: string, absolute: string, expected: string): Promise<void> {
    // The allowlist decides before anything is opened.
    if (!isClaudeHomeImportPath(path)) {
      collector.skip(path, 'not on the import allowlist')
      return
    }
    check()
    let handle: FileHandle
    try {
      handle = await fs.open(absolute, OPEN_FLAGS)
    }
    catch (error) {
      if (!MISSING_CODES.has(errorCode(error) ?? ''))
        collector.skip(path, 'cannot be read')
      return
    }
    try {
      check()
      const info = await handle.stat()
      if (!info.isFile()) {
        collector.skip(path, 'not a regular file')
        return
      }
      const real = await fs.realpath(absolute)
      const linked = real !== expected
      if (linked) {
        const target = await fs.stat(real)
        if (target.dev !== info.dev || target.ino !== info.ino) {
          collector.skip(path, 'changed while it was read')
          return
        }
        if (isInsideOrEqual(realData, real)) {
          collector.skip(path, 'a link into the data folder of harness-forge')
          return
        }
      }
      const admission = collector.admit(path, info.size)
      if (!admission.ok)
        return
      const bytes = await readAtMost(handle, Math.min(info.size, admission.maxBytes) + 1, check)
      if (bytes.byteLength > info.size) {
        collector.skip(path, 'changed while it was read')
        return
      }
      collector.add(admission, bytes, linked)
    }
    catch (error) {
      if (error instanceof DeadlineError || error instanceof HarnessError)
        throw error
      collector.skip(path, 'cannot be read')
    }
    finally {
      await handle.close().catch(() => {})
    }
  }

  /** The entries of one folder (hidden names left out), sorted by name; null when it is missing or unreadable. */
  async function list(path: string, absolute: string): Promise<{ name: string, kind: 'file' | 'dir' | 'other' }[] | null> {
    check()
    let dir: DiskDirectory
    try {
      dir = await fs.opendir(absolute)
    }
    catch (error) {
      if (!MISSING_CODES.has(errorCode(error) ?? ''))
        collector.diagnostic('warning', 'unreadable-folder', `The folder ${path} could not be read.`)
      return null
    }
    const entries: { name: string, kind: 'file' | 'dir' | 'other' }[] = []
    let count = 0
    for await (const entry of dir) {
      if (++count > SCAN_FOLDER_ENTRIES_MAX) {
        collector.diagnostic('warning', 'too-many', `The folder ${path} has more than ${SCAN_FOLDER_ENTRIES_MAX} entries; the rest were not read.`)
        break
      }
      if (entry.name.startsWith('.'))
        continue
      let kind: 'file' | 'dir' | 'other' = entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other'
      if (entry.isSymbolicLink()) {
        check()
        try {
          const target = await fs.stat(join(absolute, entry.name))
          kind = target.isFile() ? 'file' : target.isDirectory() ? 'dir' : 'other'
        }
        catch {
          kind = 'other'
        }
      }
      entries.push({ name: entry.name, kind })
    }
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /** `agents/`, `output-styles/`: the markdown files of the folder itself. */
  async function flatFolder(folder: string): Promise<void> {
    const entries = await list(folder, join(realRoot, folder))
    for (const entry of entries ?? []) {
      const path = `${folder}/${entry.name}`
      if (entry.kind === 'file')
        await readFile(path, join(realRoot, folder, entry.name), join(realRoot, folder, entry.name))
      else if (entry.kind === 'dir')
        collector.skip(`${path}/`, 'not on the import allowlist')
    }
  }

  /** `commands/`: markdown files at most `commandDepthMax` folders deep. */
  async function commandFolder(path: string, depth: number): Promise<void> {
    const entries = await list(path, join(realRoot, ...path.split('/')))
    for (const entry of entries ?? []) {
      const child = `${path}/${entry.name}`
      const absolute = join(realRoot, ...child.split('/'))
      if (entry.kind === 'file')
        await readFile(child, absolute, absolute)
      else if (entry.kind === 'dir' && depth < CLAUDE_HOME_LIMITS.commandDepthMax)
        await commandFolder(child, depth + 1)
      else if (entry.kind === 'dir')
        collector.skip(`${child}/`, `deeper than ${CLAUDE_HOME_LIMITS.commandDepthMax} folders`)
    }
  }

  /** `skills/`: `skills/<name>/SKILL.md` of every folder (the skill folder itself is never listed). */
  async function skillsFolder(): Promise<void> {
    const entries = await list('skills', join(realRoot, 'skills'))
    for (const entry of entries ?? []) {
      if (entry.kind === 'dir') {
        const absolute = join(realRoot, 'skills', entry.name, 'SKILL.md')
        await readFile(`skills/${entry.name}/SKILL.md`, absolute, absolute)
      }
      else if (entry.kind === 'file') {
        collector.skip(`skills/${entry.name}`, 'not on the import allowlist')
      }
    }
  }

  /** `~/.claude.json` next to a root named `.claude`, else (or when it is missing there) inside the root. */
  async function claudeJson(): Promise<void> {
    const candidates: { absolute: string, expected: () => Promise<string> }[] = []
    if (basename(resolve(options.root)) === '.claude') {
      const sibling = join(dirname(resolve(options.root)), CLAUDE_JSON_PATH)
      candidates.push({ absolute: sibling, expected: async () => join(await fs.realpath(dirname(sibling)), CLAUDE_JSON_PATH) })
    }
    candidates.push({ absolute: join(realRoot, CLAUDE_JSON_PATH), expected: async () => join(realRoot, CLAUDE_JSON_PATH) })
    for (const candidate of candidates) {
      check()
      let exists = true
      try {
        await fs.stat(candidate.absolute)
      }
      catch (error) {
        exists = !MISSING_CODES.has(errorCode(error) ?? '')
      }
      if (!exists)
        continue
      let expected: string
      try {
        expected = await candidate.expected()
      }
      catch {
        expected = candidate.absolute
      }
      await readFile(CLAUDE_JSON_PATH, candidate.absolute, expected)
      return
    }
  }

  try {
    await readFile('settings.json', join(realRoot, 'settings.json'), join(realRoot, 'settings.json'))
    await readFile('CLAUDE.md', join(realRoot, 'CLAUDE.md'), join(realRoot, 'CLAUDE.md'))
    for (const folder of LISTED_FOLDERS) {
      if (folder === 'commands')
        await commandFolder('commands', 0)
      else if (folder === 'skills')
        await skillsFolder()
      else
        await flatFolder(folder)
    }
    await claudeJson()
  }
  catch (error) {
    if (!(error instanceof DeadlineError))
      throw error
    collector.diagnostic('warning', 'timeout', `The scan stopped after ${Math.round((options.timeoutMs ?? LIMITS.claudeImportScanTimeoutMs) / 1000)} seconds; the files it had not read yet are not part of the plan.`)
  }
  return collector.result()
}

/** Reads at most `limit` bytes from the start of the file (the caller passes the size + 1 to detect a grown file). */
async function readAtMost(handle: FileHandle, limit: number, check: () => void): Promise<Uint8Array> {
  const buffer = new Uint8Array(limit)
  let length = 0
  while (length < limit) {
    check()
    const { bytesRead } = await handle.read(buffer, length, limit - length, length)
    if (bytesRead === 0)
      break
    length += bytesRead
  }
  return buffer.subarray(0, length)
}
