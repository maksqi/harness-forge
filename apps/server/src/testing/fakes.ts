// In-memory fakes of the cross-agent services, so each agent can test against the frozen interfaces while the real
// implementations land in parallel: `createTestApp({ overrides: { events: createRecordingEventBus() } })`.
//
// Phase 5 (C8-T6): `createFakeChatRunner` (runs with a phase per chat, `hasRun`), `createFakeDataService` and
// `createFakeShareService` (in memory, for route tests), `createFakeFilesService` (the real files service plus
// `importFile` / `purge` on the test database) and `createFakeChatsService` (./fake-chats.ts: the real chats service plus
// the message tree and bulk data members). The last two are factories: `createTestApp({ factories: { chats:
// createFakeChatsService, files: createFakeFilesService } })`.
//
// Phase 6 (C11-T5): `createFakeFilesService` also has `saveGenerated`, `createFakeChatsService` has `deleteMessage`, and
// ./fake-media.ts adds `createFakeImageService` (a factory) and `createFakeAudioService`. The fake media resolvers and
// the fake plugin host's `ctx.images` live in `providers/testing.ts` (`withFakeMediaResolvers`, `fakeMediaProviders`).
//
// Phase 7 (C14-T6): ./fake-projects.ts adds `createFakeProjectService` (projects in memory, `openWorkspace` on a temp
// folder); `createRecordingEventBus` has `disconnectAll`; `createFakeDataService` has `cleanupPreview` / `cleanup` and
// answers `busy` with the maintenance lock's error; `createFakeKeyring` is C16's rotatable fake (./fake-keyring.ts).
//
// Phase 8 (C19-T9): ./fake-checkpoints.ts adds `createFakeCheckpointService` (a recording service), the in-memory
// `createFakeCheckpointBlobStore`, `createTestChangeRowWriter` and `insertChangeRows` (journal rows in the test
// database); ./fake-shell-rules.ts adds `createFakeShellRuleService`; `createFakeDataService` has no-op `start` / `stop`
// (it counts the calls). `createTestApp({ checkpoints: 'fake', shellRules: 'fake' })` installs the two fake services.
import type { Disposable } from '@harness-forge/plugin-sdk'
import type {
  DataCleanupPreview,
  DataCleanupResult,
  DataDeleteResult,
  DataImportResult,
  DataSummary,
  IconRef,
  LobeIconList,
  ServerEvent,
  Settings,
  SettingsUpdate,
  ShareCreate,
  SharePart,
  ShareSnapshot,
  ShareSummary,
  ShareView,
} from '@harness-forge/shared'
import type { ActiveRun, ChatRunner } from '../chat/types.ts'
import type { IconService } from '../providers/types.ts'
import type { DataService } from '../services/data/types.ts'
import type { EventBus, EventSubscribeOptions, ServerEventListener } from '../services/events/types.ts'
import type { FileImportInput, FileImportResult, FilePurgeResult, FilesService, GeneratedFileInput, StoredFile } from '../services/files/types.ts'
import type { SecretEntry, SecretScope, SecretStore } from '../services/secrets/types.ts'
import type { InternalSettingKey, SettingsService } from '../services/settings/types.ts'
import type { ShareFile, ShareService } from '../services/shares/types.ts'
import type { AppDeps } from '../types.ts'
import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import {
  createServerEvent,
  createShareId,
  DEFAULT_SETTINGS,
  FILE_ID_PATTERN,
  GENERATED_IMAGE_MIME_TYPES,
  HarnessError,
  LIMITS,
  settingsSchema,
  settingsUpdateSchema,
  shareOptionsSchema,
  validationError,
} from '@harness-forge/shared'
import { asc, eq } from 'drizzle-orm'
import { files } from '../db/schema.ts'
import { rejectsNotImplemented } from '../not-implemented.ts'
import { createFilesService } from '../services/files/index.ts'
import { sniffBinaryType } from '../services/files/sniff.ts'
import { busyError } from '../services/maintenance/index.ts'
import { secretHint } from '../services/secrets/hint'

