// Data service (W5.3-T1, T5, T6): the summary, delete-all (confirmation, fresh auth, runs, usage, share links, files,
// events) and the mutex shared by imports and delete-all (Phase 7, C16-T1: the maintenance lock, also taken by the key
// rotation and the file cleanup); the orphaned file cleanup (W7.8-T4: preview, run, references, `_files`, logs, lock).
// Phase 8 (W8.7): `DataSummary.checkpoints`, the checkpoint purge of delete-all, the plugin data in the manual cleanup
// (the automatic sweep has its own file, ./auto-sweep.test.ts). Phase 11 (W11.7-T6): delete-all keeps the personal hooks,
// the project approvals and the project MCP variables (configuration, like projects and settings). Phase 12 (W12.3-T7):
// delete-all keeps the marketplaces and the Claude Code plugins.
import type { MaintenanceOperation } from '../maintenance/types.ts'
import type { DataTestApp } from './fixtures.test-util.ts'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataCleanupPreviewSchema, dataCleanupResultSchema, dataDeleteResultSchema, DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatShares, files, hooks, marketplaces, messages, pluginKv, plugins, projects, projectTrust, secrets, usage } from '../../db/schema.ts'
import { freshAuthRequiredError } from '../../http/middleware/fresh-auth.ts'
import { createFakeCheckpointService } from '../../testing/fake-checkpoints.ts'
import { GIF, JPEG, PNG, TEXT } from '../files/fixtures.test-util.ts'
import { fileUrl } from '../files/index.ts'
import { DAY_MS, HOUR_MS, seedStoredFile, sha256Of } from '../files/store.test-util.ts'
import { MAINTENANCE_BUSY_MESSAGE } from '../maintenance/index.ts'
import { closeCustomizedApps, PHASE11_SENTINELS, PHASE12_PLUGIN_ID, PHASE12_SENTINELS, realDataApp, seedPhase11, seedPhase12 } from './backup-fixtures.test-util.ts'
import { FILE_STATE_SETTING } from './cleanup.ts'
import { assistant, chatId, checkpointsOf, closeDataApps, dataApp, filePart, mid, treeChat, user } from './fixtures.test-util.ts'

afterEach(async () => {
  await closeDataApps()
  await closeCustomizedApps()
})

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

/** Three chats (one archived, one a tree with attachments), usage rows, a share link, a loose upload. */
async function seed(app: DataTestApp): Promise<void> {
  const png = await app.deps.files.upload(new File([new Uint8Array(PNG)], 'dot.png', { type: 'image/png' }))
  await app.deps.files.upload(new File([new Uint8Array(TEXT)], 'loose.txt', { type: 'text/plain' }))
  await app.deps.chats.create(treeChat(1, [filePart(png)]))
  await app.deps.chats.create({ id: chatId(2), messages: [user(201), assistant(202)] })
  await app.deps.chats.update(chatId(2), { archived: true })
  await app.deps.chats.create({ id: chatId(3) })
  for (const id of [chatId(1), chatId(2)])
    await app.deps.chats.addUsage({ chatId: id, messageId: null, purpose: 'chat', providerId: 'mock', modelId: 'echo', inputTokens: 1, outputTokens: 2, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null })
  await app.t.db.insert(chatShares).values({
    id: 'shr_0000000000000001',
    chatId: chatId(1),
    options: { reasoning: false, toolDetails: false, attachments: true },
    snapshot: { title: null, messages: [] },
    snapshotAt: 1,
  })
}

describe('data summary', () => {
  it('counts every chat (archived included), every message version, file rows and their bytes', async () => {
    const app = await dataApp()
    expect(await app.deps.data.summary()).toEqual({ chats: 0, archivedChats: 0, messages: 0, files: 0, fileBytes: 0, fileSweep: { mode: 'off', lastAttempt: null, nextRunAt: null }, checkpoints: { bytes: 0, blobs: 0 } })
    await seed(app)
    expect(await app.deps.data.summary()).toEqual({ chats: 3, archivedChats: 1, messages: 8, files: 2, fileBytes: PNG.byteLength + TEXT.byteLength, fileSweep: { mode: 'off', lastAttempt: null, nextRunAt: null }, checkpoints: { bytes: 0, blobs: 0 } })
  })
})

