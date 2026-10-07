// Import of `POST /data/import` (ADR-024, API.md 4.16 / 5.19, ARCHITECTURE.md 6.9).
//
// The first bytes decide: `PK` = a backup zip, `{` (after an optional BOM and whitespace) = one chat JSON export
// (`ChatExportAny`, version 1 or 2). A backup is read lazily with the plugin installer's zip guards (`openZip`):
// names, links, duplicates, the entry count and the declared sizes are checked before anything is inflated, and every
// entry is inflated exactly and CRC-checked when it is read. The layout may sit inside a single top-level folder;
// unknown entries become warnings. A missing, invalid or newer manifest (or an invalid `files/index.json`) refuses the
// whole upload with `validation_error`; everything after that is per chat:
//
// - chats are imported one at a time, in entry name order, each atomically through `ChatsService.importChat`; a chat
//   that fails (damaged entry, too large, invalid JSON or tree) is reported as `failed` and the others go on;
// - `skip` leaves a chat whose id exists alone (so the same import twice changes nothing), `copy` imports it again
//   under new ids with " (imported)" appended to its title;
// - the attachments a chat references are imported before it: each blob is re-hashed against the index and its type
//   checked again (`FilesService.importFile`, deduplicated by content), and the `/api/files/<id>` URLs of its `file` /
//   `reasoning-file` parts are rewritten to the stored ids. An attachment that is not in the upload (or unusable) but
//   is stored here under the same id is reused; otherwise it counts as missing and its URL is left as it was;
// - with `restoreSettings`, the known keys of `settings.json` are applied, each validated on its own;
// - Phase 10 (ADR-044): with `restoreCustomizations`, the items of `customizations.json` (at most
//   `CUSTOMIZATION_ITEMS_MAX`, each checked against `backupCustomizationSchema` here) go to
//   `CustomizationService.restoreBackup`, which parses every content again with the shared `parseDefinition` like a
//   create and keeps an existing definition of the same kind and name (`skipped`); invalid items and items beyond the
//   per-kind limit are `failed` with a warning that names the kind and name, never the content. A definition can only
//   narrow a run (ADR-045), so nothing in the file grants a tool, a mode or a shell rule. Background tasks are never
//   part of a backup (a delivered result is a `data-task-result` part of its message and comes back with the chat).
// - Phase 11 (ADR-048 … ADR-052): `settings.json` carries `outputStyle` and `hooksEnabled` (restored like every public
//   setting); personal output styles (kind `style`) come back through `customizations.json`; a personal command whose
//   body holds `` !`cmd` `` spans is restored turned off (`enabled: false`, the customization store's rule), so a
//   backup cannot plant a shell line that runs on the next `/name`. Personal hooks, project approvals and project MCP
//   variables are never part of a backup, and nothing here writes them; `data-hook` parts come back with their chats.
// - Phase 12 (ADR-052 / ADR-055, W12.3-T6): `customizations.turnedOff` counts the restored commands with `!` spans that
//   the backup had turned on and that came back turned off (`CustomizationRestoreResult.turnedOff`). Marketplaces,
//   Claude Code plugins, hook transcripts and home-folder import plans are never part of a backup (./backup.ts), so
//   nothing here restores them.
import type {
  BackupCustomization,
  BackupFileEntry,
  BackupManifest,
  ChatExportAny,
  DataConflictPolicy,
  DataImportForm,
  DataImportItem,
  DataImportKind,
  DataImportResult,
  SettingsUpdate,
} from '@harness-forge/shared'
import type { OpenedZip, ZipEntry } from '../../plugins/install/zip.ts'
import type { AppDeps } from '../../types.ts'
import type { CustomizationRestoreResult } from '../customizations/types.ts'
import type { DataLimits } from './limits.ts'
import {
  backupCustomizationSchema,
  backupFileIndexSchema,
  backupManifestSchema,
  chatExportAnySchema,
  CUSTOMIZATION_KINDS,
  isHarnessError,
  LIMITS,
  SETTINGS_KEYS,
  settingsUpdateSchema,
  SHA256_HEX_PATTERN,
  validationError,
} from '@harness-forge/shared'
import { EntryCollector } from '../../plugins/install/archive.ts'
import { openZip } from '../../plugins/install/zip.ts'
import { TITLE_MAX_LENGTH, truncateCodePoints } from '../chats/text.ts'
import { formatBytes, payloadTooLarge } from './limits.ts'
import { referencedFileIds, rewriteFileUrls } from './parts.ts'