export { createFakeChatsService } from './fake-chats.ts'
export {
  createFakeCheckpointBlobStore,
  createFakeCheckpointService,
  createTestChangeRowWriter,
  editRowFields,
  FAKE_RESTORE_RESULT,
  insertChangeRows,
} from './fake-checkpoints.ts'
export type { FakeCheckpointBlobStore, FakeCheckpointService, FakeJournalRecord, TestChangeRowInput } from './fake-checkpoints.ts'
/** Deterministic, rotatable keyring (C16, ./fake-keyring.ts): the same subkey bytes as the Phase 1 – 6 fake. */
export { createFakeKeyring, FAKE_KEYRING_SEED, fakeMasterKey } from './fake-keyring.ts'
export { createFakeAudioService, createFakeImageService, NO_IMAGE_MODEL_MESSAGE } from './fake-media.ts'
export type { FakeAudioCall, FakeAudioService, FakeAudioServiceOptions, FakeImageService, FakeImageServiceOptions } from './fake-media.ts'
export { createFakeShellRuleService } from './fake-shell-rules.ts'
export type { FakeShellRuleService, FakeShellRuleServiceOptions } from './fake-shell-rules.ts'

export interface RecordingEventBus extends EventBus {
  /** Every event emitted so far. */
  readonly events: ServerEvent[]
  /** Events of one type. */
  readonly ofType: <T extends ServerEvent['type']>(type: T) => Extract<ServerEvent, { type: T }>[]
  readonly clear: () => void
  /** Calls of `disconnectAll()` so far (Phase 7). */
  readonly disconnects: () => number
}

/**
 * A working in-memory event bus that also records every event. Delivery is synchronous, so `disconnectAll()` (Phase 7)
 * has nothing queued: it removes every subscription with `onDisconnect` or `onClose` and notifies it (`onDisconnect`,
 * else `onClose`), keeps the others, and resolves once every `onDisconnect` settled.
 */
export function createRecordingEventBus(): RecordingEventBus {
  const events: ServerEvent[] = []
  const subscribers = new Map<ServerEventListener, EventSubscribeOptions>()
  let stopped = false
  let disconnects = 0

  function publish(event: ServerEvent): void {
    if (stopped)
      return
    events.push(event)
    for (const listener of [...subscribers.keys()]) {
      try {
        listener(event)
      }
      catch {
        // A throwing listener never breaks the producer.
      }
    }
  }

  return {
    events,
    ofType: type => events.filter(event => event.type === type) as never,
    clear: () => {
      events.length = 0
    },
    emit: (type, data) => publish(createServerEvent(type, data)),
    publish,
    subscribe: (listener, options = {}): Disposable => {
      subscribers.set(listener, options)
      return { dispose: () => void subscribers.delete(listener) }
    },
    subscriberCount: () => subscribers.size,
    stop: async () => {
      stopped = true
      for (const options of subscribers.values())
        options.onClose?.()
      subscribers.clear()
    },
    disconnects: () => disconnects,
    disconnectAll: async () => {
      disconnects += 1
      const pending: Promise<void>[] = []
      for (const [listener, options] of [...subscribers]) {
        if (options.onDisconnect === undefined && options.onClose === undefined)
          continue
        subscribers.delete(listener)
        if (options.onDisconnect === undefined) {
          options.onClose?.()
          continue
        }
        pending.push(Promise.resolve().then(() => options.onDisconnect?.()).catch(() => {}))
      }
      await Promise.all(pending)
    },
  }
}

/** Hint of the fakes: the real rule of `services/secrets/hint.ts`, so fakes and the service agree. */
export function fakeSecretHint(value: string): string | null {
  return secretHint(value)
}

/** Plaintext in-memory secret store (tests only). */
export function createMemorySecretStore(): SecretStore {
  const rows = new Map<string, { scope: SecretScope, name: string, value: string, updatedAt: number }>()
  const keyOf = (scope: SecretScope, name: string): string => `${scope}\u0000${name}`
  return {
    get: async (scope, name) => rows.get(keyOf(scope, name))?.value ?? null,
    set: async (scope, name, value) => {
      rows.set(keyOf(scope, name), { scope, name, value, updatedAt: Date.now() })
    },
    delete: async (scope, name) => rows.delete(keyOf(scope, name)),
    deleteScope: async (scope) => {
      let count = 0
      for (const [key, row] of rows) {
        if (row.scope === scope) {
          rows.delete(key)
          count += 1
        }
      }
      return count
    },
    list: async (scope) => {
      const entries: SecretEntry[] = []
      for (const row of rows.values()) {
        if (row.scope === scope)
          entries.push({ scope, name: row.name, hint: fakeSecretHint(row.value), keyVersion: 1, updatedAt: row.updatedAt })
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name))
    },
  }
}

