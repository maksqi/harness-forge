// The orphaned file sweep of the files service (ADR-035, ARCHITECTURE.md 6.15). Runs under the exclusive store gate
// (./gate.ts, taken by `FilesService.sweep`), so no upload writes a blob or inserts a row meanwhile.
//
// 1. Candidates: `files` rows (read in keyset batches by id) that are not in `referencedIds`, not pinned and created
//    before `createdBefore`; unreferenced rows that are younger or pinned count as `recentFiles`.
// 2. `DELETE ... WHERE id IN (<chunk>) AND id NOT IN (referencedFileIdsQuery())`: the statement re-checks the message
//    references, so a message committed after the reference scan keeps its file.
// 3. The blob of a deleted row is unlinked only when no row is left with its sha256 (identical uploads share a blob).
// 4. The walk of `files/<aa>/` (`lstat`, regular files only): a 64-hex blob in its own shard with no row and an mtime
//    before `createdBefore` is deleted, a `.<sha256>.<uuid>.tmp` file older than an hour is deleted, anything else stays.
//
// Counts (the meaning of the cleanup DTOs, API.md 5.19): `files` / `fileBytes` = the rows removed and their sizes;
// `blobs` = only the leftover blobs that no row has at all (step 4), not the blobs of the removed rows; `tempFiles` =
// the stale temp files; `diskBytes` = every byte freed on disk (the blobs of removed rows that no row keeps, the
// leftover blobs and the temp files). With `dryRun` nothing is deleted: the counts say what a run would remove (the
// DELETE re-check aside). Paths come only from validated sha256 names, never from request input; only counts are
// logged.
import type { Stats } from 'node:fs'
import type { Db } from '../../db/client.ts'
import type { Logger } from '../../logger.ts'
import type { FileSweepInput, FileSweepResult } from './types.ts'
import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, asc, gt, inArray, notInArray, sql } from 'drizzle-orm'
import { files } from '../../db/schema.ts'
import { guardDb } from '../chats/db-errors.ts'
import { FILE_URL_PREFIX } from './urls.ts'

/** Temporary files of interrupted blob writes older than this are removed. */
export const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000

/** Rows per keyset batch and ids per `IN (...)` statement. */
const BATCH = 500
const SHARD_NAME = /^[\da-f]{2}$/
const BLOB_NAME = /^[\da-f]{64}$/
/** `.<sha256>.<uuid>.tmp`, the temporary name of `storeBlob` (`randomUUID()` is lowercase). */
const TEMP_NAME = /^\.[\da-f]{64}\.[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.tmp$/

/**
 * Ids of the stored files that `file` / `reasoning-file` parts of any message point at (`/api/files/<id>`), as a
 * subquery. Parts that are not objects and rows whose parts are not valid JSON are skipped. Used by the backup export
 * (which files to write) and by the sweep's DELETE re-check.
 */
export function referencedFileIdsQuery() {
  return sql`(
    SELECT substr(ref.url, ${FILE_URL_PREFIX.length + 1}) FROM (
      SELECT
        CASE WHEN p.type = 'object' THEN json_extract(p.value, '$.type') END AS part_type,
        CASE WHEN p.type = 'object' THEN json_extract(p.value, '$.url') END AS url
      FROM messages AS m, json_each(CASE WHEN json_valid(m.parts) THEN m.parts ELSE '[]' END) AS p
    ) AS ref
    WHERE ref.part_type IN ('file', 'reasoning-file')
      AND substr(ref.url, 1, ${FILE_URL_PREFIX.length}) = ${FILE_URL_PREFIX}
  )`
}

export interface SweepContext {
  db: Db
  /** The files root (`data/files`). */
  root: string
  /** The pinned ids, snapshotted while the exclusive gate is held. */
  pinned: ReadonlySet<string>
  /** The time of the sweep (ms): the temp file cutoff is `now - TEMP_FILE_MAX_AGE_MS`. */
  now: number
  logger: Logger
}

interface FileRowRef {
  id: string
  sha256: string
  size: number
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size))
  return out
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  }
  catch (error) {
    if (isMissing(error))
      return null
    throw error
  }
}

/** `<root>/<aa>/<sha256>`; null for a malformed hash (a row this service did not write). */
function blobPath(root: string, sha256: string): string | null {
  return BLOB_NAME.test(sha256) ? join(root, sha256.slice(0, 2), sha256) : null
}

/** The sha256 values of `shas` that at least one `files` row still has. */
async function shasWithRows(db: Db, shas: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (const chunk of chunks(shas, BATCH)) {
    const rows = await guardDb(() => db.selectDistinct({ sha256: files.sha256 }).from(files).where(inArray(files.sha256, chunk)))
    for (const row of rows)
      found.add(row.sha256)
  }
  return found
}

/** Step 1: every row in keyset batches, split into candidates and kept rows (their sha256 values). */
async function classifyRows(context: SweepContext, input: FileSweepInput, result: FileSweepResult): Promise<{ candidates: FileRowRef[], keptShas: Set<string> }> {
  const candidates: FileRowRef[] = []
  const keptShas = new Set<string>()
  let cursor = ''
  for (;;) {
    const after = cursor
    const rows = await guardDb(() => context.db
      .select({ id: files.id, sha256: files.sha256, size: files.size, createdAt: files.createdAt })
      .from(files)
      .where(gt(files.id, after))
      .orderBy(asc(files.id))
      .limit(BATCH))
    for (const row of rows) {
      if (input.referencedIds.has(row.id)) {
        keptShas.add(row.sha256)
      }
      else if (context.pinned.has(row.id) || !(row.createdAt < input.createdBefore)) {
        result.recentFiles += 1
        keptShas.add(row.sha256)
      }
      else {
        candidates.push({ id: row.id, sha256: row.sha256, size: row.size })
      }
    }
    if (rows.length < BATCH)
      break
    cursor = rows[rows.length - 1]!.id
  }
  return { candidates, keptShas }
}