/** Caps of the small JSON entries of a backup (checked before they are inflated). */
const MANIFEST_MAX_BYTES = 1024 * 1024
const SETTINGS_MAX_BYTES = 1024 * 1024
const INDEX_MAX_BYTES = LIMITS.backupChatEntryBytes
/** `customizations.json`: at most 600 definitions of 64 KiB each, JSON-escaped (checked before it is inflated). */
const CUSTOMIZATIONS_MAX_BYTES = LIMITS.backupChatEntryBytes
/** Items of `customizations.json` read at most (`backupCustomizationsSchema`: every kind's limit). */
export const CUSTOMIZATION_ITEMS_MAX = CUSTOMIZATION_KINDS.length * LIMITS.customizationsPerKindMax
const CUSTOMIZATIONS_NAME = 'customizations.json'
/** Bytes read to decide between a zip and a chat JSON. */
const SNIFF_BYTES = 1024
const WARNINGS_MAX = 100
const WARNING_MAX_CHARS = 300
const ERROR_MAX_CHARS = 500
const SOURCE_ID_MAX_CHARS = 80
const COPY_SUFFIX = ' (imported)'
const MANIFEST_NAME = 'manifest.json'
const CHAT_ENTRY = /^chats\/[^/]+\.json$/
const BLOB_PREFIX = 'files/'
const SETTINGS_KEY_SET: ReadonlySet<string> = new Set(SETTINGS_KEYS)
/** Bytes allowed before the `{` of a chat JSON: space, tab, line feed, carriage return. */
const JSON_WHITESPACE: ReadonlySet<number> = new Set([0x20, 0x09, 0x0A, 0x0D])

const utf8 = new TextDecoder('utf-8', { fatal: true })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A `validation_error` about the upload (issue path `file`). */
function invalidUpload(message: string): Error {
  return validationError([{ path: ['file'], message, code: 'custom' }], message)
}

/** A name from the upload inside a message: JSON-quoted (control characters escaped), at most 80 characters. */
function quote(name: string): string {
  const chars = Array.from(name)
  return JSON.stringify(chars.length > 80 ? `${chars.slice(0, 80).join('')}...` : name)
}

