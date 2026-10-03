import type { PluginDataScan } from '@harness-forge/shared'
// Plugin data scan of the orphaned file cleanup (Phase 8, ADR-039, ARCHITECTURE.md 6.15 "Plugin data"). Owner: W8.7
// (W8.7-T3). One code path for the manual cleanup (and its preview) and the automatic sweep.
//
// A loose `file_` id scan of every regular file under `DataPaths.pluginData` (`plugins/.data/**`: the data folders of
// enabled and disabled plugins and the `keepData` leftovers of uninstalled ones):
// - the folders are read with `opendir` (entries with their types, read lazily, so a huge folder never sits in memory)
//   and every entry is checked with `lstat`: symbolic links are never followed (to a folder or a file), folders are
//   entered up to `maxDepth` levels below the root, FIFOs, sockets and devices are skipped;
// - a regular file is opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (a link swapped in after the `lstat` fails to open,
//   a FIFO swapped in does not block) and checked again with `fstat`;
// - it is read in `chunkBytes` chunks (1 MiB) decoded as latin1 (one character per byte, so any content is safe), and
//   the last 20 bytes of a chunk are carried over to the next one, so an id (`file_` + 16 = 21 bytes) split across two
//   chunks is still found; the ids are matched like the database scan (`collectFileIds`, the same lookahead regex);
// - a budget: at most `maxBytes` (256 MiB) read, `maxEntries` (50,000) entries visited (files, folders, links and
//   others), `maxDepth` (32) folder levels, plus the abort signal (checked between entries and chunks; the scan then
//   rejects with the signal's reason).
//
// Over budget the scan reports `partial`: the automatic sweep is then skipped (`stopWhenPartial` ends the scan at the
// first limit, since nothing will be deleted anyway), a manual cleanup proceeds with what was found (a file larger
// than the bytes left is skipped and the walk goes on with the next entries until the entry limit). An entry that
// cannot be read (permissions) makes the scan partial too; one that disappeared meanwhile is ignored. Nothing is
// written, and only counts leave this module (never names, paths or ids).
//
// Accepted race: a folder swapped for a link between its `lstat` and its `opendir` is followed once (Node has no
// `O_NOFOLLOW` folder listing); plugin data is written by plugins, which already run as the server user.
import type { Dir } from 'node:fs'
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { collectFileIds } from './references.ts'

const MIB = 1024 * 1024

/** The limits of one plugin data scan. */
export interface PluginDataScanBudget {
  /** Bytes read in total. */
  maxBytes: number
  /** Entries visited in total (regular files, folders, links and others). */
  maxEntries: number
  /** Folder levels below the root that are entered (the root's own entries are level 1). */
  maxDepth: number
}

/** ADR-039: 256 MiB, 50,000 entries, 32 levels. */
export const PLUGIN_DATA_SCAN_BUDGET: Readonly<PluginDataScanBudget> = Object.freeze({
  maxBytes: 256 * MIB,
  maxEntries: 50_000,
  maxDepth: 32,
})

/** Bytes per read. */
export const PLUGIN_DATA_CHUNK_BYTES = MIB

/** Bytes carried from one chunk to the next: an id is 21 bytes, so a split one has at most 20 in the first chunk. */
export const PLUGIN_DATA_CARRY_BYTES = 20

/** `O_NOFOLLOW` / `O_NONBLOCK` where the platform has them (0 on Windows). */
const NO_FOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const NON_BLOCK = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
const READ_FLAGS = constants.O_RDONLY | NO_FOLLOW | NON_BLOCK

export interface PluginDataScanOptions {
  /** Overrides of `PLUGIN_DATA_SCAN_BUDGET` (tests). */
  budget?: Partial<PluginDataScanBudget>
  /** Bytes per read (default `PLUGIN_DATA_CHUNK_BYTES`; at least `PLUGIN_DATA_CARRY_BYTES + 1`). */
  chunkBytes?: number
  /** Aborts the scan between entries and chunks (rejects with the signal's reason). */
  signal?: AbortSignal
  /**
   * End the scan at the first limit (the automatic sweep, which is skipped anyway); default false: a manual cleanup
   * keeps scanning what still fits.
   */
  stopWhenPartial?: boolean
}

/** Which limit made a scan partial (debug logs only). */
export type PluginDataScanLimit = 'bytes' | 'entries' | 'depth' | 'unreadable'

