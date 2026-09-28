// Backup export of `GET /data/export` (ADR-024, API.md 4.16 / 5.19, ARCHITECTURE.md 6.9).
//
// `planBackup` is the pre-check: it lists the chats and estimates the zip from the database (message, title and
// settings bytes, the distinct attachment blobs that `file` / `reasoning-file` parts point at) and refuses with
// `payload_too_large` a backup that an import could not take (more than `backupEntries` entries or index items) or
// that could exceed a zip without zip64 (fflate cannot write zip64). Nothing else is read before the stream is pulled.
//
// `createBackupStream` builds the zip while it is read: a pull-based `ReadableStream` (high water mark 0, so nothing
// happens before the first read) drives fflate's streaming `Zip`; every pull pushes one piece (64 KB of a chat body or
// one chunk of a file) until the zip emits bytes. Layout, every entry mode 0644 with mtime = `exportedAt`:
//
//   settings.json         the public settings (settings=true)
//   chats/<chatId>.json   `ChatsService.export(id, 'json')`: chat export v2, archived chats included, deflated
//   files/<sha256>        each referenced blob once: stored for images and PDF, deflated for text/*   (files=true)
//   files/index.json      one item per referenced file row whose blob was written and verified         (files=true)
//   manifest.json         written last, with the exact counts
//
// Nothing else is ever read: no secrets, credentials, password, plugins, MCP servers, model or tool preferences, share
// links or usage rows. A chat deleted during the export is left out; a blob that is missing or no longer matches its
// sha256 is left out of the index (the import then reports it missing). A cancel (HEAD, a client that went away)
// terminates the zip and releases the open file. If the zip would still exceed the zip limits while it is written
// (chats grew after the pre-check), the stream fails instead of producing a broken archive.
import type { BackupFileEntry, BackupManifest, DataExportQuery } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { StoredFile } from '../files/types.ts'
import type { DataLimits } from './limits.ts'
import { createHash } from 'node:crypto'
import { backupFileEntrySchema, isHarnessError, LIMITS, settingsSchema, SHA256_HEX_PATTERN } from '@harness-forge/shared'
import { asc, inArray, sql } from 'drizzle-orm'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { chats, files, messages } from '../../db/schema.ts'
import { appVersion } from '../../paths.ts'
import { guardDb } from '../chats/db-errors.ts'
import { FILE_URL_PREFIX } from '../files/index.ts'
import { formatBytes, payloadTooLarge, tooManyEntries } from './limits.ts'
import { referencedFileIds } from './parts.ts'

/** Unix host and a regular file with mode 0644 in the upper 16 bits of the external attributes. */
const UNIX_HOST = 3
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0
/** Zip (DOS) timestamps must lie in 1980-2099. */
const ZIP_MIN_TIME = Date.UTC(1980, 0, 2)
const ZIP_MAX_TIME = Date.UTC(2099, 11, 31)
const DEFLATE_LEVEL = 6
/** Bytes of a chat body or of a JSON entry pushed into the zip per step. */
const PUSH_BYTES = 64 * 1024
/** Hard limits of a zip without zip64: 16-bit entry counts, 32-bit offsets. */
const ZIP_MAX_ENTRIES = 0xFFFF
const ZIP_MAX_OFFSET = 0xFFFF_FFFF
/** Pre-check estimates (generous: chats are deflated, blobs stored). */
const ENTRY_OVERHEAD_BYTES = 256
const CHAT_OVERHEAD_BYTES = 2048
const INDEX_ITEM_BYTES = 512
const FIXED_BYTES = 64 * 1024
/** Ids per `IN (...)` lookup. */
const ID_CHUNK = 500

const encoder = new TextEncoder()

/** What the export writes, decided by the pre-check. */
export interface BackupPlan {
  exportedAt: number
  /** harness-forge version for the manifest (<= 64 chars). */
  appVersion: string
  includeFiles: boolean
  includeSettings: boolean
  /** Every chat id at the time of the pre-check, archived chats included, in id order (uuidv7: creation order). */
  chatIds: string[]
}

