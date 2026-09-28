import type { TestApp } from '../../testing/create-test-app.ts'
// Bulk data routes (API.md 5.19): summary, the streamed export (headers, HEAD, 413), multipart import (fields, errors,
// body limit, busy), delete-all (confirmation, fresh auth).
import type { FakeDataService } from '../../testing/fakes.ts'
import { dataImportResultSchema, dataSummarySchema, harnessErrorEnvelopeSchema, LIMITS } from '@harness-forge/shared'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { assistant, chatId, closeDataApps, dataApp, importForm, user } from '../../services/data/fixtures.test-util.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeDataService } from '../../testing/fakes.ts'
import { FRESH_AUTH_REQUIRED_MESSAGE } from '../middleware/fresh-auth.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'

const PASSWORD = 'correct horse battery staple'
const fakeApps: TestApp[] = []

afterEach(async () => {
  await closeDataApps()
  for (const app of fakeApps.splice(0))
    await app.close()
})

async function fakeApp(): Promise<{ t: TestApp, data: FakeDataService }> {
  const data = createFakeDataService({ now: () => Date.UTC(2026, 8, 28) })
  const t = await createTestApp({ start: false, overrides: { data } })
  fakeApps.push(t)
  return { t, data }
}

async function errorOf(response: Response) {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

function chatJson(n: number): string {
  return JSON.stringify({
    format: 'harness-forge.chat',
    version: 2,
    exportedAt: 1,
    chat: {
      id: chatId(n),
      title: `Chat ${n}`,
      titleSource: 'user',
      modelRef: 'mock:echo',
      pinned: false,
      archived: false,
      running: false,
      pendingApproval: false,
      createdAt: 1,
      updatedAt: 2,
      settings: {},
      totals: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
      messages: [user(n * 10), assistant(n * 10 + 1)],
      parentIds: [null, user(n * 10).id],
      activeLeafId: assistant(n * 10 + 1).id,
    },
  })
}

describe('gET /api/data', () => {
  it('answers the summary', async () => {
    const app = await dataApp()
    await app.deps.chats.create({ id: chatId(1), messages: [user(1), assistant(2)] })
    const response = await app.t.request('/api/data')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(dataSummarySchema.parse(await response.json())).toEqual({ chats: 1, archivedChats: 0, messages: 2, files: 0, fileBytes: 0 })
  })
})

describe('gET /api/data/export', () => {
  it('streams the zip as an attachment that is never cached', async () => {
    const app = await dataApp({ data: { now: () => Date.UTC(2026, 8, 28, 10) } })
    await app.deps.chats.create({ id: chatId(1), title: 'Hello', messages: [user(1), assistant(2)] })
    const response = await app.t.request('/api/data/export')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="harness-forge-backup-2026-09-28.zip"; filename*=UTF-8\'\'harness-forge-backup-2026-09-28.zip')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-length')).toBeNull()
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(Object.keys(entries)).toEqual(['settings.json', `chats/${chatId(1)}.json`, 'files/index.json', 'manifest.json'])
    expect(JSON.parse(strFromU8(entries['manifest.json']!))).toMatchObject({ counts: { chats: 1, messages: 2 } })

    const bare = await app.t.request('/api/data/export?files=false&settings=0')
    expect(Object.keys(unzipSync(new Uint8Array(await bare.arrayBuffer())))).toEqual([`chats/${chatId(1)}.json`, 'manifest.json'])
    const invalid = await app.t.request('/api/data/export?files=maybe')
    expect(invalid.status).toBe(400)
    expect((await errorOf(invalid)).code).toBe('validation_error')
  })

  it('answers HEAD with the headers only and cancels the stream before anything is read', async () => {
    const { t, data } = await fakeApp()
    const response = await t.request('/api/data/export?files=false', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toContain('harness-forge-backup-2026-09-28.zip')
    expect(await response.arrayBuffer()).toHaveProperty('byteLength', 0)
    expect(data.exports).toEqual({ completed: 0, cancelled: 1 })
    expect(data.calls).toEqual([{ member: 'exportBackup', args: [{ files: false }] }])
  })

  it('answers 413 when the backup would not fit a zip, with the documented envelope', async () => {
    const app = await dataApp({ data: { limits: { backupEntries: 2 } } })
    await app.deps.chats.create({ id: chatId(1) })
    await app.deps.chats.create({ id: chatId(2) })
    const response = await app.t.request('/api/data/export?settings=false')
    expect(response.status).toBe(413)
    const error = await errorOf(response)
    expect(error).toMatchObject({ code: 'payload_too_large', details: { limitEntries: 2 } })
    expect(error.message).toContain('entries')
  })
})

describe('pOST /api/data/import', () => {
  it('imports a chat JSON or a backup zip and answers the result', async () => {
    const source = await dataApp()
    await source.deps.chats.create({ id: chatId(1), title: 'Zipped', messages: [user(1), assistant(2)] })
    const zip = new Uint8Array(await (await source.t.request('/api/data/export')).arrayBuffer())

    const app = await dataApp()
    const single = await app.t.request('/api/data/import', { method: 'POST', body: importForm(chatJson(2), 'chat.json') })
    expect(single.status).toBe(200)
    expect(dataImportResultSchema.parse(await single.json())).toMatchObject({ kind: 'chat', counts: { imported: 1 }, items: [{ chatId: chatId(2), status: 'imported' }] })

    const backup = await app.t.request('/api/data/import', { method: 'POST', body: importForm(zip, 'backup.zip', { onConflict: 'skip', restoreSettings: 'false' }) })
    expect(backup.status).toBe(200)
    expect(dataImportResultSchema.parse(await backup.json())).toMatchObject({ kind: 'backup', counts: { imported: 1 }, items: [{ chatId: chatId(1), title: 'Zipped' }] })

    const copy = await app.t.request('/api/data/import', { method: 'POST', body: importForm(zip, 'backup.zip', { onConflict: 'copy' }) })
    expect(dataImportResultSchema.parse(await copy.json()).items[0]).toMatchObject({ status: 'copied', title: 'Zipped (imported)' })
    expect(await app.deps.data.summary()).toMatchObject({ chats: 3 })
  })

  it('hands the parsed form fields to the service', async () => {
    const { t, data } = await fakeApp()
    const response = await t.request('/api/data/import', { method: 'POST', body: importForm(chatJson(1), 'chat.json', { onConflict: 'copy', restoreSettings: '1' }) })
    expect(response.status).toBe(200)
    const [call] = data.calls
    expect(call?.member).toBe('importData')
    expect(call?.args[1]).toEqual({ onConflict: 'copy', restoreSettings: true })
    const upload = call?.args[0] as File
    expect(upload.name).toBe('chat.json')
    expect(await upload.text()).toBe(chatJson(1))
  })

  it.each([
    ['a JSON body', () => ({ body: chatJson(1), headers: { 'content-type': 'application/json' } })],
    ['no file part', () => ({ body: (() => {
      const form = new FormData()
      form.append('onConflict', 'skip')
      return form
    })() })],
    ['a text field named file', () => ({ body: (() => {
      const form = new FormData()
      form.append('file', 'not a file')
      return form
    })() })],
    ['two files', () => ({ body: (() => {
      const form = importForm(chatJson(1), 'a.json')
      form.append('file', new Blob([chatJson(2)]), 'b.json')
      return form
    })() })],
    ['an unknown field', () => ({ body: importForm(chatJson(1), 'a.json', { mode: 'fast' }) })],
    ['a repeated field', () => ({ body: (() => {
      const form = importForm(chatJson(1), 'a.json', { onConflict: 'skip' })
      form.append('onConflict', 'copy')
      return form
    })() })],
    ['an invalid conflict policy', () => ({ body: importForm(chatJson(1), 'a.json', { onConflict: 'overwrite' }) })],
    ['an invalid restoreSettings value', () => ({ body: importForm(chatJson(1), 'a.json', { restoreSettings: 'yes' }) })],
    ['an upload that is neither a zip nor JSON', () => ({ body: importForm('hello', 'notes.txt') })],
  ])('answers 400 validation_error for %s', async (_label, build) => {
    const app = await dataApp()
    const response = await app.t.request('/api/data/import', { method: 'POST', ...build() })
    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('validation_error')
    expect(await app.deps.data.summary()).toMatchObject({ chats: 0 })
  })

  it('answers 413 above the body limit before reading the upload', async () => {
    const app = await dataApp()
    const response = await app.t.request('/api/data/import', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(LIMITS.backupImportBytes + 64 * 1024 + 1) },
      body: '--x--',
    })
    expect(response.status).toBe(413)
    expect(await errorOf(response)).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.backupImportBytes } })
  })

  it('answers 409 busy while another import or delete-all runs', async () => {
    const { t, data } = await fakeApp()
    data.busy = true
    const response = await t.request('/api/data/import', { method: 'POST', body: importForm(chatJson(1), 'chat.json') })
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toMatchObject({ code: 'conflict', details: { reason: 'busy' } })
  })
})