function limitText(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 3).join('')}...`
}

/** `path: message` of the first issue of a failed zod parse. */
function firstIssue(error: { issues: readonly { path: readonly PropertyKey[], message: string }[] }): string {
  const issue = error.issues[0]
  if (issue === undefined)
    return 'invalid value.'
  const path = issue.path.filter(key => typeof key === 'string' || typeof key === 'number').join('.')
  return path === '' ? issue.message : `${path}: ${issue.message}`
}

/** The title of a copy: " (imported)" appended, within the title length limit. */
export function copyTitle(title: string | null): string | null {
  if (title === null)
    return null
  return `${truncateCodePoints(title, TITLE_MAX_LENGTH - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`
}

/**
 * A chat JSON export (version 1 or 2) from its bytes; `validation_error` for anything else (not UTF-8 JSON, another
 * format, a newer version, an invalid export).
 */
export function parseChatExport(bytes: Uint8Array): ChatExportAny {
  let value: unknown
  try {
    value = JSON.parse(utf8.decode(bytes))
  }
  catch {
    throw invalidUpload('The chat file is not valid UTF-8 JSON.')
  }
  if (!isRecord(value) || value.format !== 'harness-forge.chat')
    throw invalidUpload('The file is not a harness-forge chat export.')
  if (typeof value.version === 'number' && value.version > 2)
    throw invalidUpload(`The chat export was written by a newer version of harness-forge (format version ${value.version}); update harness-forge to import it.`)
  const parsed = chatExportAnySchema.safeParse(value)
  if (!parsed.success)
    throw validationError(parsed.error)
  return parsed.data
}

/** Where the attachments of an import come from: the index and blobs of a backup, or nothing (a chat JSON). */
interface AttachmentSource {
  /** The index item of a file id of the upload. */
  readonly item: (fileId: string) => BackupFileEntry | undefined
  /** The bytes of an index item's blob; null when the blob is not in the upload, `problem` when it cannot be used. */
  readonly blob: (item: BackupFileEntry) => Promise<{ data: Uint8Array } | { problem: string } | null>
}

const NO_ATTACHMENTS: AttachmentSource = {
  item: () => undefined,
  blob: async () => null,
}

type ChatStatus = DataImportItem['status']

/** The state of one import: counts, items, warnings and the attachments resolved so far. */
class ImportRun {
  readonly #deps: AppDeps
  readonly #policy: DataConflictPolicy
  readonly #source: AttachmentSource
  readonly #counts = { imported: 0, copied: 0, skipped: 0, failed: 0, filesImported: 0, filesReused: 0, filesMissing: 0 }
  readonly #items: DataImportItem[] = []
  readonly #warnings: string[] = []
  #hiddenWarnings = 0
  /** Source file id -> stored file id (null: missing), for every attachment resolved by this import. */
  readonly #files = new Map<string, string | null>()
  /** sha256 -> stored file id of the blobs this import stored or reused. */
  readonly #blobs = new Map<string, string>()
  /** Missing attachments that are not in the upload at all (reported in one warning). */
  #absent = 0
  settingsRestored = false
  /** Phase 10: what the restore of `customizations.json` did; undefined when it did not run. */
  customizations: DataImportResult['customizations'] = undefined

  constructor(deps: AppDeps, policy: DataConflictPolicy, source: AttachmentSource) {
    this.#deps = deps
    this.#policy = policy
    this.#source = source
  }

  warn(message: string): void {
    if (this.#warnings.length < WARNINGS_MAX - 1)
      this.#warnings.push(limitText(message, WARNING_MAX_CHARS))
    else
      this.#hiddenWarnings += 1
  }

  #add(item: DataImportItem): void {
    this.#items.push(item)
    this.#counts[item.status] += 1
  }

  #item(sourceId: string, chatId: string | null, title: string | null, status: ChatStatus): DataImportItem {
    return { sourceId: sourceId.slice(0, SOURCE_ID_MAX_CHARS), chatId, title, status }
  }

  /** Records a chat that could not be imported, with a message that is safe to show. */
  fail(sourceId: string, title: string | null, error: unknown): void {
    let message = 'The chat could not be imported because of a server error.'
    if (isHarnessError(error) && ['validation_error', 'payload_too_large', 'conflict', 'not_found'].includes(error.code))
      message = error.message
    else
      this.#deps.logger.warn('data import: a chat failed', { chatId: sourceId.slice(0, SOURCE_ID_MAX_CHARS), err: error })
    this.#add({ ...this.#item(sourceId, null, title, 'failed'), error: limitText(message, ERROR_MAX_CHARS) })
  }

  /**
   * Imports one chat export (see the module comment). A failure is recorded as a `failed` item, or thrown when
   * `strict` (a single chat JSON, where an invalid chat is an invalid upload).
   */
  async chat(exported: ChatExportAny, strict: boolean): Promise<void> {
    const sourceId = exported.chat.id
    const title = exported.chat.title
    try {
      const existing = await this.#deps.chats.find(sourceId)
      if (existing !== null && this.#policy === 'skip') {
        this.#add(this.#item(sourceId, sourceId, title, 'skipped'))
        return
      }
      await this.#attachments(exported)
      let copy = existing !== null
      let stored: string
      try {
        stored = await this.#store(exported, copy)
      }
      catch (error) {
        // The id was taken meanwhile (a chat created by another request).
        if (copy || !isHarnessError(error) || error.code !== 'conflict' || (error.details as { reason?: unknown } | undefined)?.reason !== 'exists')
          throw error
        if (this.#policy === 'skip') {
          this.#add(this.#item(sourceId, sourceId, title, 'skipped'))
          return
        }
        copy = true
        stored = await this.#store(exported, true)
      }
      this.#add(this.#item(sourceId, stored, exported.chat.title, copy ? 'copied' : 'imported'))
    }
    catch (error) {
      if (strict)
        throw error
      this.fail(sourceId, title, error)
    }
  }

  async #store(exported: ChatExportAny, copy: boolean): Promise<string> {
    if (copy)
      exported.chat.title = copyTitle(exported.chat.title)
    const result = await this.#deps.chats.importChat({ exported, id: copy ? 'new' : 'keep', restore: true })
    return result.id
  }

  /** Imports the attachments of a chat and points its file parts at the stored ids. */
  async #attachments(exported: ChatExportAny): Promise<void> {
    const stored = new Map<string, string>()
    for (const id of referencedFileIds(exported.chat.messages)) {
      const target = await this.#file(id)
      if (target !== null && target !== id)
        stored.set(id, target)
    }
    rewriteFileUrls(exported.chat.messages, stored)
  }

  async #file(sourceId: string): Promise<string | null> {
    if (this.#files.has(sourceId))
      return this.#files.get(sourceId) ?? null
    const stored = await this.#resolveFile(sourceId)
    this.#files.set(sourceId, stored)
    return stored
  }

  async #resolveFile(sourceId: string): Promise<string | null> {
    const { files } = this.#deps
    const item = this.#source.item(sourceId)
    /** Why the upload's copy could not be used; null when the upload has none. */
    let problem: string | null = null
    if (item !== undefined) {
      const same = this.#blobs.get(item.sha256)
      if (same !== undefined) {
        // The same content was stored by this import already: reuse it (the row with this id when it has it).
        const own = await files.get(item.id)
        this.#counts.filesReused += 1
        return own !== null && own.sha256 === item.sha256 ? own.id : same
      }
      const blob = await this.#source.blob(item)
      if (blob !== null && 'problem' in blob) {
        problem = blob.problem
      }
      else if (blob !== null) {
        try {
          const { file, reused } = await files.importFile({
            preferredId: item.id,
            sha256: item.sha256,
            name: item.name,
            mime: item.mime,
            data: blob.data,
            createdAt: item.createdAt,
          })
          this.#counts[reused ? 'filesReused' : 'filesImported'] += 1
          this.#blobs.set(item.sha256, file.id)
          return file.id
        }
        catch (error) {
          if (!isHarnessError(error) || (error.code !== 'validation_error' && error.code !== 'payload_too_large'))
            throw error
          problem = error.message
        }
      }
    }
    // Not usable from the upload: a file stored here under the same id (with the same content) still serves the part.
    const local = await files.get(sourceId)
    if (local !== null && (item === undefined || local.sha256 === item.sha256)) {
      this.#counts.filesReused += 1
      return local.id
    }
    this.#counts.filesMissing += 1
    if (problem === null)
      this.#absent += 1
    else
      this.warn(`The attachment ${quote(item?.name ?? sourceId)} was not imported: ${problem}`)
    return null
  }

  result(kind: DataImportKind, withoutFiles = false): DataImportResult {
    if (this.#absent > 0) {
      const count = this.#absent === 1 ? '1 attachment' : `${this.#absent} attachments`
      this.warn(withoutFiles
        ? `The backup was exported without attachments: ${count} of its chats ${this.#absent === 1 ? 'is' : 'are'} not stored on this server.`
        : `${count} referenced by the imported chats ${this.#absent === 1 ? 'is' : 'are'} neither in the upload nor stored on this server.`)
      this.#absent = 0
    }
    const warnings = [...this.#warnings]
    if (this.#hiddenWarnings > 0)
      warnings.push(this.#hiddenWarnings === 1 ? '1 more warning is not shown.' : `${this.#hiddenWarnings} more warnings are not shown.`)
    return {
      kind,
      counts: { ...this.#counts },
      settingsRestored: this.settingsRestored,
      ...(this.customizations === undefined ? {} : { customizations: { ...this.customizations } }),
      items: [...this.#items],
      warnings,
    }
  }
}

// ---------- backup zips ----------

/** The entries of a backup zip by role (paths relative to the backup root). */
interface BackupLayout {
  manifest: ZipEntry
  settings: ZipEntry | undefined
  index: ZipEntry | undefined
  /** Phase 10: `customizations.json`. */
  customizations: ZipEntry | undefined
  /** `chats/<name>.json` entries, sorted by name. */
  chats: Array<{ entry: ZipEntry, name: string }>
  /** `files/<sha256>` entries by sha256. */
  blobs: Map<string, ZipEntry>
  /** Paths of the files that are not part of the layout. */
  unknown: string[]
}

/** `''` when `manifest.json` is at the root, `<folder>/` when every entry sits in one top-level folder that has it. */
function backupRoot(entries: readonly ZipEntry[]): string {
  if (entries.some(entry => entry.type === 'file' && entry.path === MANIFEST_NAME))
    return ''
  const tops = new Set(entries.map(entry => entry.path.split('/')[0]))
  if (tops.size === 1) {
    const [top] = [...tops] as [string]
    const folderOnly = entries.every(entry => entry.path !== top || entry.type === 'dir')
    if (folderOnly && entries.some(entry => entry.type === 'file' && entry.path === `${top}/${MANIFEST_NAME}`))
      return `${top}/`
  }
  throw invalidUpload('The zip is not a harness-forge backup: manifest.json is missing (it must be at the root or inside a single top-level folder).')
}

function backupLayout(entries: readonly ZipEntry[]): BackupLayout {
  const prefix = backupRoot(entries)
  let manifest: ZipEntry | undefined
  const layout: Omit<BackupLayout, 'manifest'> = { settings: undefined, index: undefined, customizations: undefined, chats: [], blobs: new Map(), unknown: [] }
  for (const entry of entries) {
    if (entry.type !== 'file')
      continue
    const name = entry.path.slice(prefix.length)
    if (name === MANIFEST_NAME)
      manifest = entry
    else if (name === 'settings.json')
      layout.settings = entry
    else if (name === 'files/index.json')
      layout.index = entry
    else if (name === CUSTOMIZATIONS_NAME)
      layout.customizations = entry
    else if (CHAT_ENTRY.test(name))
      layout.chats.push({ entry, name })
    else if (name.startsWith(BLOB_PREFIX) && SHA256_HEX_PATTERN.test(name.slice(BLOB_PREFIX.length)))
      layout.blobs.set(name.slice(BLOB_PREFIX.length), entry)
    else
      layout.unknown.push(entry.path)
  }
  if (manifest === undefined)
    throw invalidUpload('The zip is not a harness-forge backup: manifest.json is missing.')
  layout.chats.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { manifest, ...layout }
}

/** A small JSON entry of the backup (manifest, index, settings); `validation_error` when it is too large or invalid. */
async function readJsonEntry(zip: OpenedZip, entry: ZipEntry, maxBytes: number, label: string): Promise<unknown> {
  if (entry.size > maxBytes)
    throw invalidUpload(`${label} is larger than ${formatBytes(maxBytes)}.`)
  const bytes = await zip.read(entry, { maxBytes })
  try {
    return JSON.parse(utf8.decode(bytes))
  }
  catch {
    throw invalidUpload(`${label} is not valid UTF-8 JSON.`)
  }
}

async function readManifest(zip: OpenedZip, entry: ZipEntry): Promise<BackupManifest> {
  const value = await readJsonEntry(zip, entry, MANIFEST_MAX_BYTES, MANIFEST_NAME)
  if (!isRecord(value) || value.format !== 'harness-forge.backup')
    throw invalidUpload('The zip is not a harness-forge backup: manifest.json has another format.')
  if (typeof value.version === 'number' && value.version > 1)
    throw invalidUpload(`The backup was written by a newer version of harness-forge (backup format ${value.version}); update harness-forge to import it.`)
  if (typeof value.chatExportVersion === 'number' && value.chatExportVersion > 2)
    throw invalidUpload(`The backup was written by a newer version of harness-forge (chat format ${value.chatExportVersion}); update harness-forge to import it.`)
  const parsed = backupManifestSchema.safeParse(value)
  if (!parsed.success)
    throw invalidUpload(`manifest.json is invalid: ${firstIssue(parsed.error)}`)
  return parsed.data
}

async function readIndex(zip: OpenedZip, entry: ZipEntry | undefined): Promise<BackupFileEntry[]> {
  if (entry === undefined)
    return []
  const parsed = backupFileIndexSchema.safeParse(await readJsonEntry(zip, entry, INDEX_MAX_BYTES, 'files/index.json'))
  if (!parsed.success)
    throw invalidUpload(`files/index.json is invalid: ${firstIssue(parsed.error)}`)
  return parsed.data.items
}

/** A chat entry of the backup, or the (safe) error that makes it fail. */
async function readChatEntry(zip: OpenedZip, entry: ZipEntry): Promise<ChatExportAny | Error> {
  const maxBytes = LIMITS.backupChatEntryBytes
  try {
    if (entry.size > maxBytes)
      return payloadTooLarge(`The chat is larger than ${formatBytes(maxBytes)} and cannot be imported.`, maxBytes)
    return parseChatExport(await zip.read(entry, { maxBytes }))
  }
  catch (error) {
    if (isHarnessError(error))
      return error
    throw error
  }
}

async function restoreSettings(deps: AppDeps, run: ImportRun, zip: OpenedZip, entry: ZipEntry | undefined): Promise<void> {
  if (entry === undefined) {
    run.warn('The backup has no settings.json, so no settings were restored.')
    return
  }
  let value: unknown
  try {
    value = await readJsonEntry(zip, entry, SETTINGS_MAX_BYTES, 'settings.json')
  }
  catch (error) {
    if (!isHarnessError(error))
      throw error
    run.warn(`No settings were restored: ${error.message}`)
    return
  }
  if (!isRecord(value)) {
    run.warn('No settings were restored: settings.json is not an object.')
    return
  }
  const patch: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!SETTINGS_KEY_SET.has(key)) {
      run.warn(`The unknown setting ${quote(key)} was ignored.`)
      continue
    }
    const parsed = settingsUpdateSchema.safeParse({ [key]: raw })
    if (!parsed.success) {
      run.warn(`The setting ${quote(key)} is invalid and was not restored.`)
      continue
    }
    Object.assign(patch, parsed.data)
  }
  if (Object.keys(patch).length === 0)
    return
  try {
    await deps.settings.update(patch as SettingsUpdate)
  }
  catch (error) {
    // The chats are imported already: report it instead of failing the whole import.
    if (!isHarnessError(error) || error.code !== 'validation_error')
      throw error
    run.warn(`No settings were restored: ${error.message}`)
    return
  }
  run.settingsRestored = true
}

/** `The personal agent "name"` of a `customizations.json` item, or `Item <n>` when it has no usable kind and name. */
function describeItem(raw: unknown, index: number): string {
  if (isRecord(raw) && typeof raw.name === 'string' && (CUSTOMIZATION_KINDS as readonly unknown[]).includes(raw.kind))
    return `The personal ${String(raw.kind)} ${quote(raw.name)}`
  return `Item ${index + 1}`
}

/** `restoreCustomizations`: the items of `customizations.json` through `CustomizationService.restoreBackup`. */
async function restoreCustomizations(deps: AppDeps, run: ImportRun, zip: OpenedZip, entry: ZipEntry | undefined, manifest: BackupManifest): Promise<void> {
  const none = 'no personal definitions were restored'
  if (entry === undefined) {
    if (manifest.includes.customizations !== true)
      run.warn(`The backup has no personal definitions (customizations.json), so ${none}.`)
    else if ((manifest.counts.customizations ?? 0) > 0)
      run.warn(`The backup lists personal definitions, but customizations.json is missing, so ${none}.`)
    return
  }
  let value: unknown
  try {
    value = await readJsonEntry(zip, entry, CUSTOMIZATIONS_MAX_BYTES, CUSTOMIZATIONS_NAME)
  }
  catch (error) {
    if (!isHarnessError(error))
      throw error
    run.warn(`No personal definitions were restored: ${error.message}`)
    return
  }
  const list = isRecord(value) && Array.isArray(value.items) ? value.items as unknown[] : null
  if (list === null) {
    run.warn(`No personal definitions were restored: ${CUSTOMIZATIONS_NAME} has no "items" list.`)
    return
  }
  const items: BackupCustomization[] = []
  let failed = 0
  for (const [index, raw] of list.slice(0, CUSTOMIZATION_ITEMS_MAX).entries()) {
    const parsed = backupCustomizationSchema.safeParse(raw)
    if (parsed.success) {
      items.push(parsed.data)
      continue
    }
    failed += 1
    run.warn(`${describeItem(raw, index)} in ${CUSTOMIZATIONS_NAME} is invalid and was not restored.`)
  }
  if (list.length > CUSTOMIZATION_ITEMS_MAX) {
    failed += list.length - CUSTOMIZATION_ITEMS_MAX
    run.warn(`${CUSTOMIZATIONS_NAME} holds ${list.length} items; only the first ${CUSTOMIZATION_ITEMS_MAX} were read.`)
  }
  let restored: CustomizationRestoreResult
  try {
    restored = await deps.customizations.restoreBackup(items)
  }
  catch (error) {
    // The chats are imported already: report it instead of failing the whole import.
    if (isHarnessError(error)) {
      run.warn(`No personal definitions were restored: ${error.message}`)
    }
    else {
      deps.logger.warn('data import: the personal definitions could not be restored', { err: error })
      run.warn('No personal definitions were restored because of a server error.')
    }
    return
  }
  for (const warning of restored.warnings)
    run.warn(warning)
  // Phase 12 (ADR-052 / W12.3-T6): commands with `!` spans that came back turned off although the backup had them on.
  run.customizations = { imported: restored.imported, skipped: restored.skipped, failed: restored.failed + failed, turnedOff: restored.turnedOff }
}

async function importBackup(deps: AppDeps, upload: Blob, form: DataImportForm, limits: DataLimits): Promise<DataImportResult> {
  // The collector's expanded-size check speaks of plugins: the total is checked below with a backup message instead.
  const zip = await openZip(upload, new EntryCollector({ entries: limits.backupEntries, expandedBytes: Number.MAX_SAFE_INTEGER }, ['file']))
  const declared = zip.entries.reduce((total, entry) => total + entry.size, 0)
  if (declared > limits.expandedBytes)
    throw payloadTooLarge(`The backup expands to more than ${formatBytes(limits.expandedBytes)}.`, limits.expandedBytes)
  const layout = backupLayout(zip.entries)
  const manifest = await readManifest(zip, layout.manifest)
  const index = new Map((await readIndex(zip, layout.index)).map(item => [item.id, item]))

  const source: AttachmentSource = {
    item: fileId => index.get(fileId),
    blob: async (item) => {
      const entry = layout.blobs.get(item.sha256)
      if (entry === undefined)
        return null
      if (entry.size > LIMITS.uploadBytes)
        return { problem: `it is larger than ${formatBytes(LIMITS.uploadBytes)}.` }
      try {
        return { data: await zip.read(entry, { maxBytes: LIMITS.uploadBytes }) }
      }
      catch (error) {
        if (isHarnessError(error) && (error.code === 'validation_error' || error.code === 'payload_too_large'))
          return { problem: error.message }
        throw error
      }
    },
  }
  const run = new ImportRun(deps, form.onConflict ?? 'skip', source)
  for (const path of layout.unknown)
    run.warn(`The unknown entry ${quote(path)} was ignored.`)
  if (manifest.counts.chats !== layout.chats.length)
    run.warn(`The manifest lists ${manifest.counts.chats} chats, but the backup contains ${layout.chats.length}.`)

  for (const { entry, name } of layout.chats) {
    const exported = await readChatEntry(zip, entry)
    if (exported instanceof Error)
      run.fail(name.slice('chats/'.length, -'.json'.length), null, exported)
    else
      await run.chat(exported, false)
  }
  if (form.restoreSettings === true)
    await restoreSettings(deps, run, zip, layout.settings)
  if (form.restoreCustomizations === true)
    await restoreCustomizations(deps, run, zip, layout.customizations, manifest)
  return run.result('backup', !manifest.includes.files)
}

// ---------- entry point ----------

/** What the first bytes of an upload look like: a zip, a JSON object, or neither. */
async function sniff(upload: Blob): Promise<DataImportKind | null> {
  const head = new Uint8Array(await upload.slice(0, SNIFF_BYTES).arrayBuffer())
  if (head[0] === 0x50 && head[1] === 0x4B)
    return 'backup'
  let index = head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF ? 3 : 0
  while (index < head.length && JSON_WHITESPACE.has(head[index]!))
    index += 1
  return head[index] === 0x7B ? 'chat' : null
}

/**
 * `DataService.importData` without the mutex: the upload (at most `LIMITS.backupImportBytes`) is a backup zip or a
 * single chat JSON (see the module comment). Emits `chat.created` per imported chat (through `ChatsService`).
 */
export async function importUpload(deps: AppDeps, upload: Blob, form: DataImportForm, limits: DataLimits): Promise<DataImportResult> {
  if (upload.size > LIMITS.backupImportBytes)
    throw payloadTooLarge(`Imports are limited to ${formatBytes(LIMITS.backupImportBytes)}.`, LIMITS.backupImportBytes)
  const kind = await sniff(upload)
  let result: DataImportResult
  if (kind === 'backup') {
    result = await importBackup(deps, upload, form, limits)
  }
  else if (kind === 'chat') {
    if (upload.size > LIMITS.backupChatEntryBytes)
      throw payloadTooLarge(`A chat export is limited to ${formatBytes(LIMITS.backupChatEntryBytes)}.`, LIMITS.backupChatEntryBytes)
    const exported = parseChatExport(new Uint8Array(await upload.arrayBuffer()))
    const run = new ImportRun(deps, form.onConflict ?? 'skip', NO_ATTACHMENTS)
    await run.chat(exported, true)
    if (form.restoreSettings === true)
      run.warn('Settings are restored only from a backup zip.')
    if (form.restoreCustomizations === true)
      run.warn('Personal definitions are restored only from a backup zip.')
    result = run.result('chat')
  }
  else {
    throw invalidUpload('Upload a backup zip or a chat JSON export.')
  }
  deps.logger.info('data import finished', {
    kind: result.kind,
    ...result.counts,
    ...(result.customizations === undefined ? {} : { customizations: result.customizations }),
    warnings: result.warnings.length,
  })
  return result
}