describe('delete-all', () => {
  it('stops every run, deletes chats, messages and share links, keeps usage rows detached and files by default', async () => {
    const app = await dataApp()
    await seed(app)
    await app.deps.settings.update({ displayName: 'Keep me' })
    await app.deps.secrets.set('provider:openai', 'apiKey', 'sk-keep-0000000000')
    app.runs.phases.set(chatId(1), 'preparing')
    app.runs.phases.set(chatId(2), 'streaming')
    app.events.clear()

    const result = dataDeleteResultSchema.parse(await app.deps.data.deleteAll({ confirm: 'DELETE' }))
    expect(result).toEqual({ chats: 3, messages: 8, files: 0, fileBytes: 0, usageRows: 0 })
    expect([...app.runs.stopped].sort()).toEqual([chatId(1), chatId(2), chatId(3)])
    expect(app.runs.phases.size).toBe(0)
    expect(await app.deps.chats.allIds()).toEqual([])
    expect(await app.t.db.select().from(chatShares)).toEqual([])
    expect(await app.t.db.select({ chatId: usage.chatId }).from(usage)).toEqual([{ chatId: null }, { chatId: null }])
    expect(await app.t.db.select().from(files)).toHaveLength(2)
    expect(readdirSync(app.t.env.paths.files)).not.toEqual([])
    // No new event type: one chat.deleted per chat.
    expect(app.events.events.map(event => event.type)).toEqual(['chat.deleted', 'chat.deleted', 'chat.deleted'])
    // Settings and credentials stay.
    expect((await app.deps.settings.get()).displayName).toBe('Keep me')
    expect(await app.deps.secrets.get('provider:openai', 'apiKey')).toBe('sk-keep-0000000000')
    expect(await app.deps.data.summary()).toEqual({ chats: 0, archivedChats: 0, messages: 0, files: 2, fileBytes: PNG.byteLength + TEXT.byteLength, fileSweep: { mode: 'off', lastAttempt: null, nextRunAt: null }, checkpoints: { bytes: 0, blobs: 0 } })
  })

  it('also deletes the usage rows and every file (rows and blobs) on request', async () => {
    const app = await dataApp()
    await seed(app)
    const result = await app.deps.data.deleteAll({ confirm: 'DELETE', files: true, usage: true })
    expect(result).toEqual({ chats: 3, messages: 8, files: 2, fileBytes: PNG.byteLength + TEXT.byteLength, usageRows: 2 })
    expect(await app.t.db.select().from(usage)).toEqual([])
    expect(await app.t.db.select().from(files)).toEqual([])
    expect(existsSync(app.t.env.paths.files)).toBe(true)
    expect(readdirSync(app.t.env.paths.files)).toEqual([])
    expect(await app.deps.data.summary()).toEqual({ chats: 0, archivedChats: 0, messages: 0, files: 0, fileBytes: 0, fileSweep: { mode: 'off', lastAttempt: null, nextRunAt: null }, checkpoints: { bytes: 0, blobs: 0 } })
  })

  it('checks fresh auth and the typed confirmation before anything is stopped or deleted', async () => {
    const app = await dataApp()
    await seed(app)
    app.runs.phases.set(chatId(1), 'streaming')
    const stale = await rejection(app.deps.data.deleteAll({ confirm: 'DELETE' }, { requireFreshAuth: () => {
      throw freshAuthRequiredError()
    } }))
    expect(stale.toJSON().error).toMatchObject({ code: 'forbidden', action: 'login' })
    const unconfirmed = await rejection(app.deps.data.deleteAll({ confirm: 'delete' } as never))
    expect(unconfirmed).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['confirm'] }] } })
    expect(app.runs.stopped).toEqual([])
    expect(await app.deps.data.summary()).toMatchObject({ chats: 3, messages: 8, files: 2 })

    let checks = 0
    await app.deps.data.deleteAll({ confirm: 'DELETE' }, { requireFreshAuth: () => {
      checks += 1
    } })
    expect(checks).toBe(1)
    expect(await app.deps.data.summary()).toMatchObject({ chats: 0 })
  })

  it('stops the run of a chat that appeared while everything was deleted', async () => {
    const app = await dataApp({
      // The chat 3 is created after the ids are read.
      chats: chats => ({ ...chats, allIds: async () => (await chats.allIds()).filter(id => id !== chatId(3)) }),
    })
    await seed(app)
    app.runs.phases.set(chatId(3), 'preparing')
    const result = await app.deps.data.deleteAll({ confirm: 'DELETE' })
    expect(result.chats).toBe(3)
    expect(app.runs.stopped).toEqual([chatId(1), chatId(2), chatId(3)])
    expect(app.runs.phases.size).toBe(0)
  })

  it('refuses an import while a delete-all runs (409 busy), and is released afterwards', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = await dataApp({
      chats: chats => ({
        ...chats,
        removeAll: async (options) => {
          await gate
          return chats.removeAll(options)
        },
      }),
    })
    await seed(app)
    const running = app.deps.data.deleteAll({ confirm: 'DELETE' })
    const busy = await rejection(app.deps.data.importData(new Blob(['{}'])))
    expect(busy.toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'busy' } })
    expect((await rejection(app.deps.data.deleteAll({ confirm: 'DELETE' }))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'busy' } })
    release()
    expect((await running).chats).toBe(3)
    expect(await app.deps.data.deleteAll({ confirm: 'DELETE' })).toEqual({ chats: 0, messages: 0, files: 0, fileBytes: 0, usageRows: 0 })
    expect(await app.deps.settings.get()).toEqual(DEFAULT_SETTINGS)
  })
})

