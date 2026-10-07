// Gzipped tar reader for npm tarballs and `.tgz` URL installs (PLUGINS.md 12 "Archive rules").
//
// The gzip layer is expanded first with a hard output cap (`maxOutputLength`: a decompression bomb stops at the cap),
// then the plain tar is parsed with node-tar's `Parser` in strict mode (checksum failures, truncation and malformed
// headers are errors). The parser only reads: every entry is admitted by `EntryCollector` and kept in memory; nothing
// is written by tar itself. Only regular files and folders are accepted; symbolic and hard links, devices, FIFOs and
// every other entry type (including entries tar would ignore, such as sparse files) are refused. Nested compression
// is refused as well. Phase 12 (W12.2): the owner exec bit of the header mode is recorded (`ArchiveEntry.executable`),
// and entries the collector does not select are skipped before any check (never admitted or counted).
import type { ReadEntry } from 'tar'
import type { ArchiveEntry, EntryCollector } from './archive.ts'
import type { IssuePath } from './errors.ts'
import { Buffer } from 'node:buffer'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'
import { Parser } from 'tar'
import { invalid, megabytes, quoteName, tooLarge } from './errors.ts'

/** zlib's gunzip on the thread pool (the event loop keeps serving requests while an archive expands). */
const gunzipAsync = promisify(gunzipCallback)

/** Header, padding and PAX blocks of a tar on top of the file contents (per entry, generous). */
const TAR_OVERHEAD_PER_ENTRY = 4096
/** PAX / GNU long-name records larger than this are refused. */
const MAX_META_ENTRY_BYTES = 64 * 1024

const FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile'])

/** True when `data` starts with the gzip magic bytes. */
export function looksLikeGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1F && data[1] === 0x8B
}

function describeType(type: string): string {
  switch (type) {
    case 'SymbolicLink':
      return 'a symbolic link'
    case 'Link':
      return 'a hard link'
    case 'CharacterDevice':
    case 'BlockDevice':
      return 'a device'
    case 'FIFO':
      return 'a FIFO'
    default:
      return `an unsupported entry (${type})`
  }
}

/** Expands the gzip layer with a cap of the expanded limit plus tar overhead. */
async function gunzip(data: Uint8Array, limits: { entries: number, expandedBytes: number }, issuePath: IssuePath): Promise<Buffer> {
  if (!looksLikeGzip(data))
    throw invalid('The archive is not a gzip-compressed tar (.tgz).', issuePath)
  try {
    return await gunzipAsync(data, { maxOutputLength: limits.expandedBytes + limits.entries * TAR_OVERHEAD_PER_ENTRY })
  }
  catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE')
      throw tooLarge(`The archive expands to more than ${megabytes(limits.expandedBytes)}.`, limits.expandedBytes)
    throw invalid('The archive is not a valid gzip file.', issuePath)
  }
}

/** Parses a plain tar; every entry goes through `collector`. */
function parseTar(tar: Buffer, collector: EntryCollector, issuePath: IssuePath): Promise<ArchiveEntry[]> {
  return new Promise((resolve, reject) => {
    const parser = new Parser({
      strict: true,
      zstd: false,
      brotli: false,
      maxDecompressionRatio: 1,
      maxMetaEntrySize: MAX_META_ENTRY_BYTES,
    })
    const entries: ArchiveEntry[] = []
    let failure: Error | null = null
    let settled = false
    const settle = (error: Error | null): void => {
      if (settled)
        return
      settled = true
      if (error)
        reject(error)
      else
        resolve(entries)
    }
    // A plain Error goes to tar (its warn helper decorates the object); the HarnessError is kept for the caller.
    const fail = (error: Error): void => {
      if (failure !== null)
        return
      failure = error
      parser.abort(new Error('aborted'))
    }

    const onEntry = (entry: ReadEntry): void => {
      if (failure !== null) {
        entry.resume()
        return
      }
      try {
        // Phase 12: an entry outside the chosen subtree is skipped before any other check.
        if (!collector.selects(entry.path)) {
          entry.resume()
          return
        }
        const isFile = FILE_TYPES.has(entry.type)
        if (!isFile && entry.type !== 'Directory')
          throw invalid(`The entry ${quoteName(entry.path)} is ${describeType(entry.type)}; only files and folders are allowed.`, issuePath)
        const declared = isFile ? entry.size : 0
        const path = collector.admit(entry.path, isFile ? 'file' : 'dir', declared)
        if (!isFile || path === null) {
          entry.resume()
          if (!isFile && path !== null)
            entries.push({ path, type: 'dir', data: null })
          return
        }
        const chunks: Buffer[] = []
        let received = 0
        entry.on('end', () => {
          if (failure !== null)
            return
          if (received !== declared) {
            fail(invalid(`The entry ${quoteName(entry.path)} is truncated.`, issuePath))
            return
          }
          const executable = ((entry.mode ?? 0) & 0o100) !== 0
          entries.push({ path, type: 'file', data: new Uint8Array(Buffer.concat(chunks, received)), ...(executable ? { executable: true } : {}) })
        })
        entry.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > declared)
            fail(invalid(`The entry ${quoteName(entry.path)} is larger than declared.`, issuePath))
          else
            chunks.push(chunk)
        })
      }
      catch (error) {
        entry.resume()
        fail(error as Error)
      }
    }

    parser.on('entry', onEntry)
    parser.on('ignoredEntry', (entry: ReadEntry) => {
      let selected = true
      try {
        selected = collector.selects(entry.path)
      }
      catch (error) {
        fail(error as Error)
        return
      }
      if (!selected)
        return
      fail(invalid(`The entry ${quoteName(entry.path)} is ${describeType(entry.type)}; only files and folders are allowed.`, issuePath))
    })
    parser.on('error', (error: Error) => {
      settle(failure ?? invalid(`The archive is not a valid tar file (${error.message.replace(/^TAR_\w+: /, '')}).`, issuePath))
    })
    parser.on('end', () => settle(failure))
    try {
      parser.end(tar)
    }
    catch (error) {
      settle(failure ?? invalid(`The archive is not a valid tar file (${(error as Error).message}).`, issuePath))
    }
  })
}

/** Reads a `.tgz`: gzip with an output cap, then a strict tar parse. */
export async function readTarGz(data: Uint8Array, collector: EntryCollector, limits: { entries: number, expandedBytes: number }, issuePath: IssuePath = []): Promise<ArchiveEntry[]> {
  const tar = await gunzip(data, limits, issuePath)
  if (looksLikeGzip(tar))
    throw invalid('Nested compression is not supported: the archive must be one gzip-compressed tar.', issuePath)
  return parseTar(tar, collector, issuePath)
}
