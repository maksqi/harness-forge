// Key service (C16-T3, W7.7-T4): the key check (ARCHITECTURE.md 6.14), the `_keys` shape, and the service rules the
// route tests (`http/routes/keys.test.ts`) do not reach: the order of the checks, stopped runs, an unrotatable keyring,
// the redactor.
import { Buffer } from 'node:buffer'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { HarnessError } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createKeyring, createMasterKeyring, deriveSubkey, encodeMasterKey, swapMasterKey } from '../../security/keyring.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeChatRunner, createRecordingEventBus } from '../../testing/fakes.ts'
import { keyCheckOf, keyCheckOfMasterKey, keyCheckOfSubkey, parseKeyState, sameKeyCheck } from './check.ts'
import { nextKeyPath } from './recover.ts'
import { KEY_CHECK_INFO } from './types.ts'

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0))
    await close()
})

describe('key check', () => {
  it('is base64url(HMAC-SHA256(encryption subkey, harness-forge/key-check/v1))', () => {
    const master = Uint8Array.from({ length: 32 }, (_value, index) => index)
    const expected = createHmac('sha256', deriveSubkey(master, 'encryption')).update('harness-forge/key-check/v1').digest('base64url')
    expect(KEY_CHECK_INFO).toBe('harness-forge/key-check/v1')
    expect(keyCheckOfMasterKey(master)).toBe(expected)
    expect(keyCheckOfSubkey(deriveSubkey(master, 'encryption'))).toBe(expected)
    expect(keyCheckOf(createMasterKeyring(master))).toBe(expected)
    expect(expected).toMatch(/^[\w-]{43}$/)
    expect(Buffer.from(expected, 'base64url')).toHaveLength(32)
  })

  it('follows a key rotation and tells keys apart', () => {
    const first = randomBytes(32)
    const second = randomBytes(32)
    const keyring = createMasterKeyring(first)
    const before = keyCheckOf(keyring)
    swapMasterKey(keyring, second, 2)
    expect(keyCheckOf(keyring)).toBe(keyCheckOfMasterKey(second))
    expect(keyCheckOf(keyring)).not.toBe(before)
    expect(sameKeyCheck(before, keyCheckOfMasterKey(first))).toBe(true)
    expect(sameKeyCheck(before, keyCheckOf(keyring))).toBe(false)
    expect(sameKeyCheck(before, before.slice(1))).toBe(false)
  })

  it('parses only a complete key state', () => {
    const check = keyCheckOfMasterKey(randomBytes(32))
    expect(parseKeyState({ version: 1, check, rotatedAt: null })).toEqual({ version: 1, check, rotatedAt: null })
    expect(parseKeyState({ version: 2, check, rotatedAt: 1_759_000_000_000 })).toEqual({ version: 2, check, rotatedAt: 1_759_000_000_000 })
    for (const value of [null, 'x', {}, { version: 0, check, rotatedAt: null }, { version: 1, check: 'short', rotatedAt: null }, { version: 1, check }])
      expect(parseKeyState(value)).toBeNull()
  })
})

describe('key service', () => {
  it('checks fresh auth first, then the confirmation, then the key source', async () => {
    const t = await createTestApp({ start: false })
    closers.push(() => t.close())
    const order: string[] = []
    const denied = new HarnessError({ code: 'forbidden', message: 'no' })
    await expect(t.deps.keys.rotate({ confirm: 'ROTATE' }, { requireFreshAuth: () => {
      order.push('fresh')
      throw denied
    } })).rejects.toBe(denied)
    await expect(t.deps.keys.rotate({ confirm: 'rotate' } as never, { requireFreshAuth: () => {} })).rejects.toMatchObject({ code: 'validation_error' })
    expect(order).toEqual(['fresh'])
    expect(t.deps.keyring.keyVersion).toBe(1)

    const env = await createTestApp({ start: false, env: { HF_MASTER_KEY: encodeMasterKey(randomBytes(32)) } })
    closers.push(() => env.close())
    await expect(env.deps.keys.rotate({ confirm: 'ROTATE' }, { requireFreshAuth: () => {} })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'env-key' } })
  })

  it('stops every run first (runsStopped, chat ids in key.rotated) and refuses a keyring it cannot rotate', async () => {
    const runs = createFakeChatRunner()
    const events = createRecordingEventBus()
    const t = await createTestApp({ start: false, overrides: { runs, events } })
    closers.push(() => t.close())
    const chatId = '0199a8f0-0000-7000-8000-00000000d001'
    await t.deps.chats.create({ id: chatId, title: 'Running' })
    runs.phases.set(chatId, 'streaming')
    const result = await t.deps.keys.rotate({ confirm: 'ROTATE' }, { requireFreshAuth: () => {} })
    expect(result).toMatchObject({ keyVersion: 2, runsStopped: 1, secrets: 0 })
    expect(runs.stopped).toEqual([chatId])
    expect(events.ofType('key.rotated')).toEqual([expect.objectContaining({ data: { keyVersion: 2, rotatedAt: result.rotatedAt, chatIds: [chatId] } })])
    expect(events.disconnects()).toBe(1)

    const fixed = await createTestApp({ start: false, overrides: { keyring: { keyVersion: 1, subkey: () => new Uint8Array(32) } } })
    closers.push(() => fixed.close())
    await expect(fixed.deps.keys.rotate({ confirm: 'ROTATE' }, { requireFreshAuth: () => {} })).rejects.toMatchObject({ code: 'internal_error' })
    expect(existsSync(nextKeyPath(fixed.env))).toBe(false)
  })

  it('registers the new key with the redactor before anything can log it', async () => {
    const t = await createTestApp({ start: false, factories: { keyring: createKeyring } })
    closers.push(() => t.close())
    await t.deps.keys.rotate({ confirm: 'ROTATE' }, { requireFreshAuth: () => {} })
    const text = readFileSync(t.env.paths.secretKey, 'utf8').trim()
    expect(t.deps.redactor.redactText(`key ${text}`)).not.toContain(text)
  })
})