describe('delete-all keeps the Phase 11 configuration', () => {
  it('keeps personal hooks, project approvals, project MCP variables, the project, its style and the personal definitions', async () => {
    const t = await realDataApp()
    const seeded = await seedPhase11(t)
    const result = await t.deps.data.deleteAll({ confirm: 'DELETE', files: true, usage: true })
    expect(result).toMatchObject({ chats: 1, messages: 4 })
    expect((await t.deps.chats.list({})).items).toEqual([])

    expect((await t.deps.db.select().from(hooks)).map(row => row.command)).toEqual([PHASE11_SENTINELS.hookCommand])
    expect(await t.deps.db.select({ projectId: projectTrust.projectId, sha256: projectTrust.sha256 }).from(projectTrust)).toEqual([{ projectId: seeded.projectId, sha256: PHASE11_SENTINELS.trustSha256 }])
    expect((await t.deps.db.select().from(secrets)).filter(row => row.scope === `project:${seeded.projectId}`).map(row => row.name)).toEqual(['mcp.var.MCP_TOKEN'])
    expect(await t.deps.db.select({ id: projects.id }).from(projects)).toEqual([{ id: seeded.projectId }])
    expect((await t.deps.projects.get(seeded.projectId)).outputStyle).toBe('terse')
    expect(await t.deps.settings.get()).toMatchObject({ outputStyle: 'terse', hooksEnabled: false })
    expect((await t.deps.customizations.exportBackup()).items.map(item => item.name)).toEqual(['review', 'status', 'terse'])
  })
})

describe('delete-all keeps the Phase 12 configuration', () => {
  it('keeps the marketplaces and the Claude Code plugins (configuration, like the personal hooks)', async () => {
    const t = await realDataApp()
    const seeded = await seedPhase11(t)
    const phase12 = await seedPhase12(t, seeded.chatId)
    expect(await t.deps.data.deleteAll({ confirm: 'DELETE', files: true, usage: true })).toMatchObject({ chats: 1 })
    expect((await t.deps.db.select().from(marketplaces)).map(row => [row.id, row.name])).toEqual([[phase12.marketplaceId, 'acme-tools']])
    expect((await t.deps.db.select().from(plugins)).map(row => [row.id, row.format, row.trustedHash])).toEqual([[PHASE12_PLUGIN_ID, 'claude', PHASE12_SENTINELS.pluginTrust]])
  })
})

describe('maintenance lock (Phase 7)', () => {
  it('holds the maintenance lock as delete-all while it runs, and refuses both while another maintenance task runs', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let seen: string | undefined
    const app = await dataApp({
      chats: chats => ({
        ...chats,
        removeAll: async (options) => {
          seen = app.deps.maintenance.current()?.kind
          await gate
          return chats.removeAll(options)
        },
      }),
    })
    const running = app.deps.data.deleteAll({ confirm: 'DELETE' })
    await Promise.resolve()
    release()
    await running
    expect(seen).toBe('delete-all')
    expect(app.deps.maintenance.current()).toBeNull()

    let finish!: () => void
    const rotation = app.deps.maintenance.exclusive('key-rotation', () => new Promise<void>((resolve) => {
      finish = resolve
    }), { blockRuns: true })
    expect((await rejection(app.deps.data.importData(new Blob(['{}'])))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'busy' } })
    expect((await rejection(app.deps.data.deleteAll({ confirm: 'DELETE' }))).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'busy' } })
    finish()
    await rotation
    expect((await app.deps.data.deleteAll({ confirm: 'DELETE' })).chats).toBe(0)
  })

  it('releases the lock when an import fails', async () => {
    const app = await dataApp()
    const failed = await rejection(app.deps.data.importData(new Blob(['not a backup'])))
    expect(failed.code).toBe('validation_error')
    expect(app.deps.maintenance.current()).toBeNull()
  })
})

