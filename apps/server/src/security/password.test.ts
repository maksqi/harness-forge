import type { TestApp } from '../testing/create-test-app.ts'
import { Buffer } from 'node:buffer'
import { HarnessError } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../testing/create-test-app.ts'
import { createMemorySecretStore, createMemorySettingsService } from '../testing/fakes.ts'
import { hashPassword, PASSWORD_SECRET_NAME, PASSWORD_SECRET_SCOPE, SCRYPT_PARAMS, verifyPassword } from './password.ts'

/** Cheap parameters for tests that only need a valid hash string. */
const FAST = { logN: 10, r: 8, p: 1 }

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

async function testApp(env: Record<string, string> = {}): Promise<TestApp> {
  const t = await createTestApp({
    env,
    start: false,
    overrides: { secrets: createMemorySecretStore(), settings: createMemorySettingsService() },
  })
  apps.push(t)
  return t
}

function replacePart(hash: string, index: number, replace: (part: string) => string): string {
  const parts = hash.split('$')
  parts[index] = replace(parts[index] ?? '')
  return parts.join('$')
}

describe('hashPassword / verifyPassword', () => {
  it('encodes scrypt parameters, salt and key: scrypt$15$8$1$<salt b64>$<hash b64>', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(SCRYPT_PARAMS).toEqual({ logN: 15, r: 8, p: 1 })
    const match = hash.match(/^scrypt\$15\$8\$1\$([^$]+)\$([^$]+)$/)
    expect(match).not.toBeNull()
    expect(Buffer.from(match?.[1] ?? '', 'base64')).toHaveLength(16)
    expect(Buffer.from(match?.[2] ?? '', 'base64')).toHaveLength(32)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
  })

  it('hashing the same password twice yields different strings (random salt)', async () => {
    const [a, b] = await Promise.all([hashPassword('same password', FAST), hashPassword('same password', FAST)])
    expect(a).not.toBe(b)
    expect(await verifyPassword('same password', a)).toBe(true)
    expect(await verifyPassword('same password', b)).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('right password', FAST)
    expect(await verifyPassword('wrong password', hash)).toBe(false)
    expect(await verifyPassword('right passwor', hash)).toBe(false)
    expect(await verifyPassword('', hash)).toBe(false)
  })

  it('rejects a tampered hash', async () => {
    const hash = await hashPassword('secret password', FAST)
    const flip = (text: string): string => `${text[0] === 'A' ? 'B' : 'A'}${text.slice(1)}`
    const tampered = [
      replacePart(hash, 5, flip), // key
      replacePart(hash, 4, flip), // salt
      replacePart(hash, 1, () => '11'), // cost
      replacePart(hash, 2, () => '4'), // block size
      replacePart(hash, 3, () => '2'), // parallelization
      replacePart(hash, 5, key => key.slice(0, -4)), // truncated key
      replacePart(hash, 0, () => 'bcrypt'),
      `${hash}$extra`,
    ]
    for (const candidate of tampered)
      expect(await verifyPassword('secret password', candidate), candidate).toBe(false)
  })

  it('rejects malformed hash strings and parameters that would exhaust memory', async () => {
    const salt = Buffer.alloc(16, 1).toString('base64')
    const key = Buffer.alloc(32, 2).toString('base64')
    for (const candidate of [
      '',
      'scrypt',
      'plain-text-password',
      `scrypt$15$8$1$${salt}`,
      `scrypt$30$8$1$${salt}$${key}`, // N = 2^30
      `scrypt$16$16$1$${salt}$${key}`, // 256 MiB
      `scrypt$15$8$1$${Buffer.alloc(4).toString('base64')}$${key}`, // short salt
      `scrypt$15$8$1$${salt}$${key.replace(/=+$/, '')}`, // non-canonical base64
      `scrypt$15$8$1$${salt}$not*base64`,
    ])
      expect(await verifyPassword('anything', candidate), candidate).toBe(false)
  })

  it('normalizes Unicode (NFC) so composed and decomposed forms match', async () => {
    const composed = 'caf\u00E9 au lait'
    const decomposed = 'cafe\u0301 au lait'
    expect(composed).not.toBe(decomposed)
    const hash = await hashPassword(composed, FAST)
    expect(await verifyPassword(decomposed, hash)).toBe(true)
  })
})

describe('createPasswordService', () => {
  it('has no password by default', async () => {
    const { deps } = await testApp()
    expect(await deps.passwords.source()).toBeNull()
    expect(await deps.passwords.check('anything')).toBe(false)
  })

  it('uses HF_PASSWORD (hashed in memory) over a stored password', async () => {
    const { deps } = await testApp({ HF_PASSWORD: 'env password' })
    await deps.secrets.set(PASSWORD_SECRET_SCOPE, PASSWORD_SECRET_NAME, await hashPassword('stored password', FAST))
    expect(await deps.passwords.source()).toBe('env')
    expect(await deps.passwords.check('env password')).toBe(true)
    expect(await deps.passwords.check('stored password')).toBe(false)
  })

  it('refuses to set a password while HF_PASSWORD is set (conflict env-password)', async () => {
    const { deps } = await testApp({ HF_PASSWORD: 'env password' })
    const error = await deps.passwords.set('new password').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({ code: 'conflict', details: { reason: 'env-password' } })
  })

  it('stores a scrypt hash in secrets (scope auth), checks it, and removes it', async () => {
    const { deps } = await testApp()
    await deps.passwords.set('a stored password')
    const stored = await deps.secrets.get(PASSWORD_SECRET_SCOPE, PASSWORD_SECRET_NAME)
    expect(stored).toMatch(/^scrypt\$15\$8\$1\$/)
    expect(stored).not.toContain('a stored password')
    expect(await deps.passwords.source()).toBe('settings')
    expect(await deps.passwords.check('a stored password')).toBe(true)
    expect(await deps.passwords.check('another password')).toBe(false)

    await deps.passwords.set(null)
    expect(await deps.secrets.get(PASSWORD_SECRET_SCOPE, PASSWORD_SECRET_NAME)).toBeNull()
    expect(await deps.passwords.source()).toBeNull()
    expect(await deps.passwords.check('a stored password')).toBe(false)
  })

  it('reads a hash stored before the service started', async () => {
    const secrets = createMemorySecretStore()
    await secrets.set(PASSWORD_SECRET_SCOPE, PASSWORD_SECRET_NAME, await hashPassword('from disk', FAST))
    const t = await createTestApp({ start: false, overrides: { secrets, settings: createMemorySettingsService() } })
    apps.push(t)
    expect(await t.deps.passwords.source()).toBe('settings')
    expect(await t.deps.passwords.check('from disk')).toBe(true)
  })

  it('a change ends every existing session (epoch incremented)', async () => {
    const { deps } = await testApp()
    const token = await deps.sessions.issue({ authAt: Date.now() })
    expect(await deps.sessions.verify(token)).not.toBeNull()
    await deps.passwords.set('first password')
    expect(await deps.sessions.verify(token)).toBeNull()
    const second = await deps.sessions.issue({ authAt: Date.now() })
    await deps.passwords.set(null)
    expect(await deps.sessions.verify(second)).toBeNull()
  })

  it('hash() and verify() are the service form of the helpers', async () => {
    const { deps } = await testApp()
    const hash = await deps.passwords.hash('service password')
    expect(await deps.passwords.verify('service password', hash)).toBe(true)
    expect(await deps.passwords.verify('other', hash)).toBe(false)
  })
})
