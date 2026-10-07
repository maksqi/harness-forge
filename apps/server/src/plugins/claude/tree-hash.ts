// The whole-tree trust hash of a Claude Code plugin (Phase 12, ADR-053; W12.1-T2; ARCHITECTURE.md 6.33 "Trust").
//
// `hf-claude-plugin/v1` = sha256 of the bytes `hf-claude-plugin/v1\0`, then, for every regular file in the UTF-8 byte
// order of its POSIX path relative to the plugin folder, `F\0<path>\0<755|644>\0<size>\0<sha256 hex of the content>`,
// then (a plugin installed from a marketplace entry) `O\0` + `canonicalJson(overlay)`. The mode is 755 when the owner
// execute bit is set, else 644 (exec bits are kept only for this format; an exec bit alone runs nothing). A symbolic link
// or a special file (FIFO, socket, device) anywhere in the tree is a problem (the plugin is `error`; the other files are
// still listed, so the inspection can show them; the link itself is never followed or read); a linked folder
// (`source: 'link'`, pinned by its path) skips `.git` and `node_modules` and ignores links and special files. Caps:
// `TREE_ENTRIES_MAX` entries (files and folders) and `TREE_BYTES_MAX` bytes; beyond them the tree is a problem too.
//
// File digests are cached in memory by (path, size, mtime, ctime, inode, device), so hashing an unchanged tree again
// costs one `lstat` per entry; the cache is bounded (`TREE_HASH_CACHE_MAX` files, oldest first out) and cleared by
// `clearTreeHashCache()` (shutdown, tests). Contents are never logged.
import type { ClaudeEntryOverlay } from '../types.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson } from '@harness-forge/shared'
import { WORKSPACE_READ_FLAGS } from '../../workspace/paths.ts'

/** The prefix of the hashed bytes (the version of the layout). */
export const TREE_HASH_PREFIX = 'hf-claude-plugin/v1'
/** Files and folders of one plugin tree. */
export const TREE_ENTRIES_MAX = 2000
/** Bytes of every file of one plugin tree together (100 MB). */
export const TREE_BYTES_MAX = 100 * 1024 * 1024
/** Files whose digest is cached (process-wide). */
export const TREE_HASH_CACHE_MAX = 20_000
/** Folders a linked plugin folder never enters. */
const LINKED_SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['.git', 'node_modules'])

/** One regular file of a plugin tree. */
export interface PluginTreeFile {
  /** POSIX path relative to the plugin folder. */
  readonly path: string
  readonly absolute: string
  readonly size: number
  /** The owner execute bit is set (mode 755 in the hash). */
  readonly executable: boolean
}

/** A scanned plugin tree. */
export interface PluginTree {
  /** The plugin folder (canonical realpath). */
  readonly root: string
  /** Regular files, sorted by the UTF-8 bytes of their path. */
  readonly files: readonly PluginTreeFile[]
  /** Folders (POSIX paths relative to the root), sorted. */
  readonly folders: readonly string[]
  /** Bytes of every file. */
  readonly bytes: number
  /** Why the tree cannot be trusted or loaded (a link, a special file, a cap); null when it is fine. */
  readonly problem: string | null
}

export interface ScanTreeOptions {
  /** A linked folder: skip `.git` / `node_modules`, ignore links and special files. */
  readonly linked?: boolean
  readonly signal?: AbortSignal
}

