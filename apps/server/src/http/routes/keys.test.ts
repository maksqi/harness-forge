// Master-key routes (W7.7-T4, API.md 5.23, ARCHITECTURE.md 6.14): `GET /keys` and the online rotation over the real
// keyring (`secret.key` in the temp data directory). Covers the B8 route list: 401 / 403 without a (fresh) session, 409
// `env-key` / `key-mismatch` / `busy`, exactly one valid `Set-Cookie` keeping `authAt`, the old cookie 401, the old
// share URL 404 and the new one 200, open approvals denied and the pending flags cleared, `key.rotated` emitted and the
// event streams closed, `POST /chat` 409 while the rotation blocks runs, and no key text in the logs.
import type { HarnessUIMessagePart, KeyRotationResult, KeyStatus } from '@harness-forge/shared'
import type { TestApp, TestAppOptions } from '../../testing/create-test-app.ts'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import process from 'node:process'
import { authStatusSchema, harnessErrorEnvelopeSchema, keyRotationResultSchema, keyStatusSchema, serverEventSchema } from '@harness-forge/shared'
import { eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatBody } from '../../chat/testing.ts'
import { chats, messages, secrets, settings } from '../../db/schema.ts'
import { createKeyring, deriveSubkey, encodeMasterKey, readMasterKeyFile } from '../../security/keyring.ts'
import { keyCheckOfMasterKey } from '../../services/keys/check.ts'
import { createKeyService, ENV_KEY_MESSAGE, KEY_MISMATCH_MESSAGE } from '../../services/keys/index.ts'
import { nextKeyPath } from '../../services/keys/recover.ts'
import { KEY_ROTATION_DENIAL_REASON, KEY_STATE_SETTING } from '../../services/keys/types.ts'
import { KEY_ROTATION_RUNS_MESSAGE, MAINTENANCE_BUSY_MESSAGE } from '../../services/maintenance/index.ts'
import { decryptSecret, encryptSecret, secretAad } from '../../services/secrets/crypto.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { FRESH_AUTH_REQUIRED_MESSAGE } from '../middleware/fresh-auth.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'
import { FRESH_AUTH_WINDOW_MS } from '../types.ts'

const PASSWORD = 'correct horse battery staple'
const CHAT = '0199a8f0-0000-7000-8000-00000000c001'
const OTHER_CHAT = '0199a8f0-0000-7000-8000-00000000c002'

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

async function testApp(options: TestAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp({
    start: false,
    ...options,
    factories: { keyring: createKeyring, ...options.factories },
    env: { HF_PASSWORD: PASSWORD, ...options.env },
  })
  apps.push(t)
  return t
}