const GRACE_MS = 86_400_000

function fileRef(file: { id: string, name: string, mime: string, size: number }) {
  return { id: file.id, name: file.name, mime: file.mime, size: file.size, url: fileUrl(file.id) }
}

async function fileIds(app: DataTestApp): Promise<string[]> {
  return (await app.t.db.select({ id: files.id }).from(files)).map(row => row.id).sort()
}

describe('orphaned file cleanup (Phase 7)', () => {
  it('previews, then removes only what nothing references; stores the last run and logs counts only', async () => {
    let now = Date.now()
    const app = await dataApp({ data: { now: () => now }, filesOptions: { now: () => now } })
    const old = now - 3 * DAY_MS
    const orphanBytes = new TextEncoder().encode('orphaned bytes')
    const orphan = await seedStoredFile(app.deps, orphanBytes, { createdAt: old, name: 'private-plan.txt', mime: 'text/plain' })
    const kvOnly = await seedStoredFile(app.deps, PNG, { createdAt: old, name: 'kv.png', mime: 'image/png' })
    const inShare = await seedStoredFile(app.deps, JPEG, { createdAt: old, name: 'shared.jpg', mime: 'image/jpeg' })
    const inMessage = await seedStoredFile(app.deps, GIF, { createdAt: old, name: 'kept.gif', mime: 'image/gif' })
    const recent = await seedStoredFile(app.deps, TEXT, { createdAt: now - HOUR_MS, name: 'recent.txt', mime: 'text/plain' })
    // A plugin keeps an id in `ctx.storage` only.
    await app.t.db.insert(pluginKv).values({ pluginId: 'gallery', key: 'last', value: { image: kvOnly.id } })
    // A share keeps its snapshot after the message version it showed was deleted.
    await app.deps.chats.create({ id: chatId(1), messages: [user(1, 'look', [filePart(fileRef(inShare))])] })
    await app.t.db.insert(chatShares).values({
      id: 'shr_0000000000000001',
      chatId: chatId(1),
      options: { reasoning: false, toolDetails: false, attachments: true },
      snapshot: { title: null, messages: [{ id: mid(1), role: 'user', parts: [{ type: 'file', mediaType: 'image/jpeg', url: fileUrl(inShare.id) }] }] } as never,
      fileIds: [inShare.id],
      snapshotAt: 1,
    })
    await app.t.db.delete(messages).where(eq(messages.id, mid(1)))
    await app.deps.chats.create({ id: chatId(2), messages: [user(2, 'gif', [filePart(fileRef(inMessage))])] })
    const all = await fileIds(app)

    const preview = await app.deps.data.cleanupPreview()
    expect(dataCleanupPreviewSchema.parse(preview)).toEqual({
      files: 1,
      fileBytes: orphanBytes.byteLength,
      blobs: 0,
      diskBytes: orphanBytes.byteLength,
      tempFiles: 0,
      recentFiles: 1,
      graceMs: GRACE_MS,
      lastRunAt: null,
      fileSweep: { mode: 'off', lastAttempt: null, nextRunAt: null },
      pluginData: 'complete',
    })
    expect(await fileIds(app)).toEqual(all)
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toBeUndefined()

    now += 1000
    const result = await app.deps.data.cleanup()
    expect(dataCleanupResultSchema.parse(result)).toEqual({ files: 1, fileBytes: orphanBytes.byteLength, blobs: 0, diskBytes: orphanBytes.byteLength, tempFiles: 0, ranAt: now, pluginData: 'complete' })
    expect(await fileIds(app)).toEqual(all.filter(id => id !== orphan.id))
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toEqual({ lastCleanup: now })
    const record = app.t.logs.records.find(entry => entry.msg === 'orphaned files cleaned up')
    expect(record).toMatchObject({ level: 'info', files: 1, fileBytes: orphanBytes.byteLength, blobs: 0, diskBytes: orphanBytes.byteLength, tempFiles: 0, recentFiles: 1 })
    const logs = app.t.logs.text()
    for (const secret of [orphan.id, 'private-plan', sha256Of(orphanBytes), kvOnly.id])
      expect(logs).not.toContain(secret)

    const ranAt = now
    now += 1000
    expect(await app.deps.data.cleanupPreview()).toMatchObject({ files: 0, recentFiles: 1, lastRunAt: ranAt })

    // Once the share and the plugin value are gone, their files go too; a referenced message keeps its file.
    await app.t.db.delete(chatShares)
    await app.t.db.delete(pluginKv)
    expect(await app.deps.data.cleanup()).toMatchObject({ files: 2, fileBytes: PNG.byteLength + JPEG.byteLength, ranAt: now })
    expect(await fileIds(app)).toEqual([inMessage.id, recent.id].sort())
  })

  it('runs under the maintenance lock as file-cleanup without blocking runs; other data tasks are busy meanwhile', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let seen: MaintenanceOperation | null = null
    const app = await dataApp({
      files: inner => ({
        ...inner,
        sweep: async (input) => {
          seen = app.deps.maintenance.current()
          await gate
          return inner.sweep(input)
        },
      }),
    })
    const running = app.deps.data.cleanup()
    await vi.waitFor(() => expect(seen).not.toBeNull())
    expect(seen).toMatchObject({ kind: 'file-cleanup', blockRuns: false })
    for (const attempt of [app.deps.data.importData(new Blob(['{}'])), app.deps.data.deleteAll({ confirm: 'DELETE' }), app.deps.data.cleanupPreview(), app.deps.data.cleanup()])
      expect((await rejection(attempt)).toJSON().error).toMatchObject({ code: 'conflict', details: { reason: 'busy' } })
    release()
    expect((await running).files).toBe(0)
    expect(app.deps.maintenance.current()).toBeNull()
  })

  it('answers 409 busy while an import, delete-all or key rotation holds the lock', async () => {
    const app = await dataApp()
    for (const kind of ['import', 'delete-all', 'key-rotation'] as const) {
      let finish!: () => void
      const holder = app.deps.maintenance.exclusive(kind, () => new Promise<void>((resolve) => {
        finish = resolve
      }))
      for (const attempt of [app.deps.data.cleanupPreview(), app.deps.data.cleanup()])
        expect((await rejection(attempt)).toJSON().error, kind).toEqual({ code: 'conflict', message: MAINTENANCE_BUSY_MESSAGE, details: { reason: 'busy' } })
      finish()
      await holder
    }
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toBeUndefined()
    expect((await app.deps.data.cleanupPreview()).lastRunAt).toBeNull()
  })

  it('releases the lock and stores nothing when the sweep fails', async () => {
    const failure = new HarnessError({ code: 'internal_error', message: 'disk gone' })
    const app = await dataApp({ files: inner => ({ ...inner, sweep: async () => Promise.reject(failure) }) })
    expect(await rejection(app.deps.data.cleanup())).toBe(failure)
    expect(app.deps.maintenance.current()).toBeNull()
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toBeUndefined()
  })

  it('ignores a malformed stored state', async () => {
    const app = await dataApp()
    await app.deps.settings.setInternal(FILE_STATE_SETTING, { lastCleanup: 'yesterday' })
    expect((await app.deps.data.cleanupPreview()).lastRunAt).toBeNull()
    await app.deps.settings.setInternal(FILE_STATE_SETTING, ['not', 'an', 'object'])
    expect((await app.deps.data.cleanupPreview()).lastRunAt).toBeNull()
    const result = await app.deps.data.cleanup()
    expect(await app.deps.settings.getInternal(FILE_STATE_SETTING)).toEqual({ lastCleanup: result.ranAt })
  })
})

