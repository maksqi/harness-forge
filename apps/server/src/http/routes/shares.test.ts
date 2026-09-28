// Share link routes (W5.4, API.md 5.20, ARCHITECTURE.md 10.7) on a password server, with the C8 fake of the chats tree
// (`createFakeChatsService`) and the real share and files services.
import type { ShareSummary } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import {
  harnessErrorEnvelopeSchema,
  listResponseSchema,
  shareSummarySchema,
  shareViewSchema,
} from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chatShares } from '../../db/schema.ts'
import { API_CSP } from '../../security/headers.ts'
import { SHARE_UNAVAILABLE_MESSAGE } from '../../services/shares/errors.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeChatsService } from '../../testing/fakes.ts'
import { FRESH_AUTH_REQUIRED_MESSAGE } from '../middleware/fresh-auth.ts'
import { SESSION_COOKIE_NAME, UNAUTHORIZED_MESSAGE } from '../middleware/session-auth.ts'

const PASSWORD = 'correct horse battery staple'
const MINUTE = 60_000
const PNG = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
const shareListSchema = listResponseSchema(shareSummarySchema)

let t: TestApp
let pngId: string
let notesId: string
let addressCounter = 0

function chatId(n: number): string {
  return `0199a8f0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
}

function mid(n: number): string {
  return `msg_${n.toString().padStart(16, '0')}`
}

const CHAT = chatId(1)

/** A client address of its own for each use, so the rate limits of one test never reach another. */
function nextAddress(): string {
  addressCounter += 1
  return `198.51.100.${addressCounter}`
}

async function cookie(authAgeMs = 0): Promise<Record<string, string>> {
  return { cookie: `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() - authAgeMs })}` }
}

function json(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }
}

async function errorOf(response: Response) {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

function tokenOf(summary: ShareSummary): string {
  return summary.path.slice('/share/'.length)
}

/** An anonymous public request (no cookie) from `address`. */
function anonymous(path: string, address: string, init?: RequestInit): Promise<Response> {
  return t.request(path, init, { remoteAddress: address })
}

async function createShare(body: Record<string, unknown> = {}): Promise<ShareSummary> {
  const response = await t.request('/api/shares', json('POST', { chatId: CHAT, ...body }, await cookie()))
  expect(response.status, await response.clone().text()).toBe(201)
  return shareSummarySchema.parse(await response.json())
}

async function shareRows(): Promise<unknown[]> {
  return t.db.select().from(chatShares).orderBy(chatShares.id)
}

beforeAll(async () => {
  t = await createTestApp({ env: { HF_PASSWORD: PASSWORD }, start: false, factories: { chats: createFakeChatsService } })
  pngId = (await t.deps.files.upload(new File([PNG], 'chart.png', { type: 'image/png' }))).id
  notesId = (await t.deps.files.upload(new File(['plain notes\n'], 'notes.txt', { type: 'text/plain' }))).id
  await t.deps.chats.create({
    id: CHAT,
    title: 'Shared chat',
    messages: [
      {
        id: mid(1),
        role: 'user',
        parts: [
          { type: 'text', text: 'Look at these' },
          { type: 'file', mediaType: 'image/png', filename: 'chart.png', url: `/api/files/${pngId}` },
          { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', url: `/api/files/${notesId}` },
        ],
      },
      {
        id: mid(2),
        role: 'assistant',
        metadata: { modelRef: 'mock:echo', startedAt: 1 },
        parts: [
          { type: 'reasoning', text: 'private thoughts', state: 'done' },
          { type: 'text', text: 'Nice chart', state: 'done' },
          { type: 'tool-web_fetch', toolCallId: 'call_1', state: 'output-available', input: { url: 'https://example.com' }, output: { status: 200 } },
        ],
      },
    ],
  })
})

afterAll(async () => {
  await t.close()
})

describe('owner routes', () => {
  it('answer 401 without a session', async () => {
    for (const [method, path, body] of [
      ['GET', '/api/shares', undefined],
      ['GET', `/api/shares?chatId=${CHAT}`, undefined],
      ['POST', '/api/shares', { chatId: CHAT }],
      ['PATCH', '/api/shares/shr_0000000000000001', { refresh: true }],
      ['DELETE', '/api/shares/shr_0000000000000001', undefined],
    ] as const) {
      const response = await t.request(path, body === undefined ? { method } : json(method, body))
      expect(response.status, `${method} ${path}`).toBe(401)
      expect(await errorOf(response)).toEqual({ code: 'unauthorized', message: UNAUTHORIZED_MESSAGE, action: 'login' })
    }
    expect(await shareRows()).toEqual([])
  })

  it('create and update need fresh auth; list and remove do not', async () => {
    const stale = await cookie(11 * MINUTE)
    const refused = await t.request('/api/shares', json('POST', { chatId: CHAT }, stale))
    expect(refused.status).toBe(403)
    expect(await errorOf(refused)).toEqual({ code: 'forbidden', message: FRESH_AUTH_REQUIRED_MESSAGE, action: 'login' })
    expect(await shareRows()).toEqual([])

    const created = await createShare()
    const patch = await t.request(`/api/shares/${created.id}`, json('PATCH', { title: 'Stale' }, stale))
    expect(patch.status).toBe(403)
    expect((await t.deps.shares.list({}))[0]?.title).toBeNull()

    const list = await t.request('/api/shares', { headers: stale })
    expect(list.status).toBe(200)
    expect(shareListSchema.parse(await list.json()).items.map(share => share.id)).toEqual([created.id])
    const removed = await t.request(`/api/shares/${created.id}`, { method: 'DELETE', headers: stale })
    expect(removed.status).toBe(204)
    expect(await shareRows()).toEqual([])
  })

  it('create, list, update and revoke a link; the token never changes', async () => {
    const created = await createShare({ title: 'Team link', options: { reasoning: true }, expiresAt: Date.now() + 7 * 24 * 60 * MINUTE })
    expect(created).toMatchObject({ chatId: CHAT, chatTitle: 'Shared chat', title: 'Team link', options: { reasoning: true, toolDetails: false, attachments: true }, messageCount: 2, outdated: false, expired: false })
    const headers = await cookie()

    const listed = shareListSchema.parse(await (await t.request(`/api/shares?chatId=${CHAT}`, { headers })).json())
    expect(listed.items).toEqual([created])
    expect(shareListSchema.parse(await (await t.request(`/api/shares?chatId=${chatId(9)}`, { headers })).json()).items).toEqual([])

    const optionsChanged = await t.request(`/api/shares/${created.id}`, json('PATCH', { options: { toolDetails: true } }, headers))
    expect(optionsChanged.status).toBe(200)
    expect(shareSummarySchema.parse(await optionsChanged.json())).toMatchObject({ path: created.path, options: { reasoning: true, toolDetails: true, attachments: true } })
    const refreshed = await t.request(`/api/shares/${created.id}`, json('PATCH', { refresh: true, title: null, expiresAt: null }, headers))
    expect(shareSummarySchema.parse(await refreshed.json())).toMatchObject({ id: created.id, path: created.path, title: null, expiresAt: null })

    const address = nextAddress()
    expect((await anonymous(`/api${created.path}`, address)).status).toBe(200)
    const removed = await t.request(`/api/shares/${created.id}`, { method: 'DELETE', headers })
    expect(removed.status).toBe(204)
    expect(await removed.text()).toBe('')
    const gone = await anonymous(`/api${created.path}`, address)
    expect(gone.status).toBe(404)
    expect(await errorOf(gone)).toEqual({ code: 'not_found', message: SHARE_UNAVAILABLE_MESSAGE })
  })

  it('validates bodies, params and queries, and answers 404 for unknown shares and chats', async () => {
    const headers = await cookie()
    const cases: Array<[RequestInit & { path?: string }, string, number]> = [
      [json('POST', { chatId: CHAT, extra: true }, headers), '/api/shares', 400],
      [json('POST', { chatId: 'not-a-chat' }, headers), '/api/shares', 400],
      [json('POST', { chatId: CHAT, options: { unknown: true } }, headers), '/api/shares', 400],
      [json('POST', { chatId: CHAT, expiresAt: Date.now() - 1 }, headers), '/api/shares', 400],
      [json('POST', { chatId: CHAT, expiresAt: Date.now() + 366 * 24 * 60 * MINUTE }, headers), '/api/shares', 400],
      [json('POST', { chatId: chatId(9) }, headers), '/api/shares', 404],
      [json('PATCH', {}, headers), '/api/shares/shr_0000000000000001', 400],
      [json('PATCH', { refresh: false }, headers), '/api/shares/shr_0000000000000001', 400],
      [json('PATCH', { title: 'x' }, headers), '/api/shares/not-a-share', 400],
      [json('PATCH', { title: 'x' }, headers), '/api/shares/shr_0000000000000001', 404],
      [{ method: 'DELETE', headers }, '/api/shares/shr_0000000000000001', 404],
      [{ method: 'GET', headers }, '/api/shares?chatId=nope', 400],
    ]
    for (const [init, path, status] of cases) {
      const response = await t.request(path, init)
      expect(response.status, `${init.method} ${path} ${String(init.body)}`).toBe(status)
    }
    expect(await shareRows()).toEqual([])
  })

  it('refuses a 21st link for one chat with 400', async () => {
    const created: ShareSummary[] = []
    for (let index = 0; index < 20; index++)
      created.push(await t.deps.shares.create({ chatId: CHAT }))
    const response = await t.request('/api/shares', json('POST', { chatId: CHAT }, await cookie()))
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toMatchObject({ code: 'validation_error' })
    for (const share of created)
      await t.deps.shares.remove(share.id)
  })
})

describe('public view', () => {
  it('serves the snapshot anonymously on a password server, with the default options', async () => {
    const share = await createShare()
    const token = tokenOf(share)
    const response = await anonymous(`/api/share/${token}`, nextAddress())
    expect(response.status).toBe(200)
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toBe(API_CSP)
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('set-cookie')).toBeNull()
    const view = shareViewSchema.parse(await response.json())
    expect(view).toEqual({
      title: 'Shared chat',
      snapshotAt: share.snapshotAt,
      options: { reasoning: false, toolDetails: false, attachments: true },
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'Look at these' },
            { type: 'file', mediaType: 'image/png', filename: 'chart.png', url: `/api/share/${token}/files/${pngId}` },
            { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', url: `/api/share/${token}/files/${notesId}` },
          ],
        },
        { role: 'assistant', modelRef: 'mock:echo', parts: [{ type: 'text', text: 'Nice chart' }, { type: 'tool', toolName: 'web_fetch', status: 'done' }] },
      ],
    })
    // The rest of the API stays closed.
    expect((await anonymous('/api/chats', nextAddress())).status).toBe(401)
    expect((await anonymous(`/api/files/${pngId}`, nextAddress())).status).toBe(401)
    await t.deps.shares.remove(share.id)
  })

  it('applies changed options to the next request, without a new snapshot', async () => {
    const share = await createShare()
    const address = nextAddress()
    const path = `/api/share/${tokenOf(share)}`
    const patch = async (options: Record<string, boolean>): Promise<void> => {
      expect((await t.request(`/api/shares/${share.id}`, json('PATCH', { options }, await cookie()))).status).toBe(200)
    }

    await patch({ reasoning: true, toolDetails: true })
    const detailed = shareViewSchema.parse(await (await anonymous(path, address)).json())
    expect(detailed.options).toEqual({ reasoning: true, toolDetails: true, attachments: true })
    expect(detailed.messages[1]?.parts).toEqual([
      { type: 'reasoning', text: 'private thoughts' },
      { type: 'text', text: 'Nice chart' },
      { type: 'tool', toolName: 'web_fetch', status: 'done', input: { url: 'https://example.com' }, output: { status: 200 } },
    ])
    const fileUrl = `/api/share/${tokenOf(share)}/files/${pngId}`
    expect((await anonymous(fileUrl, address)).status).toBe(200)

    await patch({ reasoning: false, toolDetails: false, attachments: false })
    const plain = shareViewSchema.parse(await (await anonymous(path, address)).json())
    expect(plain.messages[0]?.parts).toEqual([{ type: 'text', text: 'Look at these' }])
    expect(JSON.stringify(plain)).not.toContain('private thoughts')
    expect(JSON.stringify(plain)).not.toContain('example.com')
    expect((await anonymous(fileUrl, address)).status).toBe(404)
    expect((await t.deps.shares.list({}))[0]?.snapshotAt).toBe(share.snapshotAt)
    await t.deps.shares.remove(share.id)
  })

  it('answers the same 404 for a malformed, bad-MAC, revoked, expired or deleted-chat token', async () => {
    const live = await createShare()
    const revoked = await createShare()
    await t.deps.shares.remove(revoked.id)
    const expiring = await t.deps.shares.create({ chatId: CHAT, expiresAt: Date.now() + MINUTE })
    await t.db.update(chatShares).set({ expiresAt: Date.now() - 1 }).where(eq(chatShares.id, expiring.id))
    await t.deps.chats.create({ id: chatId(2), title: 'Short-lived', messages: [{ id: mid(9), role: 'user', parts: [{ type: 'text', text: 'bye' }] }] })
    const orphan = await t.deps.shares.create({ chatId: chatId(2) })
    const response = await t.request(`/api/chats/${chatId(2)}`, { method: 'DELETE', headers: await cookie() })
    expect(response.status).toBe(204)

    const valid = tokenOf(live)
    const tokens = [
      'short',
      `${valid}A`,
      `${valid.slice(0, 20)}!${valid.slice(21)}`,
      `${valid.slice(0, 37)}${valid.endsWith('A') ? 'B' : 'A'}`,
      tokenOf(revoked),
      tokenOf(expiring),
      tokenOf(orphan),
    ]
    const bodies = new Set<string>()
    for (const token of tokens) {
      for (const path of [`/api/share/${encodeURIComponent(token)}`, `/api/share/${encodeURIComponent(token)}/files/${pngId}`]) {
        const failed = await anonymous(path, nextAddress())
        expect(failed.status, path).toBe(404)
        expect(failed.headers.get('cache-control')).toBe('no-store')
        bodies.add(await failed.text())
      }
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: { code: 'not_found', message: SHARE_UNAVAILABLE_MESSAGE } })])
    expect((await anonymous(`/api/share/${valid}`, nextAddress())).status).toBe(200)
    await t.deps.shares.remove(live.id)
    await t.deps.shares.remove(expiring.id)
  })

  it('never answers without a password on a foreign host (DNS rebinding guard), even for a valid token', async () => {
    const open = await createTestApp({ start: false, factories: { chats: createFakeChatsService } })
    try {
      await open.deps.chats.create({ id: CHAT, title: 'Local', messages: [{ id: mid(1), role: 'user', parts: [{ type: 'text', text: 'hi' }] }] })
      const share = await open.deps.shares.create({ chatId: CHAT })
      const path = `/api/share/${tokenOf(share)}`
      const foreign = await open.request(path, { headers: { host: 'evil.example' } })
      expect(foreign.status).toBe(403)
      expect((await errorOf(foreign)).code).toBe('forbidden')
      expect((await open.request(path, { headers: { host: 'localhost:8787' } })).status).toBe(200)
    }
    finally {
      await open.close()
    }
  })
})

describe('public files', () => {
  it('serve the files of the share with the download headers, no-store and no ETag; HEAD too', async () => {
    const share = await createShare()
    const address = nextAddress()
    const image = await anonymous(`/api/share/${tokenOf(share)}/files/${pngId}`, address)
    expect(image.status).toBe(200)
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG)
    expect(Object.fromEntries(['content-type', 'content-length', 'cache-control', 'x-content-type-options', 'content-security-policy', 'content-disposition', 'etag', 'x-robots-tag'].map(name => [name, image.headers.get(name)]))).toEqual({
      'content-type': 'image/png',
      'content-length': String(PNG.byteLength),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'default-src \'none\'; style-src \'unsafe-inline\'; sandbox',
      'content-disposition': 'inline; filename="chart.png"; filename*=UTF-8\'\'chart.png',
      'etag': null,
      'x-robots-tag': 'noindex, nofollow',
    })

    const text = await anonymous(`/api/share/${tokenOf(share)}/files/${notesId}`, address)
    expect(text.status).toBe(200)
    expect(await text.text()).toBe('plain notes\n')
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(text.headers.get('content-disposition')).toMatch(/^attachment; /)

    const head = await anonymous(`/api/share/${tokenOf(share)}/files/${pngId}`, address, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(PNG.byteLength))
    expect(head.headers.get('cache-control')).toBe('no-store')
    expect(await head.text()).toBe('')
    await t.deps.shares.remove(share.id)
  })

  it('serve nothing outside the share: other files, malformed ids, the session-only file route', async () => {
    const share = await createShare()
    const other = (await t.deps.files.upload(new File([PNG], 'other.png', { type: 'image/png' }))).id
    const address = nextAddress()
    for (const fileId of [other, 'file_0000000000000000', 'not-a-file', '..%2F..%2Fchats']) {
      const response = await anonymous(`/api/share/${tokenOf(share)}/files/${fileId}`, address)
      expect(response.status, fileId).toBe(404)
      expect(await errorOf(response)).toEqual({ code: 'not_found', message: SHARE_UNAVAILABLE_MESSAGE })
    }
    // File failures are not token failures: they never lock the visitor out.
    for (let index = 0; index < 25; index++)
      expect((await anonymous(`/api/share/${tokenOf(share)}/files/${other}`, address)).status).toBe(404)
    expect((await anonymous(`/api/share/${tokenOf(share)}`, address)).status).toBe(200)
    await t.deps.shares.remove(share.id)
  })
})

describe('rate limits', () => {
  it('views: 60 per minute per address, then 429 with Retry-After', async () => {
    const share = await createShare()
    const address = nextAddress()
    const path = `/api/share/${tokenOf(share)}`
    for (let index = 0; index < 60; index++)
      expect((await anonymous(path, address)).status, `view ${index + 1}`).toBe(200)
    const limited = await anonymous(path, address)
    expect(limited.status).toBe(429)
    const retryAfter = Number(limited.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)
    expect(await errorOf(limited)).toMatchObject({ code: 'rate_limited', action: 'retry', retryAfterMs: expect.any(Number) })
    // Another address and the file route keep their own budgets.
    expect((await anonymous(path, nextAddress())).status).toBe(200)
    expect((await anonymous(`${path}/files/${pngId}`, address)).status).toBe(200)
    await t.deps.shares.remove(share.id)
  })

  it('invalid tokens: 20 per 10 minutes per address, then every share request of the address is refused', async () => {
    const share = await createShare()
    const valid = tokenOf(share)
    const guess = `${valid.slice(0, 37)}${valid.endsWith('A') ? 'B' : 'A'}`
    const address = nextAddress()
    for (let index = 0; index < 20; index++) {
      const path = index % 2 === 0 ? `/api/share/${guess}` : `/api/share/${guess}/files/${pngId}`
      expect((await anonymous(path, address)).status, `guess ${index + 1}`).toBe(404)
    }
    for (const path of [`/api/share/${guess}`, `/api/share/${valid}`, `/api/share/${valid}/files/${pngId}`]) {
      const limited = await anonymous(path, address)
      expect(limited.status, path).toBe(429)
      const retryAfter = Number(limited.headers.get('retry-after'))
      expect(retryAfter).toBeGreaterThan(9 * 60)
      expect(retryAfter).toBeLessThanOrEqual(10 * 60)
    }
    expect((await anonymous(`/api/share/${valid}`, nextAddress())).status).toBe(200)
    await t.deps.shares.remove(share.id)
  })
})

describe('public routes write nothing', () => {
  it('views, file downloads and failures leave the stored shares unchanged', async () => {
    const share = await createShare()
    const before = await shareRows()
    const address = nextAddress()
    await anonymous(`/api/share/${tokenOf(share)}`, address)
    await anonymous(`/api/share/${tokenOf(share)}/files/${pngId}`, address)
    await anonymous(`/api/share/${tokenOf(share)}/files/${pngId}`, address, { method: 'HEAD' })
    await anonymous(`/api/share/${tokenOf(share).slice(0, 37)}_`, address)
    expect(await shareRows()).toEqual(before)
    await t.deps.shares.remove(share.id)
  })
})