/** In-memory settings validated with the shared schemas. */
export function createMemorySettingsService(initial: Partial<Settings> = {}): SettingsService {
  let current: Settings = settingsSchema.parse({ ...DEFAULT_SETTINGS, ...initial })
  const internal = new Map<InternalSettingKey, unknown>()
  return {
    get: async () => ({ ...current }),
    update: async (patch: SettingsUpdate) => {
      const parsed = settingsUpdateSchema.safeParse(patch)
      if (!parsed.success)
        throw validationError(parsed.error)
      current = settingsSchema.parse({ ...current, ...parsed.data })
      return { ...current }
    },
    getInternal: async <T>(key: InternalSettingKey) => internal.get(key) as T | undefined,
    setInternal: async (key, value) => {
      if (value === undefined)
        internal.delete(key)
      else
        internal.set(key, value)
    },
  }
}

/**
 * Icon service that knows every mono slug and no color variant: `lobeRef('lobe:<slug>')` ->
 * `{ mono: '/api/icons/lobe/<slug>?v=test' }`; a `{ color, mono }` pair maps each `lobe:` slug as given.
 */
export function createFakeIconService(): IconService {
  const list: LobeIconList = { items: [], version: 'test' }
  const url = (slug: string): string => `/api/icons/lobe/${slug}?v=test`
  const slugOf = (spec: string | undefined): string | null => spec?.startsWith('lobe:') ? spec.slice('lobe:'.length) : null
  return {
    version: 'test',
    list: async () => list,
    read: async slug => `<svg xmlns="http://www.w3.org/2000/svg" data-slug="${slug}"></svg>`,
    lobeRef: (icon): IconRef => {
      if (typeof icon === 'string') {
        const slug = slugOf(icon)
        return slug === null ? null : { mono: url(slug.replace(/-color$/, '')) }
      }
      const color = slugOf(icon.color)
      const mono = slugOf(icon.mono)
      if (color === null && mono === null)
        return null
      return { ...(color === null ? {} : { color: url(color) }), ...(mono === null ? {} : { mono: url(mono) }) }
    },
  }
}

// ---------- Phase 5 (C8-T6) ----------

/** Phase of a run in `createFakeChatRunner` (the phases of the real runs registry, `chat/runs.ts`). */
export type FakeRunPhase = 'preparing' | 'streaming' | 'finishing'

export interface FakeChatRunner extends ChatRunner {
  /** The chats that hold a run, with its phase: tests add and remove entries directly. */
  readonly phases: Map<string, FakeRunPhase>
  /** Chat ids passed to `stop`, in call order. */
  readonly stopped: string[]
}

/**
 * A `ChatRunner` without a pipeline: `hasRun` = the chat has an entry in `phases` (any phase), `isActive` / `active` =
 * `streaming` entries, `stop` records the id, removes the entry and answers like the real runner (true unless the run
 * was missing or `finishing`). `start` answers `not_implemented`; `overrides` replace any member.
 */
export function createFakeChatRunner(overrides: Partial<ChatRunner> = {}): FakeChatRunner {
  const phases = new Map<string, FakeRunPhase>()
  const stopped: string[] = []
  const stop = async (chatId: string): Promise<boolean> => {
    stopped.push(chatId)
    const phase = phases.get(chatId)
    phases.delete(chatId)
    return phase !== undefined && phase !== 'finishing'
  }
  return {
    phases,
    stopped,
    start: rejectsNotImplemented('fake runs.start'),
    resume: () => null,
    stop,
    isActive: chatId => phases.get(chatId) === 'streaming',
    hasRun: chatId => phases.has(chatId),
    active: () => [...phases].flatMap(([chatId, phase]): ActiveRun[] => phase === 'streaming'
      ? [{ runId: `run_fake_${chatId}`, chatId, messageId: 'msg_fakerun000000000', modelRef: 'mock:echo', startedAt: 0 }]
      : []),
    stopAll: async () => {
      for (const chatId of [...phases.keys()])
        await stop(chatId)
    },
    ...overrides,
  }
}