// ---------- Phase 8 (W8.7) ----------

describe('checkpoints in the summary and delete-all (Phase 8)', () => {
  it('reports the checkpoint store from CheckpointService.summary(), and omits it when the summary fails', async () => {
    const app = await dataApp({ checkpoints: createFakeCheckpointService({ summary: async () => ({ bytes: 4096, blobs: 3 }) }) })
    expect((await app.deps.data.summary()).checkpoints).toEqual({ bytes: 4096, blobs: 3 })
    const broken = await dataApp({ checkpoints: createFakeCheckpointService({ summary: async () => Promise.reject(Object.assign(new Error('EACCES: /data/checkpoints'), { code: 'EACCES' })) }) })
    const summary = await broken.deps.data.summary()
    expect(summary).not.toHaveProperty('checkpoints')
    expect(summary.fileSweep).toEqual({ mode: 'off', lastAttempt: null, nextRunAt: null })
    expect(broken.t.logs.records.find(record => record.msg === 'checkpoint store summary failed')).toMatchObject({ level: 'warn', code: 'EACCES' })
    expect(broken.t.logs.text()).not.toContain('/data/checkpoints')
  })

  it('delete-all purges the checkpoint store inside its maintenance operation, after the runs stopped', async () => {
    let held: MaintenanceOperation | null = null
    let stoppedBefore = -1
    let chatsBefore = -1
    const app: DataTestApp = await dataApp({
      checkpoints: createFakeCheckpointService({
        purge: async () => {
          held = app.deps.maintenance.current()
          stoppedBefore = app.runs.stopped.length
          chatsBefore = (await app.deps.chats.allIds()).length
          return { bytes: 2048, blobs: 2 }
        },
      }),
    })
    await seed(app)
    app.runs.phases.set(chatId(1), 'streaming')
    expect(await app.deps.data.deleteAll({ confirm: 'DELETE' })).toMatchObject({ chats: 3 })
    expect(held).toMatchObject({ kind: 'delete-all', blockRuns: false })
    expect(stoppedBefore).toBe(3)
    expect(chatsBefore).toBe(0)
    expect(app.deps.maintenance.current()).toBeNull()
    expect(app.t.logs.records.find(record => record.msg === 'data deleted')).toMatchObject({ checkpointBlobs: 2, checkpointBytes: 2048 })
  })

  it('a failed checkpoint purge is logged and does not fail the delete-all', async () => {
    const app = await dataApp({ checkpoints: createFakeCheckpointService({ purge: async () => Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })) }) })
    await seed(app)
    expect(await app.deps.data.deleteAll({ confirm: 'DELETE', files: true })).toMatchObject({ chats: 3, files: 2 })
    expect(app.t.logs.records.find(record => record.msg === 'checkpoint store purge failed')).toMatchObject({ level: 'warn', code: 'EBUSY' })
    expect(app.t.logs.records.find(record => record.msg === 'data deleted')).toMatchObject({ checkpointBlobs: 0 })
  })

  it('the default fake records one purge per delete-all and one summary per GET', async () => {
    const app = await dataApp()
    await app.deps.data.summary()
    await app.deps.data.deleteAll({ confirm: 'DELETE' })
    expect(checkpointsOf(app).calls.map(call => call.member)).toEqual(['summary', 'purge'])
  })
})

