// Data service (W5.3-T1, T5, T6): the summary, delete-all (confirmation, fresh auth, runs, usage, share links, files,
// events) and the mutex shared by imports and delete-all.
import type { DataTestApp } from './fixtures.test-util.ts'
import { existsSync, readdirSync } from 'node:fs'
import { dataDeleteResultSchema, DEFAULT_SETTINGS, HarnessError } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { chatShares, files, usage } from '../../db/schema.ts'
import { freshAuthRequiredError } from '../../http/middleware/fresh-auth.ts'
import { PNG, TEXT } from '../files/fixtures.test-util.ts'
import { assistant, chatId, closeDataApps, dataApp, filePart, treeChat, user } from './fixtures.test-util.ts'

afterEach(async () => {
  await closeDataApps()
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
    expect(await app.deps.data.summary()).toEqual({ chats: 0, archivedChats: 0, messages: 0, files: 0, fileBytes: 0 })
    await seed(app)
    expect(await app.deps.data.summary()).toEqual({ chats: 3, archivedChats: 1, messages: 8, files: 2, fileBytes: PNG.byteLength + TEXT.byteLength })
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
    expect(await app.deps.data.summary()).toEqual({ chats: 0, archivedChats: 0, messages: 0, files: 2, fileBytes: PNG.byteLength + TEXT.byteLength })
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
    expect(await app.deps.data.summary()).toEqual({ chats: 0, archivedChats: 0, messages: 0, files: 0, fileBytes: 0 })
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
