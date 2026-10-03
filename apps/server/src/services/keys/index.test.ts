// Keys skeleton (C16-T3): the key check (ARCHITECTURE.md 6.14), the `_keys` shape, and the service stubs that answer
// `not_implemented` until W7.7.
import { Buffer } from 'node:buffer'
import { createHmac, randomBytes } from 'node:crypto'
import { HarnessError } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createMasterKeyring, deriveSubkey, swapMasterKey } from '../../security/keyring.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { keyCheckOf, keyCheckOfMasterKey, keyCheckOfSubkey, parseKeyState, sameKeyCheck } from './check.ts'
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

describe('key service stub', () => {
  it('is wired as deps.keys and answers not_implemented until W7.7', async () => {
    const t = await createTestApp({ start: false })
    closers.push(() => t.close())
    await expect(t.deps.keys.status()).rejects.toBeInstanceOf(HarnessError)
    await expect(t.deps.keys.status()).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(t.deps.keys.rotate({ confirm: 'ROTATE' }, { requireFreshAuth: () => {} })).rejects.toMatchObject({ code: 'not_implemented' })
  })
})