async function cookie(t: TestApp, authAgeMs = 60_000): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt: Date.now() - authAgeMs })}`
}

function rotate(t: TestApp, sessionCookie?: string, body: unknown = { confirm: 'ROTATE' }): Promise<Response> {
  return t.request('/api/keys/rotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sessionCookie === undefined ? {} : { cookie: sessionCookie }) },
    body: JSON.stringify(body),
  })
}

async function errorOf(response: Response) {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

function sessionCookies(response: Response): string[] {
  return response.headers.getSetCookie().filter(value => value.startsWith(`${SESSION_COOKIE_NAME}=`))
}

function keyText(t: TestApp): string {
  return readFileSync(t.env.paths.secretKey, 'utf8').trim()
}

/** A chat with a user message and an assistant message waiting for a tool approval (pending flag set). */
async function seedPendingApproval(t: TestApp, chatId: string = CHAT): Promise<void> {
  await t.deps.chats.create({ id: chatId, title: 'Pending' })
  const parts = [
    { type: 'step-start' },
    { type: 'tool-web_fetch', toolCallId: 'call_open', state: 'approval-requested', input: { url: 'https://example.com' }, approval: { id: 'apr_1' } },
    { type: 'tool-current_time', toolCallId: 'call_done', state: 'output-available', input: {}, output: { now: 'x' } },
  ] as unknown as HarnessUIMessagePart[]
  await t.db.insert(messages).values([
    { id: 'msg_user000000000001', chatId, parentId: null, seq: 0, role: 'user', parts: [{ type: 'text', text: 'fetch it' }], searchText: 'fetch it' },
    { id: 'msg_asst000000000001', chatId, parentId: 'msg_user000000000001', seq: 1, role: 'assistant', parts, searchText: '' },
  ])
  await t.db.update(chats).set({ activeLeafId: 'msg_asst000000000001', pendingApproval: true }).where(eq(chats.id, chatId))
}

async function partsOf(t: TestApp, id: string): Promise<Record<string, unknown>[]> {
  const [row] = await t.db.select({ parts: messages.parts }).from(messages).where(eq(messages.id, id))
  return row?.parts as unknown as Record<string, unknown>[]
}

/** Reads a `text/event-stream` body frame by frame. */
function frameReader(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async next(): Promise<string | null> {
      for (;;) {
        const end = buffer.indexOf('\n\n')
        if (end !== -1) {
          const frame = buffer.slice(0, end + 2)
          buffer = buffer.slice(end + 2)
          return frame
        }
        const { done, value } = await reader.read()
        if (done)
          return null
        buffer += decoder.decode(value, { stream: true })
      }
    },
  }
}

describe('gET /api/keys', () => {
  it('reports the key state of a key file: source file, version 1, check ok, counts, canRotate', async () => {
    const t = await testApp()
    await t.deps.secrets.set('provider:openai', 'apiKey', 'sk-test-openai-0001')
    await seedPendingApproval(t)
    const response = await t.request('/api/keys', { headers: { cookie: await cookie(t) } })
    expect(response.status).toBe(200)
    const status = keyStatusSchema.parse(await response.json())
    expect(status).toEqual({
      source: 'file',
      keyVersion: 1,
      rotatedAt: null,
      keyCheck: 'ok',
      secrets: 1,
      unreadableSecrets: 0,
      shares: 0,
      pendingApprovals: 1,
      canRotate: true,
    } satisfies KeyStatus)
    // GET is read-only: without a boot recovery (createTestApp) the check is computed in memory, never written.
    const [row] = await t.db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY_STATE_SETTING))
    expect(row).toBeUndefined()
    expect(JSON.stringify(status)).not.toContain(keyText(t))
  })

  it('needs a session (401) but not fresh auth', async () => {
    const t = await testApp()
    expect((await t.request('/api/keys')).status).toBe(401)
    expect((await t.request('/api/keys', { headers: { cookie: await cookie(t, FRESH_AUTH_WINDOW_MS + 60_000) } })).status).toBe(200)
  })

  it('env mode: a key that fails the stored check is a mismatch and cannot rotate', async () => {
    const t = await testApp({ env: { HF_MASTER_KEY: encodeMasterKey(randomBytes(32)) } })
    await t.db.insert(settings).values({ key: KEY_STATE_SETTING, value: { version: 1, check: keyCheckOfMasterKey(randomBytes(32)), rotatedAt: null } })
    const status = keyStatusSchema.parse(await (await t.request('/api/keys', { headers: { cookie: await cookie(t) } })).json())
    expect(status).toMatchObject({ source: 'env', keyCheck: 'mismatch', canRotate: false })
  })

  it('unknown when no check is stored and no secret decrypts; unreadable rows are counted', async () => {
    const t = await testApp()
    const other = deriveSubkey(randomBytes(32), 'encryption')
    await t.db.insert(secrets).values({ scope: 'provider:openai', name: 'apiKey', ciphertext: encryptSecret(other, secretAad('provider:openai', 'apiKey'), 'sk-x'), hint: null, keyVersion: 1 })
    const status = keyStatusSchema.parse(await (await t.request('/api/keys', { headers: { cookie: await cookie(t) } })).json())
    expect(status).toMatchObject({ keyCheck: 'unknown', secrets: 1, unreadableSecrets: 1, canRotate: false })
    const [row] = await t.db.select().from(settings).where(eq(settings.key, KEY_STATE_SETTING))
    expect(row).toBeUndefined()
  })
})

describe('pOST /api/keys/rotate: refusals', () => {
  it('401 without a session, 403 without fresh auth (nothing changes)', async () => {
    const t = await testApp()
    const before = keyText(t)
    expect((await rotate(t)).status).toBe(401)
    const stale = await rotate(t, await cookie(t, FRESH_AUTH_WINDOW_MS + 60_000))
    expect(stale.status).toBe(403)
    expect(await errorOf(stale)).toEqual({ code: 'forbidden', message: FRESH_AUTH_REQUIRED_MESSAGE, action: 'login' })
    expect(keyText(t)).toBe(before)
    expect(t.deps.keyring.keyVersion).toBe(1)
  })

  it('400 without the typed confirmation', async () => {
    const t = await testApp()
    for (const body of [{}, { confirm: 'rotate' }, { confirm: 'ROTATE', extra: 1 }])
      expect((await rotate(t, await cookie(t), body)).status).toBe(400)
  })

  it('409 env-key when the key comes from HF_MASTER_KEY', async () => {
    const t = await testApp({ env: { HF_MASTER_KEY: encodeMasterKey(randomBytes(32)) } })
    const response = await rotate(t, await cookie(t))
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toEqual({ code: 'conflict', message: ENV_KEY_MESSAGE, details: { reason: 'env-key' } })
  })

  it('409 key-mismatch when the key in use fails the stored check', async () => {
    const t = await testApp()
    await t.db.insert(settings).values({ key: KEY_STATE_SETTING, value: { version: 1, check: keyCheckOfMasterKey(randomBytes(32)), rotatedAt: null } })
    const response = await rotate(t, await cookie(t))
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toEqual({ code: 'conflict', message: KEY_MISMATCH_MESSAGE, details: { reason: 'key-mismatch' } })
    expect(existsSync(nextKeyPath(t.env))).toBe(false)
  })

  it('409 busy while another maintenance operation runs', async () => {
    const t = await testApp()
    let finish!: () => void
    const held = t.deps.maintenance.exclusive('import', () => new Promise<void>((resolve) => {
      finish = resolve
    }))
    const response = await rotate(t, await cookie(t))
    expect(response.status).toBe(409)
    expect(await errorOf(response)).toEqual({ code: 'conflict', message: MAINTENANCE_BUSY_MESSAGE, details: { reason: 'busy' } })
    finish()
    await held
    expect(t.deps.keyring.keyVersion).toBe(1)
  })
})

describe('pOST /api/keys/rotate', () => {
  it('rotates: one new cookie keeping authAt, old cookie 401, secrets on the new key, approvals denied, no key text logged', async () => {
    const t = await testApp()
    await t.deps.secrets.set('provider:openai', 'apiKey', 'sk-test-openai-0001')
    const stranger = deriveSubkey(randomBytes(32), 'encryption')
    await t.db.insert(secrets).values({ scope: 'mcp:web', name: 'header.X', ciphertext: encryptSecret(stranger, secretAad('mcp:web', 'header.X'), 'v'), hint: 'h', keyVersion: 1 })
    await seedPendingApproval(t)
    await t.deps.chats.create({ id: OTHER_CHAT, title: 'Shared', messages: [
      { id: 'msg_share00000000001', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      { id: 'msg_share00000000002', role: 'assistant', parts: [{ type: 'text', text: 'hi', state: 'done' }] },
    ] })
    const share = await t.deps.shares.create({ chatId: OTHER_CHAT })
    const oldShareToken = share.path.slice('/share/'.length)
    const oldKeyText = keyText(t)
    const authAt = Date.now() - 120_000
    const oldCookie = `${SESSION_COOKIE_NAME}=${await t.deps.sessions.issue({ authAt })}`

    const response = await rotate(t, oldCookie)
    expect(response.status).toBe(200)
    const result = keyRotationResultSchema.parse(await response.json())
    expect(result).toMatchObject({
      keyVersion: 2,
      secrets: 1,
      skippedSecrets: 1,
      shares: 1,
      approvalsExpired: 1,
      chats: 1,
      runsStopped: 0,
    } satisfies Partial<KeyRotationResult>)

    // Exactly one valid Set-Cookie, keeping authAt (still fresh).
    const set = sessionCookies(response)
    expect(set).toHaveLength(1)
    const newCookie = set[0]!.split(';')[0]!
    const status = authStatusSchema.parse(await (await t.request('/api/auth/status', { headers: { cookie: newCookie } })).json())
    expect(status).toMatchObject({ authenticated: true, freshUntil: authAt + FRESH_AUTH_WINDOW_MS })
    // The old cookie is dead.
    expect((await t.request('/api/keys', { headers: { cookie: oldCookie } })).status).toBe(401)

    // The key file holds the new key (0600); no .next is left; the live keyring moved to version 2.
    const newKeyText = keyText(t)
    expect(newKeyText).not.toBe(oldKeyText)
    expect(existsSync(nextKeyPath(t.env))).toBe(false)
    if (process.platform !== 'win32')
      expect(statSync(t.env.paths.secretKey).mode & 0o777).toBe(0o600)
    expect(t.deps.keyring.keyVersion).toBe(2)
    const versions = await t.db.select({ scope: secrets.scope, keyVersion: secrets.keyVersion }).from(secrets).orderBy(secrets.scope)
    expect(versions).toEqual([{ scope: 'mcp:web', keyVersion: 1 }, { scope: 'provider:openai', keyVersion: 2 }])
    expect(await t.deps.secrets.get('provider:openai', 'apiKey')).toBe('sk-test-openai-0001')
    const [row] = await t.db.select().from(secrets).where(eq(secrets.scope, 'provider:openai'))
    expect(decryptSecret(deriveSubkey(readMasterKeyFile(t.env.paths.secretKey)!, 'encryption'), secretAad('provider:openai', 'apiKey'), row!.ciphertext)).toBe('sk-test-openai-0001')
    expect(row!.hint).not.toBeNull()

    // The share URL changed: the old token is 404, the new one 200.
    expect((await t.request(`/api/share/${oldShareToken}`)).status).toBe(404)
    const [renewed] = await t.deps.shares.list({ chatId: OTHER_CHAT })
    expect(renewed!.path).not.toBe(share.path)
    expect((await t.request(`/api/share/${renewed!.path.slice('/share/'.length)}`)).status).toBe(200)

    // The open approval is denied, the finished call untouched, the flag cleared.
    const parts = await partsOf(t, 'msg_asst000000000001')
    expect(parts[1]).toMatchObject({ state: 'output-denied', approval: { id: 'apr_1', approved: false, reason: KEY_ROTATION_DENIAL_REASON } })
    expect(parts[2]).toMatchObject({ state: 'output-available' })
    const [chat] = await t.db.select({ pending: chats.pendingApproval }).from(chats).where(eq(chats.id, CHAT))
    expect(chat?.pending).toBe(false)
    const [state] = await t.db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY_STATE_SETTING))
    expect(state?.value).toEqual({ version: 2, check: keyCheckOfMasterKey(readMasterKeyFile(t.env.paths.secretKey)!), rotatedAt: result.rotatedAt })

    // GET /keys follows.
    const after = keyStatusSchema.parse(await (await t.request('/api/keys', { headers: { cookie: newCookie } })).json())
    expect(after).toMatchObject({ keyVersion: 2, rotatedAt: result.rotatedAt, keyCheck: 'ok', secrets: 2, unreadableSecrets: 1, pendingApprovals: 0 })

    // One info line with the counts; never the key text.
    expect(t.logs.records.find(record => record.msg === 'master key rotated')).toMatchObject({ level: 'info', keyVersion: 2, secrets: 1, renamed: true })
    const logged = t.logs.text()
    expect(logged).not.toContain(oldKeyText)
    expect(logged).not.toContain(newKeyText)
    expect(JSON.stringify(result)).not.toContain(newKeyText)
  })

  it('emits key.rotated with the touched chats, then closes every event stream', async () => {
    const t = await testApp()
    await seedPendingApproval(t)
    const sessionCookie = await cookie(t)
    const frames = frameReader(await t.request('/api/events', { headers: { cookie: sessionCookie } }))
    expect(await frames.next()).toMatch(/^retry:/)
    await vi.waitFor(() => expect(t.deps.events.subscriberCount()).toBeGreaterThan(0))

    const response = await rotate(t, sessionCookie)
    expect(response.status).toBe(200)
    const result = keyRotationResultSchema.parse(await response.json())
    const events: unknown[] = []
    for (let frame = await frames.next(); frame !== null; frame = await frames.next()) {
      const line = frame.split('\n').find(entry => entry.startsWith('data: '))
      if (line !== undefined)
        events.push(serverEventSchema.parse(JSON.parse(line.slice('data: '.length))))
    }
    expect(events).toContainEqual(expect.objectContaining({
      type: 'key.rotated',
      data: { keyVersion: 2, rotatedAt: result.rotatedAt, chatIds: [CHAT] },
    }))
    // The stream ended after the event.
    expect(t.deps.events.subscriberCount()).toBe(0)
  })

  it('without a password: no cookie is set', async () => {
    const t = await testApp({ env: { HF_PASSWORD: undefined } })
    const response = await rotate(t)
    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(t.deps.keyring.keyVersion).toBe(2)
  })

  it('a second rotation works on top of the first (version 3)', async () => {
    const t = await testApp()
    await t.deps.secrets.set('provider:openai', 'apiKey', 'sk-test-openai-0001')
    const first = await rotate(t, await cookie(t))
    const next = sessionCookies(first)[0]!.split(';')[0]!
    const second = await rotate(t, next)
    expect(second.status).toBe(200)
    expect(keyRotationResultSchema.parse(await second.json())).toMatchObject({ keyVersion: 3, secrets: 1, skippedSecrets: 0 })
    expect(await t.deps.secrets.get('provider:openai', 'apiKey')).toBe('sk-test-openai-0001')
    const rows = await t.db.select({ version: sql<number>`DISTINCT ${secrets.keyVersion}` }).from(secrets)
    expect(rows.map(row => Number(row.version))).toEqual([3])
  })

  it('pOST /chat answers 409 busy while the rotation blocks runs; a secret write waits and uses the new key', async () => {
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached!: () => void
    const atStep = new Promise<void>((resolve) => {
      reached = resolve
    })
    const t = await testApp({
      env: { HF_MOCK_PROVIDER: '1' },
      factories: {
        keys: deps => createKeyService(deps, {
          onStep: async (step) => {
            if (step === 'next-written') {
              reached()
              await paused
            }
          },
        }),
      },
    })
    const sessionCookie = await cookie(t)
    const rotation = rotate(t, sessionCookie)
    await atStep

    const refused = await t.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cookie': sessionCookie },
      body: JSON.stringify(chatBody('0199a8f0-0000-7000-8000-00000000c003', 'hello during rotation')),
    })
    expect(refused.status).toBe(409)
    expect(await errorOf(refused)).toEqual({ code: 'conflict', message: KEY_ROTATION_RUNS_MESSAGE, details: { reason: 'busy' } })

    let written = false
    const write = t.deps.secrets.set('provider:openai', 'apiKey', 'sk-written-during-rotation').then(() => {
      written = true
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(written).toBe(false)

    release()
    expect((await rotation).status).toBe(200)
    await write
    const [row] = await t.db.select().from(secrets).where(eq(secrets.scope, 'provider:openai'))
    expect(row?.keyVersion).toBe(2)
    expect(await t.deps.secrets.get('provider:openai', 'apiKey')).toBe('sk-written-during-rotation')
  })

  it('a failed transaction changes nothing: old key, no .next, the lock and the key change released', async () => {
    const t = await testApp({
      factories: {
        keys: deps => createKeyService(deps, {
          onStep: (step) => {
            if (step === 'transaction')
              throw new Error('injected transaction failure')
          },
        }),
      },
    })
    await t.deps.secrets.set('provider:openai', 'apiKey', 'sk-test-openai-0001')
    await seedPendingApproval(t)
    const before = keyText(t)
    const sessionCookie = await cookie(t)
    const response = await rotate(t, sessionCookie)
    expect(response.status).toBe(500)
    expect(keyText(t)).toBe(before)
    expect(existsSync(nextKeyPath(t.env))).toBe(false)
    expect(t.deps.keyring.keyVersion).toBe(1)
    expect(t.deps.maintenance.current()).toBeNull()
    expect(await t.deps.secrets.get('provider:openai', 'apiKey')).toBe('sk-test-openai-0001')
    expect((await partsOf(t, 'msg_asst000000000001'))[1]).toMatchObject({ state: 'approval-requested' })
    // The old session still works.
    expect((await t.request('/api/keys', { headers: { cookie: sessionCookie } })).status).toBe(200)
  })
})