/** Steps 2 and 3 for real: deletes the candidates (re-checked) and unlinks the blobs no row keeps (`diskBytes`). */
async function removeRows(context: SweepContext, candidates: readonly FileRowRef[], result: FileSweepResult): Promise<void> {
  const deleted: FileRowRef[] = []
  for (const chunk of chunks(candidates.map(row => row.id), BATCH)) {
    const rows = await guardDb(() => context.db
      .delete(files)
      .where(and(inArray(files.id, chunk), notInArray(files.id, referencedFileIdsQuery())))
      .returning({ id: files.id, sha256: files.sha256, size: files.size }))
    deleted.push(...rows)
  }
  result.files = deleted.length
  result.fileBytes = deleted.reduce((total, row) => total + row.size, 0)
  const shas = [...new Set(deleted.map(row => row.sha256))]
  const stillUsed = await shasWithRows(context.db, shas)
  for (const sha256 of shas) {
    const path = stillUsed.has(sha256) ? null : blobPath(context.root, sha256)
    if (path === null)
      continue
    const stats = await lstatOrNull(path)
    // Freed disk space only: `blobs` counts the leftover blobs of the walk.
    if (stats?.isFile() === true && await removeFile(context, path))
      result.diskBytes += stats.size
  }
}

/** Steps 2 and 3 as a dry run: the candidates and the disk bytes of the blobs that only candidates use. */
async function countRows(context: SweepContext, candidates: readonly FileRowRef[], keptShas: ReadonlySet<string>, result: FileSweepResult): Promise<void> {
  result.files = candidates.length
  result.fileBytes = candidates.reduce((total, row) => total + row.size, 0)
  for (const sha256 of new Set(candidates.map(row => row.sha256))) {
    const path = keptShas.has(sha256) ? null : blobPath(context.root, sha256)
    if (path === null)
      continue
    const stats = await lstatOrNull(path)
    if (stats?.isFile() === true)
      result.diskBytes += stats.size
  }
}

/** Unlinks one file; false when it is already gone or cannot be removed (logged without its path). */
async function removeFile(context: SweepContext, path: string): Promise<boolean> {
  try {
    await unlink(path)
    return true
  }
  catch (error) {
    if (!isMissing(error))
      context.logger.warn('file cleanup could not remove a stored file', { code: errorCode(error) })
    return false
  }
}

/** Step 4: rowless blobs past the cutoff (`blobs`) and stale temporary files (`tempFiles`) in `files/<aa>/`. */
async function walkStore(context: SweepContext, input: FileSweepInput, result: FileSweepResult): Promise<void> {
  let shards: string[]
  try {
    shards = await readdir(context.root)
  }
  catch (error) {
    if (isMissing(error))
      return
    throw error
  }
  const tempCutoff = context.now - TEMP_FILE_MAX_AGE_MS
  for (const shard of shards.sort()) {
    if (!SHARD_NAME.test(shard))
      continue
    const directory = join(context.root, shard)
    if ((await lstatOrNull(directory))?.isDirectory() !== true)
      continue
    let names: string[]
    try {
      names = await readdir(directory)
    }
    catch (error) {
      if (isMissing(error))
        continue
      throw error
    }
    const stale: { sha256: string, path: string, size: number }[] = []
    for (const name of names.sort()) {
      const isBlob = BLOB_NAME.test(name) && name.startsWith(shard)
      const isTemp = !isBlob && TEMP_NAME.test(name)
      if (!isBlob && !isTemp)
        continue
      const path = join(directory, name)
      const stats = await lstatOrNull(path)
      if (stats === null || !stats.isFile())
        continue
      if (isTemp) {
        if (stats.mtimeMs < tempCutoff && (input.dryRun || await removeFile(context, path))) {
          result.tempFiles += 1
          result.diskBytes += stats.size
        }
      }
      else if (stats.mtimeMs < input.createdBefore) {
        stale.push({ sha256: name, path, size: stats.size })
      }
    }
    if (stale.length === 0)
      continue
    // A row of any age keeps its blob (in a dry run the candidates' blobs were counted with their rows).
    const withRows = await shasWithRows(context.db, stale.map(blob => blob.sha256))
    for (const blob of stale) {
      if (withRows.has(blob.sha256))
        continue
      if (input.dryRun || await removeFile(context, blob.path)) {
        result.blobs += 1
        result.diskBytes += blob.size
      }
    }
  }
}

/** The sweep itself; the caller holds the exclusive store gate. */
export async function sweepStore(context: SweepContext, input: FileSweepInput): Promise<FileSweepResult> {
  const result: FileSweepResult = { files: 0, fileBytes: 0, blobs: 0, diskBytes: 0, tempFiles: 0, recentFiles: 0 }
  const { candidates, keptShas } = await classifyRows(context, input, result)
  if (input.dryRun)
    await countRows(context, candidates, keptShas, result)
  else if (candidates.length > 0)
    await removeRows(context, candidates, result)
  await walkStore(context, input, result)
  return result
}