/** The grace period of the orphaned file cleanup in the fake data service (ADR-035: 24 h). */
export const FAKE_CLEANUP_GRACE_MS = 86_400_000

/** An empty zip: only the end-of-central-directory record (22 bytes). */
export const EMPTY_ZIP: Uint8Array = Uint8Array.from([0x50, 0x4B, 0x05, 0x06, ...Array.from({ length: 18 }).fill(0)])

export interface FakeDataServiceOptions {
  /** Answer of `summary` (default: zeros). */
  summary?: DataSummary
  /** Bytes of every exported backup (default: `EMPTY_ZIP`). */
  backup?: Uint8Array
  /** Answer of `importData` (default: nothing imported, `kind` from the first bytes of the upload). */
  importResult?: DataImportResult
  /** Answer of `deleteAll` (default: zeros). */
  deleteResult?: DataDeleteResult
  /** Answer of `cleanupPreview` (Phase 7; default: nothing to remove, grace 24 h, never run). */
  cleanupPreview?: DataCleanupPreview
  /** Answer of `cleanup` (Phase 7; default: nothing removed, `ranAt` from `now`). */
  cleanupResult?: DataCleanupResult
  /** Clock of `exportedAt` (default `Date.now`). */
  now?: () => number
}

export interface FakeDataService extends DataService {
  /** Every call in order: the member and its arguments. */
  readonly calls: Array<{ member: keyof DataService, args: unknown[] }>
  /**
   * While true, `importData`, `deleteAll`, `cleanupPreview` and `cleanup` fail with `conflict` (`reason: 'busy'`), like
   * the maintenance lock.
   */
  busy: boolean
  /** Backup streams read to the end, and cancelled (a `HEAD` request or a client that went away). */
  readonly exports: { completed: number, cancelled: number }
  /** Calls of the no-op `start()` / `stop()` (Phase 8). */
  readonly lifecycle: { started: number, stopped: number }
}

/**
 * A canned `DataService` for route tests: answers from `options`, records calls, checks what the routes rely on
 * (`payload_too_large` above `LIMITS.backupImportBytes`, `validation_error` for an upload that is neither a zip nor a
 * JSON object, `confirm: 'DELETE'`, `requireFreshAuth()` when given) and returns lazily pulled backup streams.
 */