describe('plugin data in the manual cleanup (Phase 8)', () => {
  it('keeps a file only a plugin data file references, never touches the checkpoint folder, logs counts only', async () => {
    let now = Date.now()
    const app = await dataApp({ data: { now: () => now }, filesOptions: { now: () => now } })
    const old = now - 3 * DAY_MS
    const referenced = await seedStoredFile(app.deps, new TextEncoder().encode('kept by a plugin'), { createdAt: old, name: 'kept.txt' })
    const orphan = await seedStoredFile(app.deps, new TextEncoder().encode('nobody'), { createdAt: old, name: 'nobody.txt' })
    const pluginFile = join(app.t.env.paths.pluginData, 'gallery', 'nested', 'index.json')
    mkdirSync(join(pluginFile, '..'), { recursive: true })
    writeFileSync(pluginFile, JSON.stringify({ images: [referenced.id] }))
    // A checkpoint blob named like a files blob, old enough for the files walk: a separate tree, never swept.
    const sha = sha256Of(new TextEncoder().encode('checkpoint'))
    const checkpoint = join(app.t.env.paths.checkpoints, sha.slice(0, 2), sha)
    mkdirSync(join(checkpoint, '..'), { recursive: true })
    writeFileSync(checkpoint, 'Turn 1\n')

    expect(await app.deps.data.cleanupPreview()).toMatchObject({ files: 1, pluginData: 'complete' })
    now += 1000
    expect(await app.deps.data.cleanup()).toMatchObject({ files: 1, pluginData: 'complete', ranAt: now })
    expect(await fileIds(app)).toEqual([referenced.id])
    expect(existsSync(checkpoint)).toBe(true)
    expect(app.t.logs.records.find(record => record.msg === 'orphaned files cleaned up')).toMatchObject({
      level: 'info',
      trigger: 'manual',
      files: 1,
      pluginData: 'complete',
      pluginDataFiles: 1,
    })
    const logs = app.t.logs.text()
    expect(logs).not.toMatch(/file_[\dA-Za-z]{16}/)
    expect(logs).not.toContain(orphan.name)
  })
})