describe('pOST /api/data/delete', () => {
  it('deletes everything with the typed confirmation and refuses anything else', async () => {
    const app = await dataApp()
    await app.deps.chats.create({ id: chatId(1), messages: [user(1)] })
    for (const body of [{}, { confirm: 'delete' }, { confirm: 'DELETE', extra: true }, { confirm: 'DELETE', files: 'yes' }]) {
      const refused = await app.t.request('/api/data/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      expect(refused.status, JSON.stringify(body)).toBe(400)
      expect((await errorOf(refused)).code).toBe('validation_error')
    }
    expect(await app.deps.data.summary()).toMatchObject({ chats: 1 })
    const response = await app.t.request('/api/data/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE', usage: true }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ chats: 1, messages: 1, files: 0, fileBytes: 0, usageRows: 0 })
  })

  it('needs a fresh login when a password is set', async () => {
    const app = await dataApp({ env: { HF_PASSWORD: PASSWORD } })
    await app.deps.chats.create({ id: chatId(1), messages: [user(1)] })
    const send = async (authAgeMs: number): Promise<Response> => app.t.request('/api/data/delete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cookie': `${SESSION_COOKIE_NAME}=${await app.deps.sessions.issue({ authAt: Date.now() - authAgeMs })}`,
      },
      body: JSON.stringify({ confirm: 'DELETE' }),
    })
    const stale = await send(FRESH_AUTH_WINDOW_MS + 60_000)
    expect(stale.status).toBe(403)
    expect(await errorOf(stale)).toEqual({ code: 'forbidden', message: FRESH_AUTH_REQUIRED_MESSAGE, action: 'login' })
    expect(await app.deps.data.summary()).toMatchObject({ chats: 1 })
    const fresh = await send(60_000)
    expect(fresh.status).toBe(200)
    expect(await app.deps.data.summary()).toMatchObject({ chats: 0 })
    // Without a session at all: 401.
    const anonymous = await app.t.request('/api/data/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) })
    expect(anonymous.status).toBe(401)
  })
})