export function createFakeDataService(options: FakeDataServiceOptions = {}): FakeDataService {
  const now = options.now ?? Date.now
  // P8-A (W8.7): the automatic sweep (ADR-039) is off in the fake.
  const fileSweep = { mode: 'off', lastAttempt: null, nextRunAt: null } as const
  const counts = { chats: 0, archivedChats: 0, messages: 0, files: 0, fileBytes: 0, fileSweep }
  const fake: FakeDataService = {
    calls: [],
    busy: false,
    exports: { completed: 0, cancelled: 0 },
    lifecycle: { started: 0, stopped: 0 },
    summary: async () => {
      fake.calls.push({ member: 'summary', args: [] })
      return options.summary ?? { ...counts }
    },
    exportBackup: async (query) => {
      fake.calls.push({ member: 'exportBackup', args: [query] })
      const exportedAt = now()
      const bytes = options.backup ?? EMPTY_ZIP
      let sent = false
      const stream = new ReadableStream<Uint8Array>({
        pull: (controller) => {
          if (sent) {
            fake.exports.completed += 1
            controller.close()
            return
          }
          sent = true
          controller.enqueue(new Uint8Array(bytes))
        },
        cancel: () => {
          fake.exports.cancelled += 1
        },
      })
      return { filename: `harness-forge-backup-${new Date(exportedAt).toISOString().slice(0, 10)}.zip`, exportedAt, stream }
    },
    importData: async (upload, form = {}) => {
      fake.calls.push({ member: 'importData', args: [upload, form] })
      if (fake.busy)
        throw busyError()
      if (upload.size > LIMITS.backupImportBytes)
        throw new HarnessError({ code: 'payload_too_large', message: 'The upload is too large.', details: { limitBytes: LIMITS.backupImportBytes } })
      const head = new Uint8Array(await upload.slice(0, 2).arrayBuffer())
      const kind = head[0] === 0x50 && head[1] === 0x4B ? 'backup' : head[0] === 0x7B ? 'chat' : null
      if (kind === null)
        throw validationError([{ path: ['file'], message: 'Expected a backup zip or a chat JSON export.', code: 'custom' }])
      return options.importResult ?? {
        kind,
        counts: { imported: 0, copied: 0, skipped: 0, failed: 0, filesImported: 0, filesReused: 0, filesMissing: 0 },
        settingsRestored: false,
        items: [],
        warnings: [],
      }
    },
    deleteAll: async (body, sensitive) => {
      fake.calls.push({ member: 'deleteAll', args: [body, sensitive] })
      if (fake.busy)
        throw busyError()
      sensitive?.requireFreshAuth()
      if (body.confirm !== 'DELETE')
        throw validationError([{ path: ['confirm'], message: 'Type DELETE to confirm.', code: 'custom' }])
      return options.deleteResult ?? { chats: 0, messages: 0, files: 0, fileBytes: 0, usageRows: 0 }
    },
    cleanupPreview: async () => {
      fake.calls.push({ member: 'cleanupPreview', args: [] })
      if (fake.busy)
        throw busyError()
      return options.cleanupPreview ?? { files: 0, fileBytes: 0, blobs: 0, diskBytes: 0, tempFiles: 0, recentFiles: 0, graceMs: FAKE_CLEANUP_GRACE_MS, lastRunAt: null, fileSweep, pluginData: 'complete' }
    },
    cleanup: async () => {
      fake.calls.push({ member: 'cleanup', args: [] })
      if (fake.busy)
        throw busyError()
      return options.cleanupResult ?? { files: 0, fileBytes: 0, blobs: 0, diskBytes: 0, tempFiles: 0, ranAt: now(), pluginData: 'complete' }
    },
    // Phase 8: the automatic file sweep never runs in the fake; the lifecycle calls are counted, not recorded in `calls`.
    start: async () => {
      fake.lifecycle.started += 1
    },
    stop: async () => {
      fake.lifecycle.stopped += 1
    },
  }
  return fake
}

/** A share of `createFakeShareService`. */
export interface FakeShare {
  summary: ShareSummary
  /** The token of `summary.path` (`/share/<token>`). */
  token: string
  /** The stored snapshot (file URLs `/api/files/<id>`); `view` applies the options and rewrites the URLs. */
  snapshot: ShareSnapshot
  /** The files `openFile` serves, by file id. */
  files: Map<string, { file: StoredFile, data: Uint8Array }>
}

export interface FakeShareServiceOptions {
  /** Snapshot of a new or refreshed share (default: the title and no messages). */
  snapshot?: (chatId: string, title: string | null) => ShareSnapshot
  /** Clock of `createdAt`, `snapshotAt` and expiry (default `Date.now`). */
  now?: () => number
}

export interface FakeShareService extends ShareService {
  /** Every share by id; tests may add, edit or delete entries. */
  readonly shares: Map<string, FakeShare>
}

/** A token of the real format for `shareId` (the id suffix + 22 base64url characters of a hash; not the real HMAC). */
export function fakeShareToken(shareId: string): string {
  return `${shareId.slice('shr_'.length)}${createHash('sha256').update(shareId).digest('base64url').slice(0, 22)}`
}

const SHARE_FILE_URL = /^\/api\/files\/(file_[\dA-Za-z]{16})$/

/**
 * An in-memory `ShareService` for route tests. Follows the contract where the routes can see it: defaults of the
 * options, the expiry rule, `LIMITS.sharesPerChatMax`, newest-first lists, a stable token, the same `not_found` for
 * every unavailable link, options applied by `view` (reasoning, tool details, attachments) with file URLs rewritten to
 * `/api/share/<token>/files/<id>`, and `openFile` limited to the share's files. No sanitizer, no chats: snapshots come
 * from `options.snapshot` or the test.
 */