/** Compares two POSIX paths by their UTF-8 bytes. */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** Scans the plugin folder `root` (a canonical realpath). Never throws for problems of the tree (only on abort). */
export async function scanPluginTree(root: string, options: ScanTreeOptions = {}): Promise<PluginTree> {
  const files: PluginTreeFile[] = []
  const folders: string[] = []
  let bytes = 0
  let entries = 0
  let problem: string | null = null
  /** A cap ended the scan (a link or a special file only marks the problem: the rest is still listed). */
  let stopped = false
  const linked = options.linked === true

  const walk = async (absolute: string, rel: string): Promise<void> => {
    options.signal?.throwIfAborted()
    let dirents
    try {
      dirents = await readdir(absolute, { withFileTypes: true })
    }
    catch {
      problem ??= `The folder ${rel === '' ? '.' : rel} cannot be read.`
      return
    }
    dirents.sort((a, b) => compareUtf8(a.name, b.name))
    for (const dirent of dirents) {
      if (stopped)
        return
      const path = rel === '' ? dirent.name : `${rel}/${dirent.name}`
      const target = join(absolute, dirent.name)
      if (++entries > TREE_ENTRIES_MAX) {
        problem = `The plugin has more than ${TREE_ENTRIES_MAX} files and folders.`
        stopped = true
        return
      }
      if (dirent.isSymbolicLink()) {
        if (!linked)
          problem ??= `The plugin contains a symbolic link (${path}); links are not allowed.`
        continue
      }
      if (dirent.isDirectory()) {
        if (linked && LINKED_SKIPPED_FOLDERS.has(dirent.name))
          continue
        folders.push(path)
        await walk(target, path)
        continue
      }
      if (!dirent.isFile()) {
        if (!linked)
          problem ??= `The plugin contains a special file (${path}); only regular files are allowed.`
        continue
      }
      let info
      try {
        info = await lstat(target)
      }
      catch {
        problem ??= `The file ${path} cannot be read.`
        continue
      }
      if (!info.isFile()) {
        if (!linked)
          problem ??= `The plugin contains a symbolic link or a special file (${path}).`
        continue
      }
      bytes += info.size
      if (bytes > TREE_BYTES_MAX) {
        problem = `The plugin files are larger than ${TREE_BYTES_MAX / 1024 / 1024} MB together.`
        stopped = true
        return
      }
      files.push({ path, absolute: target, size: info.size, executable: (info.mode & 0o100) !== 0 })
    }
  }

  await walk(root, '')
  files.sort((a, b) => compareUtf8(a.path, b.path))
  folders.sort(compareUtf8)
  return { root, files, folders, bytes, problem }
}

interface CachedDigest {
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
  readonly ino: bigint
  readonly dev: bigint
  readonly sha256: string
}

const digestCache = new Map<string, CachedDigest>()

/** Drops every cached file digest (shutdown, tests). */
export function clearTreeHashCache(): void {
  digestCache.clear()
}

/** Cached file digests (tests). */
export function treeHashCacheSize(): number {
  return digestCache.size
}

/** The sha256 (hex) and size of one regular file, read without following a link; cached by its identity and times. */
async function fileDigest(file: PluginTreeFile, signal?: AbortSignal): Promise<{ sha256: string, size: number }> {
  signal?.throwIfAborted()
  const handle = await open(file.absolute, WORKSPACE_READ_FLAGS)
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile())
      throw new Error('not a regular file')
    const cached = digestCache.get(file.absolute)
    if (cached !== undefined && cached.size === stats.size && cached.mtimeNs === stats.mtimeNs && cached.ctimeNs === stats.ctimeNs && cached.ino === stats.ino && cached.dev === stats.dev)
      return { sha256: cached.sha256, size: Number(stats.size) }
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(65_536)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0)
        break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const sha256 = hash.digest('hex')
    digestCache.delete(file.absolute)
    digestCache.set(file.absolute, { size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, ino: stats.ino, dev: stats.dev, sha256 })
    while (digestCache.size > TREE_HASH_CACHE_MAX) {
      const oldest = digestCache.keys().next().value
      if (oldest === undefined)
        break
      digestCache.delete(oldest)
    }
    return { sha256, size: position }
  }
  finally {
    await handle.close().catch(() => {})
  }
}

/** The hashed record of one file (`F\0<path>\0<755|644>\0<size>\0<sha256>`). */
export function treeFileRecord(path: string, executable: boolean, size: number, sha256: string): string {
  return `F\0${path}\0${executable ? '755' : '644'}\0${size}\0${sha256}`
}

/**
 * The `hf-claude-plugin/v1` hash of a scanned tree (see the module comment) and the overlay of its marketplace entry.
 * Throws when a file cannot be read (it changed while it was hashed); the caller reports the plugin as `error`.
 */
export async function hashPluginTree(tree: Pick<PluginTree, 'files'>, overlay?: ClaudeEntryOverlay | null, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  hash.update(`${TREE_HASH_PREFIX}\0`, 'utf8')
  for (const file of tree.files) {
    const digest = await fileDigest(file, signal)
    hash.update(treeFileRecord(file.path, file.executable, digest.size, digest.sha256), 'utf8')
  }
  if (overlay !== undefined && overlay !== null)
    hash.update(`O\0${canonicalJson(overlay)}`, 'utf8')
  return hash.digest('hex')
}