export interface PluginDataScanResult {
  /** `complete`: every regular file was read; `partial`: a limit or an unreadable entry stopped part of the scan. */
  readonly scan: PluginDataScan
  /** Regular files read. */
  readonly files: number
  /** Bytes read. */
  readonly bytes: number
  /** The first limit hit; null when complete. */
  readonly limit: PluginDataScanLimit | null
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** Removed (or replaced by a non-folder) meanwhile: ignored. */
function isGone(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** `O_NOFOLLOW` refused a link swapped in after the `lstat` (Linux and macOS `ELOOP`, BSD `EMLINK`). */
function isLink(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ELOOP' || code === 'EMLINK'
}

/**
 * Adds every `file_` id found in the files under `root` to `ids` and reports how much was read. A missing root is a
 * complete scan of nothing.
 */
export async function scanPluginData(root: string, ids: Set<string>, options: PluginDataScanOptions = {}): Promise<PluginDataScanResult> {
  const budget: PluginDataScanBudget = { ...PLUGIN_DATA_SCAN_BUDGET, ...options.budget }
  const chunkBytes = Math.max(PLUGIN_DATA_CARRY_BYTES + 1, Math.floor(options.chunkBytes ?? PLUGIN_DATA_CHUNK_BYTES))
  const { signal } = options
  const buffer = Buffer.allocUnsafe(chunkBytes)
  const state = { files: 0, bytes: 0, entries: 0, limit: null as PluginDataScanLimit | null, done: false }

  function partial(limit: PluginDataScanLimit): void {
    state.limit ??= limit
    if (options.stopWhenPartial === true)
      state.done = true
  }

  /** One regular file (`path` passed `lstat` as a file). */
  async function readFile(path: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, READ_FLAGS)
    }
    catch (error) {
      if (!isGone(error) && !isLink(error))
        partial('unreadable')
      return
    }
    try {
      const stats = await handle.stat()
      if (!stats.isFile())
        return
      if (stats.size > budget.maxBytes - state.bytes) {
        partial('bytes')
        return
      }
      state.files += 1
      let carry = ''
      for (;;) {
        signal?.throwIfAborted()
        const room = budget.maxBytes - state.bytes
        // The file grew past the budget since its `fstat`: a 1-byte probe tells the end of the file from more content.
        const { bytesRead } = await handle.read(buffer, 0, room > 0 ? Math.min(chunkBytes, room) : 1, null)
        if (bytesRead === 0)
          return
        if (room <= 0) {
          partial('bytes')
          return
        }
        state.bytes += bytesRead
        const text = carry + buffer.toString('latin1', 0, bytesRead)
        collectFileIds(text, ids)
        carry = text.slice(-PLUGIN_DATA_CARRY_BYTES)
      }
    }
    catch (error) {
      if (signal?.aborted === true)
        throw error
      if (!isGone(error))
        partial('unreadable')
    }
    finally {
      await handle.close()
    }
  }

  /** The entries of folder `dir`, which is `depth` levels below the root. */
  async function walk(dir: string, depth: number): Promise<void> {
    let folder: Dir
    try {
      folder = await opendir(dir, { bufferSize: 64 })
    }
    catch (error) {
      if (!isGone(error))
        partial('unreadable')
      return
    }
    // `for await` closes the folder when the loop ends, breaks or throws.
    for await (const entry of folder) {
      signal?.throwIfAborted()
      if (state.done)
        break
      if (state.entries >= budget.maxEntries) {
        state.limit ??= 'entries'
        state.done = true
        break
      }
      state.entries += 1
      if (entry.isSymbolicLink())
        continue
      const path = join(dir, entry.name)
      let stats: Awaited<ReturnType<typeof lstat>>
      try {
        stats = await lstat(path)
      }
      catch (error) {
        if (!isGone(error))
          partial('unreadable')
        continue
      }
      if (stats.isDirectory()) {
        if (depth + 1 > budget.maxDepth)
          partial('depth')
        else
          await walk(path, depth + 1)
      }
      else if (stats.isFile()) {
        await readFile(path)
      }
      // Links, FIFOs, sockets and devices are skipped.
    }
  }

  signal?.throwIfAborted()
  await walk(root, 0)
  return { scan: state.limit === null ? 'complete' : 'partial', files: state.files, bytes: state.bytes, limit: state.limit }
}