export function createFakeShareService(options: FakeShareServiceOptions = {}): FakeShareService {
  const now = options.now ?? Date.now
  const shares = new Map<string, FakeShare>()
  const unavailable = (): HarnessError => new HarnessError({ code: 'not_found', message: 'This share link is unavailable.' })
  const unknownShare = (id: string): HarnessError => new HarnessError({ code: 'not_found', message: `Share ${id} not found.` })
  const snapshotOf = (chatId: string, title: string | null): ShareSnapshot => options.snapshot?.(chatId, title) ?? { title, messages: [] }

  function checkExpiry(expiresAt: number | null | undefined): void {
    if (expiresAt !== undefined && expiresAt !== null && (expiresAt <= now() || expiresAt > now() + 365 * 86_400_000))
      throw validationError([{ path: ['expiresAt'], message: 'Expected a time in the future, at most 365 days ahead.', code: 'custom' }])
  }

  function current(share: FakeShare): ShareSummary {
    const { expiresAt } = share.summary
    return { ...share.summary, expired: expiresAt !== null && expiresAt <= now() }
  }

  function byToken(token: string): FakeShare {
    const share = [...shares.values()].find(entry => entry.token === token)
    if (share === undefined || current(share).expired)
      throw unavailable()
    return share
  }

  function visiblePart(part: SharePart, share: FakeShare, token: string): SharePart[] {
    const { options: shown } = share.summary
    if (part.type === 'reasoning')
      return shown.reasoning ? [part] : []
    if (part.type === 'file') {
      if (!shown.attachments)
        return []
      const id = SHARE_FILE_URL.exec(part.url)?.[1]
      return [id === undefined ? part : { ...part, url: `/api/share/${token}/files/${id}` }]
    }
    if (part.type === 'tool' && !shown.toolDetails)
      return [{ type: 'tool', toolName: part.toolName, status: part.status }]
    return [part]
  }

  return {
    shares,
    list: async query => [...shares.values()]
      .filter(share => query.chatId === undefined || share.summary.chatId === query.chatId)
      .map(current)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
    create: async (input: ShareCreate) => {
      checkExpiry(input.expiresAt)
      if ([...shares.values()].filter(share => share.summary.chatId === input.chatId).length >= LIMITS.sharesPerChatMax)
        throw validationError([{ path: ['chatId'], message: `A chat has at most ${LIMITS.sharesPerChatMax} share links.`, code: 'custom' }])
      const id = createShareId()
      const token = fakeShareToken(id)
      const at = now()
      const snapshot = snapshotOf(input.chatId, input.title ?? null)
      const summary: ShareSummary = {
        id,
        chatId: input.chatId,
        chatTitle: null,
        title: input.title ?? null,
        options: shareOptionsSchema.parse(input.options ?? {}),
        path: `/share/${token}`,
        messageCount: snapshot.messages.length,
        snapshotAt: at,
        outdated: false,
        expiresAt: input.expiresAt ?? null,
        expired: false,
        createdAt: at,
      }
      shares.set(id, { summary, token, snapshot, files: new Map() })
      return current(shares.get(id)!)
    },
    update: async (id, patch) => {
      const share = shares.get(id)
      if (share === undefined)
        throw unknownShare(id)
      checkExpiry(patch.expiresAt)
      const summary = { ...share.summary }
      if (patch.title !== undefined)
        summary.title = patch.title
      if (patch.options !== undefined)
        summary.options = { ...summary.options, ...patch.options }
      if (patch.expiresAt !== undefined)
        summary.expiresAt = patch.expiresAt
      if (patch.refresh === true) {
        share.snapshot = snapshotOf(summary.chatId, summary.title)
        summary.messageCount = share.snapshot.messages.length
        summary.snapshotAt = now()
        summary.outdated = false
      }
      share.summary = summary
      return current(share)
    },
    remove: async (id) => {
      if (!shares.delete(id))
        throw unknownShare(id)
    },
    view: async (token): Promise<ShareView> => {
      const share = byToken(token)
      return {
        title: share.snapshot.title,
        messages: share.snapshot.messages.map(message => ({
          ...message,
          parts: message.parts.flatMap(part => visiblePart(part, share, token)),
        })),
        snapshotAt: share.summary.snapshotAt,
        options: { ...share.summary.options },
      }
    },
    openFile: async (token, fileId): Promise<ShareFile> => {
      const share = byToken(token)
      const entry = share.summary.options.attachments ? share.files.get(fileId) : undefined
      if (entry === undefined)
        throw unavailable()
      const data = new Uint8Array(entry.data)
      return {
        file: { ...entry.file },
        stream: new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(data)
            controller.close()
          },
        }),
      }
    },
  }
}

