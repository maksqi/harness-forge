// Share service (W5.4) over the test database, with the C8 fake of the chats tree (`createFakeChatsService`: `get`
// returns the active path) and the real files service.
import type { ChatCreate, HarnessError, ShareSummary } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { LIMITS, SHARE_TOKEN_PATTERN, shareSummarySchema, shareViewSchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { chats, chatShares } from '../../db/schema.ts'
import { swapMasterKey } from '../../security/keyring.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeChatsService, createFakeKeyring, fakeMasterKey, readAllBytes } from '../../testing/fakes.ts'
import { isInvalidShareTokenError, SHARE_UNAVAILABLE_MESSAGE } from './errors.ts'
import { createShareService, SHARE_MAX_EXPIRY_MS } from './index.ts'
import { createShareTokens } from './token.ts'

const DAY = 24 * 60 * 60 * 1000
const PNG = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

function chatId(n: number): string {
  return `0199a8f0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
}

function mid(n: number): string {
  return `msg_${n.toString().padStart(16, '0')}`
}

const CHAT = chatId(1)

function tokenOf(summary: ShareSummary): string {
  return summary.path.slice('/share/'.length)
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

interface SeededApp {
  t: TestApp
  /** On the active path (A2). */
  pngId: string
  /** Only on the other version (A). */
  notesId: string
}

async function testApp(now?: () => number): Promise<TestApp> {
  const t = await createTestApp({
    start: false,
    factories: { chats: createFakeChatsService, ...(now === undefined ? {} : { shares: deps => createShareService(deps, { now }) }) },
  })
  apps.push(t)
  return t
}

/**
 * A (1, with notes.txt) -> RA (2); A2 (3, an edit of A, with dot.png) -> RA2 (4: reasoning, text, a tool call), active
 * leaf RA2.
 */
async function seededApp(now?: () => number): Promise<SeededApp> {
  const t = await testApp(now)
  const png = await t.deps.files.upload(new File([PNG], 'dot.png', { type: 'image/png' }))
  const notes = await t.deps.files.upload(new File(['old notes\n'], 'notes.txt', { type: 'text/plain' }))
  const tree: ChatCreate = {
    id: CHAT,
    title: 'Branches',
    messages: [
      { id: mid(1), role: 'user', parts: [{ type: 'text', text: 'first version' }, { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', url: notes.url }] },
      { id: mid(2), role: 'assistant', parts: [{ type: 'text', text: 'first reply', state: 'done' }] },
      { id: mid(3), role: 'user', parts: [{ type: 'text', text: 'second version' }, { type: 'file', mediaType: 'image/png', filename: 'dot.png', url: png.url }] },
      {
        id: mid(4),
        role: 'assistant',
        metadata: { modelRef: 'mock:echo', startedAt: 1, usage: { inputTokens: 424242 }, costUsd: 1.2345 },
        parts: [
          { type: 'step-start' },
          { type: 'reasoning', text: 'thinking hard', state: 'done' },
          { type: 'text', text: 'second reply', state: 'done' },
          { type: 'tool-web_fetch', toolCallId: 'call_1', state: 'output-available', input: { url: 'https://example.com' }, output: { status: 200 } },
        ],
      },
    ],
    parentIds: [null, mid(1), null, mid(3)],
    activeLeafId: mid(4),
  }
  await t.deps.chats.create(tree)
  return { t, pngId: png.id, notesId: notes.id }
}

async function storedRow(t: TestApp, id: string) {
  const [row] = await t.db.select().from(chatShares).where(eq(chatShares.id, id))
  return row
}

describe('create and list', () => {
  it('snapshots the active path only, with a recomputed token and nothing token-like stored', async () => {
    const { t, pngId, notesId } = await seededApp()
    const summary = shareSummarySchema.parse(await t.deps.shares.create({ chatId: CHAT }))
    expect(summary).toMatchObject({
      chatId: CHAT,
      chatTitle: 'Branches',
      title: null,
      options: { reasoning: false, toolDetails: false, attachments: true },
      messageCount: 2,
      outdated: false,
      expiresAt: null,
      expired: false,
    })
    expect(summary.id).toMatch(/^shr_[\dA-Z]{16}$/i)
    const token = tokenOf(summary)
    expect(token).toMatch(SHARE_TOKEN_PATTERN)
    expect(token).toBe(createShareTokens(createFakeKeyring().subkey('share')).tokenOf(summary.id))

    const row = (await storedRow(t, summary.id))!
    expect(row.fileIds).toEqual([pngId])
    expect(row.messageCount).toBe(2)
    expect(row.snapshot.title).toBe('Branches')
    const stored = JSON.stringify(row)
    // The MAC half of the token is never stored; reasoning and tool details are (the options apply when served).
    expect(stored).not.toContain(token.slice(16))
    expect(stored).toContain('thinking hard')
    expect(stored).toContain('https://example.com')
    for (const absent of ['first version', 'first reply', notesId, '424242', '1.2345', 'step-start', 'call_1', mid(3)])
      expect(stored, absent).not.toContain(absent)
  })

  it('applies the defaults, a custom title and an expiry', async () => {
    const { t } = await seededApp()
    const expiresAt = Date.now() + DAY
    const summary = await t.deps.shares.create({ chatId: CHAT, title: 'For the team', options: { reasoning: true }, expiresAt })
    expect(summary).toMatchObject({ title: 'For the team', chatTitle: 'Branches', options: { reasoning: true, toolDetails: false, attachments: true }, expiresAt, expired: false })
    expect((await t.deps.shares.view(tokenOf(summary))).title).toBe('For the team')
  })

  it('refuses an unknown chat, an expiry in the past or beyond 365 days, and a 21st link', async () => {
    let now = Date.now()
    const { t } = await seededApp(() => now)
    expect(await rejection(t.deps.shares.create({ chatId: chatId(9) }))).toMatchObject({ code: 'not_found', message: `Chat ${chatId(9)} not found.` })
    for (const expiresAt of [now, now - 1, now + SHARE_MAX_EXPIRY_MS + 1]) {
      const error = await rejection(t.deps.shares.create({ chatId: CHAT, expiresAt }))
      expect(error.code, String(expiresAt)).toBe('validation_error')
      expect(error.details).toEqual({ issues: [expect.objectContaining({ path: ['expiresAt'] })] })
    }
    await t.deps.shares.create({ chatId: CHAT, expiresAt: now + SHARE_MAX_EXPIRY_MS })
    // Concurrent creates cannot pass the per-chat limit.
    const results = await Promise.allSettled(Array.from({ length: LIMITS.sharesPerChatMax + 4 }, () => t.deps.shares.create({ chatId: CHAT })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(LIMITS.sharesPerChatMax - 1)
    const refused = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toMatchObject({ code: 'validation_error', details: { issues: [expect.objectContaining({ path: ['chatId'] })] } })
    expect(await t.deps.shares.list({ chatId: CHAT })).toHaveLength(LIMITS.sharesPerChatMax)
    now += 1
    expect((await rejection(t.deps.shares.create({ chatId: CHAT }))).code).toBe('validation_error')
  })

  it('lists newest first, per chat or all, with the current chat title', async () => {
    let now = 1_700_000_000_000
    const { t } = await seededApp(() => now)
    await t.deps.chats.create({ id: chatId(2), title: 'Other', messages: [{ id: mid(9), role: 'user', parts: [{ type: 'text', text: 'hi' }] }] })
    const first = await t.deps.shares.create({ chatId: CHAT })
    now += 10
    const second = await t.deps.shares.create({ chatId: chatId(2) })
    now += 10
    const third = await t.deps.shares.create({ chatId: CHAT })
    expect((await t.deps.shares.list({})).map(share => share.id)).toEqual([third.id, second.id, first.id])
    expect((await t.deps.shares.list({ chatId: CHAT })).map(share => share.id)).toEqual([third.id, first.id])
    expect(await t.deps.shares.list({ chatId: chatId(7) })).toEqual([])
    await t.deps.chats.update(CHAT, { title: 'Renamed chat' })
    const listed = await t.deps.shares.list({ chatId: CHAT })
    expect(listed.map(share => share.chatTitle)).toEqual(['Renamed chat', 'Renamed chat'])
    // The page keeps the title of the snapshot until it is refreshed.
    expect((await t.deps.shares.view(tokenOf(first))).title).toBe('Branches')
  })

  it('refuses a snapshot above the size limit with payload_too_large', async () => {
    const t = await testApp()
    await t.deps.chats.create({ id: CHAT })
    await t.deps.chats.appendMessage(CHAT, { id: mid(1), role: 'user', parts: [{ type: 'text', text: 'x'.repeat(LIMITS.shareSnapshotBytes) }] }, null)
    await t.deps.chats.setActiveLeaf(CHAT, mid(1))
    expect(await rejection(t.deps.shares.create({ chatId: CHAT }))).toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.shareSnapshotBytes } })
    expect(await t.deps.shares.list({})).toEqual([])
  })
})

describe('freshness', () => {
  it('is outdated after a later chat update or a branch switch; refresh re-snapshots and keeps the token', async () => {
    const { t } = await seededApp()
    const created = await t.deps.shares.create({ chatId: CHAT })
    const token = tokenOf(created)
    expect((await t.deps.shares.list({}))[0]?.outdated).toBe(false)

    // A later `updated_at` (a new message, a rename).
    await t.db.update(chats).set({ updatedAt: created.snapshotAt + 1 }).where(eq(chats.id, CHAT))
    expect((await t.deps.shares.list({}))[0]?.outdated).toBe(true)

    // A branch switch keeps `updated_at` but changes the path: A -> RA plus a follow-up is 3 messages, not 2.
    await t.deps.chats.appendMessage(CHAT, { id: mid(5), role: 'user', parts: [{ type: 'text', text: 'follow-up' }] }, mid(2))
    await t.deps.chats.setActiveLeaf(CHAT, mid(5))
    await t.db.update(chats).set({ updatedAt: created.snapshotAt }).where(eq(chats.id, CHAT))
    expect((await t.deps.shares.list({}))[0]?.outdated).toBe(true)

    const refreshed = await t.deps.shares.update(created.id, { refresh: true })
    expect(refreshed).toMatchObject({ id: created.id, path: created.path, messageCount: 3, outdated: false })
    expect(refreshed.snapshotAt).toBeGreaterThanOrEqual(created.snapshotAt)
    const view = await t.deps.shares.view(token)
    expect(view.messages.map(message => message.parts[0])).toEqual([
      { type: 'text', text: 'first version' },
      { type: 'text', text: 'first reply' },
      { type: 'text', text: 'follow-up' },
    ])
    expect((await t.deps.shares.list({}))[0]?.outdated).toBe(false)
  })

  it('is expired once expiresAt has passed: listed as expired, the link is unavailable', async () => {
    let now = Date.now()
    const { t } = await seededApp(() => now)
    const created = await t.deps.shares.create({ chatId: CHAT, expiresAt: now + 60_000 })
    expect((await t.deps.shares.view(tokenOf(created))).messages).toHaveLength(2)
    now += 60_000
    expect((await t.deps.shares.list({}))[0]).toMatchObject({ id: created.id, expired: true })
    expect((await rejection(t.deps.shares.view(tokenOf(created)))).message).toBe(SHARE_UNAVAILABLE_MESSAGE)
    // A new expiry revives the link; null removes it.
    await t.deps.shares.update(created.id, { expiresAt: now + DAY })
    expect((await t.deps.shares.view(tokenOf(created))).messages).toHaveLength(2)
    expect(await t.deps.shares.update(created.id, { expiresAt: null })).toMatchObject({ expiresAt: null, expired: false })
  })
})

describe('update and remove', () => {
  it('changes the title and merges options key by key; the view follows at once without a new snapshot', async () => {
    const { t } = await seededApp()
    const created = await t.deps.shares.create({ chatId: CHAT, title: 'Custom' })
    const token = tokenOf(created)
    expect((await t.deps.shares.view(token)).messages[1]?.parts.map(part => part.type)).toEqual(['text', 'tool'])

    const updated = await t.deps.shares.update(created.id, { options: { reasoning: true, toolDetails: true } })
    expect(updated).toMatchObject({ path: created.path, snapshotAt: created.snapshotAt, options: { reasoning: true, toolDetails: true, attachments: true } })
    const detailed = await t.deps.shares.view(token)
    expect(detailed.messages[1]?.parts).toEqual([
      { type: 'reasoning', text: 'thinking hard' },
      { type: 'text', text: 'second reply' },
      { type: 'tool', toolName: 'web_fetch', status: 'done', input: { url: 'https://example.com' }, output: { status: 200 } },
    ])

    const plain = await t.deps.shares.update(created.id, { title: null, options: { attachments: false } })
    expect(plain).toMatchObject({ title: null, options: { reasoning: true, toolDetails: true, attachments: false }, path: created.path })
    const view = await t.deps.shares.view(token)
    expect(view.title).toBe('Branches')
    expect(view.messages[0]?.parts).toEqual([{ type: 'text', text: 'second version' }])
  })

  it('answers not_found for an unknown share and validates the expiry', async () => {
    const { t } = await seededApp()
    const created = await t.deps.shares.create({ chatId: CHAT })
    expect(await rejection(t.deps.shares.update('shr_0000000000000000', { title: 'x' }))).toMatchObject({ code: 'not_found', message: 'Share shr_0000000000000000 not found.' })
    expect((await rejection(t.deps.shares.update(created.id, { expiresAt: Date.now() - 1 }))).code).toBe('validation_error')
    expect((await rejection(t.deps.shares.remove('shr_0000000000000000'))).code).toBe('not_found')
  })

  it('revokes a link: the row is gone and the token stops working at once', async () => {
    const { t } = await seededApp()
    const created = await t.deps.shares.create({ chatId: CHAT })
    await t.deps.shares.remove(created.id)
    expect(await storedRow(t, created.id)).toBeUndefined()
    const error = await rejection(t.deps.shares.view(tokenOf(created)))
    expect(error).toMatchObject({ code: 'not_found', message: SHARE_UNAVAILABLE_MESSAGE })
    expect(isInvalidShareTokenError(error)).toBe(true)
    expect((await rejection(t.deps.shares.remove(created.id))).code).toBe('not_found')
  })

  it('a master-key rotation changes every token: the old one is not_found, the new one works (ADR-034)', async () => {
    const { t } = await seededApp()
    const created = await t.deps.shares.create({ chatId: CHAT })
    expect((await t.deps.shares.view(tokenOf(created))).title).toBe('Branches')
    swapMasterKey(t.deps.keyring, fakeMasterKey('rotated'), 2)
    const error = await rejection(t.deps.shares.view(tokenOf(created)))
    expect(isInvalidShareTokenError(error)).toBe(true)
    const [renewed] = await t.deps.shares.list({ chatId: CHAT })
    expect(renewed!.id).toBe(created.id)
    expect(renewed!.path).not.toBe(created.path)
    expect(renewed!.path).toBe(`/share/${createShareTokens(t.deps.keyring.subkey('share')).tokenOf(created.id)}`)
    expect((await t.deps.shares.view(tokenOf(renewed!))).title).toBe('Branches')
  })

  it('goes with its chat: deleting the chat removes its links', async () => {
    const { t } = await seededApp()
    const created = await t.deps.shares.create({ chatId: CHAT })
    await t.deps.chats.remove(CHAT)
    expect(await t.deps.shares.list({})).toEqual([])
    expect(isInvalidShareTokenError(await rejection(t.deps.shares.view(tokenOf(created))))).toBe(true)
  })
})

describe('view and openFile (public)', () => {
  it('serves the snapshot with the default options and share file URLs', async () => {
    const { t, pngId } = await seededApp()
    const created = await t.deps.shares.create({ chatId: CHAT })
    const token = tokenOf(created)
    const view = shareViewSchema.parse(await t.deps.shares.view(token))
    expect(view).toEqual({
      title: 'Branches',
      snapshotAt: created.snapshotAt,
      options: { reasoning: false, toolDetails: false, attachments: true },
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'second version' },
            { type: 'file', mediaType: 'image/png', filename: 'dot.png', url: `/api/share/${token}/files/${pngId}` },
          ],
        },
        {
          role: 'assistant',
          modelRef: 'mock:echo',
          parts: [{ type: 'text', text: 'second reply' }, { type: 'tool', toolName: 'web_fetch', status: 'done' }],
        },
      ],
    })
  })

  it('answers the same not_found for a malformed, bad-MAC, unknown, expired or deleted-chat token', async () => {
    let now = Date.now()
    const { t } = await seededApp(() => now)
    const live = await t.deps.shares.create({ chatId: CHAT })
    const expiring = await t.deps.shares.create({ chatId: CHAT, expiresAt: now + 1000 })
    await t.deps.chats.create({ id: chatId(2), title: 'Doomed' })
    const orphan = await t.deps.shares.create({ chatId: chatId(2) })
    // Foreign keys are on, so the cascade removes the row; the chat check still guards a row whose chat is missing.
    await t.database.client.execute('PRAGMA foreign_keys = OFF')
    await t.db.delete(chats).where(eq(chats.id, chatId(2)))
    await t.database.client.execute('PRAGMA foreign_keys = ON')
    expect(await storedRow(t, orphan.id)).toBeDefined()
    now += 1000

    const valid = tokenOf(live)
    const tokens = createShareTokens(createFakeKeyring().subkey('share'))
    const badMac = `${valid.slice(0, 37)}${valid.endsWith('A') ? 'B' : 'A'}`
    const otherKey = createShareTokens(createFakeKeyring('another key').subkey('share')).tokenOf(live.id)
    const unknown = tokens.tokenOf('shr_0000000000000000')
    for (const token of ['', 'short', `${valid}x`, badMac, otherKey, unknown, tokenOf(expiring), tokenOf(orphan)]) {
      const error = await rejection(t.deps.shares.view(token))
      expect(error.toJSON(), token).toEqual({ error: { code: 'not_found', message: SHARE_UNAVAILABLE_MESSAGE } })
      expect(isInvalidShareTokenError(error), token).toBe(true)
      expect(isInvalidShareTokenError(await rejection(t.deps.shares.openFile(token, 'file_0000000000000000')))).toBe(true)
    }
    expect((await t.deps.shares.view(valid)).messages).toHaveLength(2)
  })

  it('serves only the files of the snapshot, and only with attachments', async () => {
    const { t, pngId, notesId } = await seededApp()
    const created = await t.deps.shares.create({ chatId: CHAT })
    const token = tokenOf(created)
    const opened = await t.deps.shares.openFile(token, pngId)
    expect(opened.file).toMatchObject({ id: pngId, mime: 'image/png', name: 'dot.png', size: PNG.byteLength })
    expect(await readAllBytes(opened.stream)).toEqual(PNG)

    // A file of the other version, or of another chat, is not part of the share.
    for (const fileId of [notesId, 'file_0000000000000000']) {
      const error = await rejection(t.deps.shares.openFile(token, fileId))
      expect(error.toJSON()).toEqual({ error: { code: 'not_found', message: SHARE_UNAVAILABLE_MESSAGE } })
      expect(isInvalidShareTokenError(error)).toBe(false)
    }
    await t.deps.shares.update(created.id, { options: { attachments: false } })
    expect(isInvalidShareTokenError(await rejection(t.deps.shares.openFile(token, pngId)))).toBe(false)
    await t.deps.shares.update(created.id, { options: { attachments: true } })
    // A file missing from the store is the same 404.
    await t.database.client.execute({ sql: 'DELETE FROM files WHERE id = ?', args: [pngId] })
    expect((await rejection(t.deps.shares.openFile(token, pngId))).message).toBe(SHARE_UNAVAILABLE_MESSAGE)
  })

  it('writes nothing', async () => {
    const { t, pngId } = await seededApp()
    const created = await t.deps.shares.create({ chatId: CHAT })
    const before = await storedRow(t, created.id)
    await t.deps.shares.view(tokenOf(created))
    await readAllBytes((await t.deps.shares.openFile(tokenOf(created), pngId)).stream)
    await rejection(t.deps.shares.view(`${tokenOf(created).slice(0, 37)}_`))
    expect(await storedRow(t, created.id)).toEqual(before)
  })
})
