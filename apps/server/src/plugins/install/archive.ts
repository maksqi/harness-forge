// Archive entries shared by every install source (PLUGINS.md 12 "Archive rules").
//
// Readers (zip.ts, tar.ts, folder.ts) never touch the filesystem with archive names: each entry is admitted by an
// `EntryCollector` (name rules of paths.ts, entry and size limits, duplicates and file/folder conflicts, compared
// case- and normalization-insensitively) and kept in memory. `pluginRootPrefix` finds `plugin.json` at the root or
// inside a single top-level folder; `writeEntries` creates the files below a fresh staging directory with exclusive
// creation (mode 0644, directories 0755, archive permissions ignored); `verifyTree` then checks with `lstat` and
// `realpath` that the staging tree holds only regular files and directories inside the staging directory.
import type { InstallLimits } from './errors.ts'
import { chmod, lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isInside } from '../loader.ts'
import { invalid, megabytes, quoteName, tooLarge } from './errors.ts'
import { checkEntryPath, parentPaths, pathKey } from './paths.ts'

/** An admitted archive entry: `path` is a normalized relative POSIX path. */
export interface ArchiveEntry {
  path: string
  type: 'file' | 'dir'
  /** File contents (null for directories). */
  data: Uint8Array | null
}

/** Top-level folders and file names of archive metadata that are never extracted (macOS Finder zips). */
const JUNK_TOP_LEVEL = new Set(['__macosx'])
const JUNK_FILES = new Set(['.ds_store'])

export const MANIFEST_NAME = 'plugin.json'

export type EntryLimits = Pick<InstallLimits, 'entries' | 'expandedBytes'>

/**
 * Validates entries one by one while an archive is read: names (paths.ts), the entry count, the expanded size
 * (declared sizes are checked before any data is decompressed, actual sizes by the readers), duplicates and conflicts
 * between a file and a folder of the same name. Throws the first violation.
 */
export class EntryCollector {
  readonly #limits: EntryLimits
  readonly #issuePath: Array<string | number>
  /** Key -> type of every entry listed by the archive (junk excluded). */
  readonly #types = new Map<string, 'file' | 'dir'>()
  /** Keys of the folders that contain admitted entries. */
  readonly #implied = new Set<string>()
  #count = 0
  #bytes = 0

  constructor(limits: EntryLimits, issuePath: Array<string | number> = []) {
    this.#limits = limits
    this.#issuePath = issuePath
  }

  /** Bytes admitted so far (declared sizes). */
  get bytes(): number {
    return this.#bytes
  }