/** `harness-forge-backup-<yyyy-mm-dd>.zip` (UTC date of `exportedAt`). */
export function backupFilename(exportedAt: number): string {
  return `harness-forge-backup-${new Date(exportedAt).toISOString().slice(0, 10)}.zip`
}

/**
 * Ids of the stored files that `file` / `reasoning-file` parts of any message point at (`/api/files/<id>`), as a
 * subquery. Parts that are not objects and rows whose parts are not valid JSON are skipped.
 */
function referencedFileIdsQuery() {
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

/** Distinct blobs (by sha256) of the referenced files, their bytes and the number of file rows. */
async function referencedBlobs(deps: AppDeps): Promise<{ blobs: number, bytes: number, rows: number }> {
  const groups = await deps.db
    .select({ size: sql<number>`max(${files.size})`, rows: sql<number>`count(*)` })
    .from(files)
    .where(inArray(files.id, referencedFileIdsQuery()))
    .groupBy(files.sha256)
  return {
    blobs: groups.length,
    bytes: groups.reduce((total, group) => total + Number(group.size), 0),
    rows: groups.reduce((total, group) => total + Number(group.rows), 0),
  }
}

/**
 * The pre-check of `GET /data/export` (`files` and `settings` default to true): lists the chats and refuses with
 * `payload_too_large` (the message suggests `files=false` when that would help) a backup with more entries than
 * `limits.backupEntries` or an estimated size above `limits.backupBytes`.
 */
export async function planBackup(deps: AppDeps, query: DataExportQuery, limits: DataLimits, exportedAt: number): Promise<BackupPlan> {
  const includeFiles = query.files ?? true
  const includeSettings = query.settings ?? true
  const { db } = deps
  return guardDb(async () => {
    const chatRows = await db
      .select({ id: chats.id, bytes: sql<number>`length(CAST(${chats.settings} AS BLOB)) + coalesce(length(CAST(${chats.title} AS BLOB)), 0)` })
      .from(chats)
      .orderBy(asc(chats.id))
    const [messageTotals] = await db
      .select({ bytes: sql<number>`coalesce(sum(length(CAST(${messages.parts} AS BLOB)) + coalesce(length(CAST(${messages.metadata} AS BLOB)), 0)), 0)` })
      .from(messages)
    const blobs = includeFiles ? await referencedBlobs(deps) : { blobs: 0, bytes: 0, rows: 0 }

    const baseEntries = 1 + (includeSettings ? 1 : 0) + chatRows.length
    const entries = baseEntries + (includeFiles ? 1 + blobs.blobs : 0)
    const baseBytes = FIXED_BYTES + Number(messageTotals?.bytes ?? 0)
      + chatRows.reduce((total, row) => total + Number(row.bytes) + CHAT_OVERHEAD_BYTES, 0)
      + baseEntries * ENTRY_OVERHEAD_BYTES
    const bytes = baseBytes + (includeFiles ? blobs.bytes + blobs.rows * INDEX_ITEM_BYTES + (1 + blobs.blobs) * ENTRY_OVERHEAD_BYTES : 0)
    const withoutFilesFits = baseEntries <= limits.backupEntries && baseBytes <= limits.backupBytes
    const hint = includeFiles && withoutFilesFits
      ? 'Export it without attachments (files=false), or delete some chats.'
      : 'Delete some chats, or export chats one by one.'
    if (entries > limits.backupEntries || blobs.rows > limits.backupEntries) {
      const count = Math.max(entries, blobs.rows)
      throw tooManyEntries(
        `The backup would have ${count.toLocaleString('en-US')} entries, more than the ${limits.backupEntries.toLocaleString('en-US')} a backup can hold. ${hint}`,
        limits.backupEntries,
      )
    }
    if (bytes > limits.backupBytes)
      throw payloadTooLarge(`The backup would be about ${formatBytes(bytes)}, more than the ${formatBytes(limits.backupBytes)} a backup zip can hold. ${hint}`, limits.backupBytes)
    return { exportedAt, appVersion: appVersion().slice(0, 64), includeFiles, includeSettings, chatIds: chatRows.map(row => row.id) }
  })
}

/** The file rows of a blob (same sha256), in order of first reference. */
interface BlobGroup {
  sha256: string
  /** Deflated when a row is text; stored (images, PDF) otherwise. */
  compress: boolean
  rows: StoredFile[]
}

function json(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`)
}

function tooLargeWhileWriting(limits: string): Error {
  return payloadTooLarge(`The backup grew beyond ${limits} while it was written; export it without attachments (files=false).`, ZIP_MAX_OFFSET)
}

/** The backup zip of `plan`, built while it is read (see the module comment). */
export function createBackupStream(deps: AppDeps, plan: BackupPlan): ReadableStream<Uint8Array> {
  const { logger } = deps
  const mtime = new Date(Math.min(ZIP_MAX_TIME, Math.max(ZIP_MIN_TIME, plan.exportedAt)))
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  /** Closed, failed or cancelled: later zip output is dropped. */
  let finished = false
  let bytesOut = 0
  let chunksOut = 0
  let entriesIn = 0

  const zip = new Zip((error, chunk, final) => {
    if (finished || controller === undefined)
      return
    if (error !== null) {
      fail(error)
      return
    }
    bytesOut += chunk.byteLength
    chunksOut += 1
    controller.enqueue(chunk)
    if (final) {
      finished = true
      controller.close()
    }
  })

  function addEntry(name: string, compress: boolean): ZipDeflate | ZipPassThrough {
    if (entriesIn >= ZIP_MAX_ENTRIES)
      throw tooLargeWhileWriting(`${ZIP_MAX_ENTRIES.toLocaleString('en-US')} entries`)
    if (bytesOut > ZIP_MAX_OFFSET)
      throw tooLargeWhileWriting('4 GB')
    entriesIn += 1
    const entry = compress ? new ZipDeflate(name, { level: DEFLATE_LEVEL }) : new ZipPassThrough(name)
    entry.os = UNIX_HOST
    entry.attrs = FILE_ATTRIBUTES
    entry.mtime = mtime
    zip.add(entry)
    return entry
  }

  /** Writes `data` as one entry, 64 KB per step. */
  async function* writeBytes(name: string, data: Uint8Array, compress: boolean): AsyncGenerator<void, void, undefined> {
    const entry = addEntry(name, compress)
    if (data.byteLength === 0) {
      entry.push(new Uint8Array(0), true)
      yield
      return
    }
    for (let offset = 0; offset < data.byteLength; offset += PUSH_BYTES) {
      entry.push(data.subarray(offset, offset + PUSH_BYTES), offset + PUSH_BYTES >= data.byteLength)
      yield
    }
  }

  /** The JSON export of a chat and its messages; null when the chat was deleted since the pre-check. */
  async function chatExport(chatId: string): Promise<{ body: string, messages: unknown[] } | null> {
    let body: string
    try {
      body = (await deps.chats.export(chatId, 'json')).body
    }
    catch (error) {
      if (isHarnessError(error) && error.code === 'not_found')
        return null
      throw error
    }
    const list = (JSON.parse(body) as { chat?: { messages?: unknown } }).chat?.messages
    return { body, messages: Array.isArray(list) ? list : [] }
  }

  async function blobGroups(ids: readonly string[]): Promise<BlobGroup[]> {
    const order = new Map(ids.map((id, index) => [id, index]))
    const rows: StoredFile[] = []
    for (let index = 0; index < ids.length; index += ID_CHUNK) {
      const part = ids.slice(index, index + ID_CHUNK)
      rows.push(...await guardDb(() => deps.db.select().from(files).where(inArray(files.id, part))))
    }
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    const groups = new Map<string, BlobGroup>()
    for (const row of rows) {
      if (!SHA256_HEX_PATTERN.test(row.sha256))
        continue
      const group = groups.get(row.sha256) ?? { sha256: row.sha256, compress: false, rows: [] }
      group.rows.push(row)
      group.compress ||= row.mime.startsWith('text/')
      groups.set(row.sha256, group)
    }
    return [...groups.values()]
  }

  /**
   * Streams one blob as `files/<sha256>`, one file chunk per step. Returns its size, or null when it is missing or does
   * not match its sha256 (then its rows are left out of the index).
   */
  async function* writeBlob(group: BlobGroup): AsyncGenerator<void, number | null, undefined> {
    const first = group.rows[0]!
    let stream: ReadableStream<Uint8Array>
    try {
      stream = (await deps.files.open(first.id)).stream
    }
    catch (error) {
      if (isHarnessError(error) && error.code === 'not_found') {
        logger.warn('backup: an attachment is missing on disk and is left out', { fileId: first.id })
        return null
      }
      throw error
    }
    const reader = stream.getReader()
    const hash = createHash('sha256')
    let size = 0
    try {
      const entry = addEntry(`files/${group.sha256}`, group.compress)
      for (;;) {
        const { done, value } = await reader.read()
        if (done)
          break
        hash.update(value)
        size += value.byteLength
        entry.push(value)
        yield
      }
      entry.push(new Uint8Array(0), true)
    }
    finally {
      // Releases the file handle when the export stops in the middle of the blob.
      await reader.cancel().catch(() => {})
    }
    yield
    if (hash.digest('hex') !== group.sha256 || size > LIMITS.uploadBytes) {
      logger.warn('backup: an attachment no longer matches its sha256 and is left out of the index', { fileId: first.id })
      return null
    }
    return size
  }

  function indexItems(group: BlobGroup, size: number): BackupFileEntry[] {
    return group.rows.flatMap((row) => {
      const parsed = backupFileEntrySchema.safeParse({ id: row.id, sha256: row.sha256, name: row.name, mime: row.mime, size, createdAt: row.createdAt })
      if (parsed.success)
        return [parsed.data]
      logger.warn('backup: a file row is invalid and is left out of the index', { fileId: row.id })
      return []
    })
  }

  async function* steps(): AsyncGenerator<void, void, undefined> {
    const counts = { chats: 0, messages: 0 }
    const referenced = new Set<string>()
    if (plan.includeSettings)
      yield* writeBytes('settings.json', json(settingsSchema.parse(await deps.settings.get())), true)
    for (const chatId of plan.chatIds) {
      const exported = await chatExport(chatId)
      if (exported === null)
        continue
      counts.chats += 1
      counts.messages += exported.messages.length
      if (plan.includeFiles) {
        for (const id of referencedFileIds(exported.messages))
          referenced.add(id)
      }
      yield* writeBytes(`chats/${chatId}.json`, encoder.encode(exported.body), true)
    }
    const items: BackupFileEntry[] = []
    if (plan.includeFiles) {
      for (const group of await blobGroups([...referenced])) {
        const size = yield* writeBlob(group)
        if (size !== null)
          items.push(...indexItems(group, size))
      }
      items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      yield* writeBytes('files/index.json', json({ items }), true)
    }
    const manifest: BackupManifest = {
      format: 'harness-forge.backup',
      version: 1,
      exportedAt: plan.exportedAt,
      appVersion: plan.appVersion,
      chatExportVersion: 2,
      includes: { files: plan.includeFiles, settings: plan.includeSettings },
      counts: { chats: counts.chats, messages: counts.messages, files: items.length, fileBytes: items.reduce((total, item) => total + item.size, 0) },
    }
    yield* writeBytes('manifest.json', json(manifest), true)
    if (bytesOut > ZIP_MAX_OFFSET)
      throw tooLargeWhileWriting('4 GB')
    zip.end()
  }

  const iterator = steps()

  function fail(error: unknown): void {
    if (finished)
      return
    finished = true
    zip.terminate()
    logger.warn('backup export failed', { err: error })
    controller?.error(error)
    // Runs the pending `finally` blocks (open files) once the current step has settled.
    void iterator.return(undefined).catch(() => {})
  }

  return new ReadableStream<Uint8Array>({
    start: (streamController) => {
      controller = streamController
    },
    pull: async () => {
      const before = chunksOut
      // The zip callback enqueues (or ends the stream) while a step runs.
      const settled = (): boolean => finished || chunksOut !== before
      try {
        while (!settled()) {
          if ((await iterator.next()).done === true)
            break
        }
      }
      catch (error) {
        fail(error)
      }
    },
    cancel: async () => {
      finished = true
      zip.terminate()
      await iterator.return(undefined)
    },
  }, { highWaterMark: 0 })
}