/**
 * The real `FilesService` with simple versions of the Phase 5 members, for the data service tests while W5.3
 * implements them: `importFile` checks the sha256, reuses a row with the same content (the one with `preferredId`
 * first), else stores the bytes through `upload` (same type checks) and moves the row to `preferredId` when that id is
 * free; `purge` deletes every row and the blob directory. Phase 6: `saveGenerated` (while W6.4 implements it) accepts
 * only `GENERATED_IMAGE_MIME_TYPES` (`validation_error`), at most `LIMITS.generatedImageBytes` (`payload_too_large`),
 * with matching magic bytes (`validation_error`), returns an existing row with the same sha256, else stores the bytes
 * through `upload`. Use as a factory: `factories: { files: createFakeFilesService }`.
 */
export function createFakeFilesService(deps: AppDeps): FilesService {
  const base = createFilesService(deps)
  const { db } = deps

  async function importFile(input: FileImportInput): Promise<FileImportResult> {
    const sha256 = createHash('sha256').update(input.data).digest('hex')
    if (sha256 !== input.sha256)
      throw validationError([{ path: ['sha256'], message: 'The bytes do not match the declared sha256.', code: 'custom' }])
    const same = await db.select().from(files).where(eq(files.sha256, sha256))
    const reuse = same.find(row => row.id === input.preferredId) ?? same[0]
    if (reuse !== undefined)
      return { file: reuse, reused: true }
    const uploaded = await base.upload(new File([new Uint8Array(input.data)], input.name, { type: input.mime }))
    const free = FILE_ID_PATTERN.test(input.preferredId) && await base.get(input.preferredId) === null
    const id = free ? input.preferredId : uploaded.id
    await db.update(files).set({ id, createdAt: input.createdAt }).where(eq(files.id, uploaded.id))
    const file = await base.get(id)
    if (file === null)
      throw new Error(`fake files: the imported file ${id} is missing.`)
    return { file, reused: false }
  }

  async function purge(): Promise<FilePurgeResult> {
    const rows = await db.delete(files).returning({ size: files.size })
    await rm(deps.env.paths.files, { recursive: true, force: true })
    await mkdir(deps.env.paths.files, { recursive: true, mode: 0o700 })
    return { files: rows.length, bytes: rows.reduce((total, row) => total + row.size, 0) }
  }

  async function saveGenerated(input: GeneratedFileInput): Promise<StoredFile> {
    const mediaType = (input.mediaType.split(';')[0] ?? '').trim().toLowerCase()
    if (!(GENERATED_IMAGE_MIME_TYPES as readonly string[]).includes(mediaType))
      throw validationError([{ path: ['mediaType'], message: `Generated files are stored only as PNG, JPEG, WebP or GIF images, not "${mediaType}".`, code: 'custom' }])
    if (input.data.byteLength > LIMITS.generatedImageBytes) {
      throw new HarnessError({
        code: 'payload_too_large',
        message: `Generated images are limited to ${LIMITS.generatedImageBytes / 1024 / 1024} MB.`,
        details: { limitBytes: LIMITS.generatedImageBytes },
      })
    }
    if (sniffBinaryType(input.data) !== mediaType)
      throw validationError([{ path: ['data'], message: `The generated image does not match its type (${mediaType}).`, code: 'custom' }])
    const sha256 = createHash('sha256').update(input.data).digest('hex')
    const [existing] = await db.select().from(files).where(eq(files.sha256, sha256)).orderBy(asc(files.createdAt), asc(files.id)).limit(1)
    if (existing !== undefined)
      return existing
    const uploaded = await base.upload(new File([new Uint8Array(input.data)], input.name, { type: mediaType }))
    const file = await base.get(uploaded.id)
    if (file === null)
      throw new Error(`fake files: the generated file ${uploaded.id} is missing.`)
    return file
  }

  const fake = { ...base, importFile, purge, saveGenerated }
  return fake
}

/** Bytes of a `ReadableStream` (fake streams, `DataBackup.stream`, `ShareFile.stream`). */
export async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