  /**
   * Admits an entry. Returns its normalized path, or null when it is not extracted (the archive root `./` or macOS
   * metadata such as `__MACOSX/` and `.DS_Store`, which still count against the limits).
   */
  admit(rawName: string, type: 'file' | 'dir', declaredSize: number): string | null {
    this.#count += 1
    if (this.#count > this.#limits.entries)
      throw invalid(`The archive has more than ${this.#limits.entries} entries.`, this.#issuePath)
    const checked = checkEntryPath(rawName)
    if (!checked.ok)
      throw invalid(checked.reason, this.#issuePath)
    if (checked.trailingSlash && type === 'file')
      throw invalid(`The entry ${quoteName(rawName)} is a file whose name ends with "/".`, this.#issuePath)
    if (type === 'file')
      this.addBytes(declaredSize)
    else if (declaredSize > 0)
      throw invalid(`The folder entry ${quoteName(rawName)} carries data.`, this.#issuePath)
    const path = checked.path
    if (path === '')
      return null
    const key = pathKey(path)
    const segments = key.split('/')
    if (JUNK_TOP_LEVEL.has(segments[0] ?? '') || (type === 'file' && JUNK_FILES.has(segments.at(-1) ?? '')))
      return null

    if (this.#types.has(key))
      throw invalid(`The archive contains ${quoteName(path)} more than once.`, this.#issuePath)
    if (type === 'file' && this.#implied.has(key))
      throw invalid(`The archive contains ${quoteName(path)} both as a file and as a folder.`, this.#issuePath)
    for (const parent of parentPaths(key)) {
      if (this.#types.get(parent) === 'file')
        throw invalid(`The archive contains ${quoteName(parent)} both as a file and as a folder.`, this.#issuePath)
    }
    this.#types.set(key, type)
    for (const parent of parentPaths(key))
      this.#implied.add(parent)
    return path
  }

  /** Counts actual bytes (folder copies) or re-checks sizes; throws `payload_too_large` above the expanded limit. */
  addBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw invalid('The archive declares an invalid file size.', this.#issuePath)
    this.#bytes += bytes
    if (this.#bytes > this.#limits.expandedBytes)
      throw tooLarge(`The plugin expands to more than ${megabytes(this.#limits.expandedBytes)}.`, this.#limits.expandedBytes)
  }
}

/**
 * The folder of the archive that holds `plugin.json`: `''` (the archive root) or `<name>/` when every entry sits in
 * one top-level folder (a zipped folder, npm's `package/`).
 */
export function pluginRootPrefix(entries: readonly ArchiveEntry[], issuePath: Array<string | number> = []): string {
  if (entries.some(entry => entry.type === 'file' && entry.path === MANIFEST_NAME))
    return ''
  const tops = new Set(entries.map(entry => entry.path.split('/')[0]))
  if (tops.size === 1) {
    const [top] = [...tops] as [string]
    const folderOnly = entries.every(entry => entry.path !== top || entry.type === 'dir')
    if (folderOnly && entries.some(entry => entry.type === 'file' && entry.path === `${top}/${MANIFEST_NAME}`))
      return `${top}/`
  }
  throw invalid(`${MANIFEST_NAME} must be at the root of the archive or inside a single top-level folder.`, issuePath)
}

/**
 * Writes the entries below `prefix` into `root` (an empty staging directory): folders 0755, files 0644 created
 * exclusively (never through an existing path). Entries outside `prefix` are refused.
 */
export async function writeEntries(root: string, entries: readonly ArchiveEntry[], prefix: string): Promise<void> {
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix) && `${entry.path}/` !== prefix)
      throw invalid(`The entry ${quoteName(entry.path)} is outside the plugin folder.`)
    const relative = entry.path.slice(prefix.length)
    if (relative === '')
      continue
    const target = join(root, ...relative.split('/'))
    if (!isInside(root, target))
      throw invalid(`The entry ${quoteName(entry.path)} resolves outside the staging folder.`)
    if (entry.type === 'dir') {
      await mkdir(target, { recursive: true, mode: 0o755 })
      continue
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o755 })
    await writeFile(target, entry.data ?? new Uint8Array(0), { flag: 'wx', mode: 0o644 })
  }
}

/**
 * Walks a staging tree without following links: every entry must be a regular file or a folder whose realpath is
 * inside `root`; sets the modes (files 0644, folders 0755). Returns the number of files and their total size.
 */
export async function verifyTree(root: string, limits: EntryLimits): Promise<{ count: number, bytes: number }> {
  const realRoot = await realpath(root)
  let count = 0
  let bytes = 0
  let visited = 0
  const walk = async (dir: string, relative: string): Promise<void> => {
    const names = (await readdir(dir)).sort()
    for (const name of names) {
      const path = join(dir, name)
      const shown = relative === '' ? name : `${relative}/${name}`
      if (++visited > limits.entries)
        throw invalid(`The plugin has more than ${limits.entries} entries.`)
      const info = await lstat(path)
      if (info.isSymbolicLink())
        throw invalid(`The plugin contains a symbolic link: ${quoteName(shown)}.`)
      if (!info.isDirectory() && !info.isFile())
        throw invalid(`The plugin contains a special file: ${quoteName(shown)}.`)
      const real = await realpath(path)
      if (!isInside(realRoot, real))
        throw invalid(`The entry ${quoteName(shown)} resolves outside the staging folder.`)
      if (info.isDirectory()) {
        await chmod(path, 0o755)
        await walk(path, shown)
        continue
      }
      await chmod(path, 0o644)
      count += 1
      bytes += info.size
      if (bytes > limits.expandedBytes)
        throw tooLarge(`The plugin is larger than ${megabytes(limits.expandedBytes)}.`, limits.expandedBytes)
    }
  }
  await chmod(root, 0o755)
  await walk(root, '')
  return { count, bytes }
}
