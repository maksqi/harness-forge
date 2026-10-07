// Local folder source (PLUGINS.md 12 "Sources"): an absolute path on the server host, used in place (`link`) or
// copied into staging (`copy`).
//
// The folder is resolved with `realpath` and must be a directory that neither lies inside the harness-forge data
// directory nor contains it (a folder holding `data/` would expose the database and the master key through the
// plugin files API). A copy is "treated like a zip": the same name rules and limits apply, `node_modules` and `.git`
// folders are skipped, symbolic links and special files are refused, and files are opened without following links.
// A linked folder is trusted by its path (content changes reload without another review), so on POSIX it must not be
// writable by every user of the machine, and no folder above it may let every user replace it (world-writable without
// the sticky bit): otherwise any local account could change the code the server runs.
import type { ArchiveEntry, EntryCollector } from './archive.ts'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { isInside } from '../loader.ts'
import { invalid, quoteName } from './errors.ts'

const WORLD_WRITABLE = 0o002
const STICKY = 0o1000

/**
 * Refuses a folder to link when any local user could change its files: the folder world-writable, or a folder above
 * it world-writable without the sticky bit (anyone could rename it and put another one in its place). POSIX only.
 */
export async function checkLinkableFolder(real: string): Promise<void> {
  if (process.platform === 'win32')
    return
  const own = await stat(real)
  if ((own.mode & WORLD_WRITABLE) !== 0)
    throw invalid(`Every user of this machine can write to ${quoteName(real)}, so anyone could change the code harness-forge runs from it. Run "chmod o-w" on it, or install a copy instead.`, ['path'])
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    const info = await stat(dir)
    if ((info.mode & WORLD_WRITABLE) !== 0 && (info.mode & STICKY) === 0)
      throw invalid(`Every user of this machine can replace ${quoteName(real)} (its parent folder ${quoteName(dir)} is world-writable). Move the plugin elsewhere, or install a copy instead.`, ['path'])
    if (dirname(dir) === dir)
      break
  }
}

/** Folders never copied (they are also left out of exports). */
export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['node_modules', '.git'])

/** `O_NOFOLLOW` where the platform has it (not on Windows). */
const NO_FOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

/** The realpath of a plugin folder to link or copy. */
export async function resolveLocalFolder(path: string, dataRoot: string): Promise<string> {
  let real: string
  try {
    real = await realpath(path)
  }
  catch {
    throw invalid('The folder does not exist or cannot be read.', ['path'])
  }
  let info
  try {
    info = await stat(real)
  }
  catch {
    throw invalid('The folder cannot be read.', ['path'])
  }
  if (!info.isDirectory())
    throw invalid('The path is not a folder.', ['path'])
  let dataReal = dataRoot
  try {
    dataReal = await realpath(dataRoot)
  }
  catch {}
  if (real === dataReal || isInside(dataReal, real) || isInside(real, dataReal))
    throw invalid('Choose a folder outside the harness-forge data directory (and not one that contains it).', ['path'])
  return real
}

/** Reads exactly `size` bytes of a regular file opened without following a final link. */
async function readFileNoFollow(path: string, shown: string, size: number): Promise<Uint8Array> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW)
  }
  catch {
    throw invalid(`The file ${quoteName(shown)} cannot be read (or is a link).`, ['path'])
  }
  try {
    const info = await handle.stat()
    if (!info.isFile())
      throw invalid(`The folder contains a special file: ${quoteName(shown)}.`, ['path'])
    const changed = invalid(`The file ${quoteName(shown)} changed while it was copied; try again.`, ['path'])
    if (info.size !== size)
      throw changed
    const data = new Uint8Array(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(data, offset, size - offset, offset)
      if (bytesRead === 0)
        break
      offset += bytesRead
    }
    if (offset !== size)
      throw changed
    return data
  }
  finally {
    await handle.close()
  }
}

/**
 * Reads a folder for a `copy` install: every entry is admitted by `collector` (names, count, size, conflicts) and the
 * files are loaded into memory with their owner exec bit (Phase 12). The caller checks the plugin layout.
 */
export async function readFolder(root: string, collector: EntryCollector): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = []
  const walk = async (dir: string, relative: string): Promise<void> => {
    const names = (await readdir(dir)).sort()
    for (const name of names) {
      const path = join(dir, name)
      const shown = relative === '' ? name : `${relative}/${name}`
      const info = await lstat(path)
      if (info.isSymbolicLink())
        throw invalid(`The folder contains a symbolic link: ${quoteName(shown)}.`, ['path'])
      if (info.isDirectory()) {
        if (SKIPPED_FOLDERS.has(name))
          continue
        const admitted = collector.admit(`${shown}/`, 'dir', 0)
        if (admitted !== null) {
          entries.push({ path: admitted, type: 'dir', data: null })
          await walk(path, shown)
        }
        continue
      }
      if (!info.isFile())
        throw invalid(`The folder contains a special file: ${quoteName(shown)}.`, ['path'])
      const admitted = collector.admit(shown, 'file', info.size)
      if (admitted !== null) {
        // Phase 12: the owner exec bit (kept only for the Claude Code format).
        const executable = (info.mode & 0o100) !== 0
        entries.push({ path: admitted, type: 'file', data: await readFileNoFollow(path, shown, info.size), ...(executable ? { executable: true } : {}) })
      }
    }
  }
  await walk(root, '')
  return entries
}
