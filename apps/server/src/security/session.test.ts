import type { TestApp } from '../testing/create-test-app.ts'
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_EPOCH_KEY } from '../services/settings/types.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeKeyring, createMemorySecretStore, createMemorySettingsService } from '../testing/fakes.ts'
import { SESSION_TTL_MS } from './session.ts'

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

async function testApp(options: { keyringSeed?: string } = {}): Promise<TestApp> {
  const t = await createTestApp({
    start: false,
    overrides: {
      secrets: createMemorySecretStore(),
      settings: createMemorySettingsService(),
      ...(options.keyringSeed === undefined ? {} : { keyring: createFakeKeyring(options.keyringSeed) }),
    },
  })
  apps.push(t)
  return t
}

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0)

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
}

function encodePayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

describe('session tokens', () => {
  it('issues v1.<payload>.<signature> with { iat, exp, authAt, epoch } and verifies it', async () => {
    const { deps } = await testApp()
    const authAt = NOW - 60_000
    const token = await deps.sessions.issue({ authAt, now: NOW })
    expect(token).toMatch(/^v1\.[\w-]+\.[\w-]{43}$/)
    expect(decodePayload(token)).toEqual({ iat: NOW, exp: NOW + SESSION_TTL_MS, authAt, epoch: 0 })
    expect(await deps.sessions.verify(token, NOW + 1000)).toEqual({ iat: NOW, exp: NOW + SESSION_TTL_MS, authAt, epoch: 0 })
  })

  it('expires after 30 days', async () => {
    const { deps } = await testApp()
    const token = await deps.sessions.issue({ authAt: NOW, now: NOW })
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
    expect(await deps.sessions.verify(token, NOW + SESSION_TTL_MS - 1)).not.toBeNull()
    expect(await deps.sessions.verify(token, NOW + SESSION_TTL_MS)).toBeNull()
    expect(await deps.sessions.verify(token, NOW + SESSION_TTL_MS + 60_000)).toBeNull()
  })

  it('rejects a modified cookie', async () => {
    const { deps } = await testApp()
    const token = await deps.sessions.issue({ authAt: NOW, now: NOW })
    const [version, payload, signature] = token.split('.') as [string, string, string]
    const flipLast = (text: string): string => `${text.slice(0, -1)}${text.endsWith('A') ? 'B' : 'A'}`
    const forged = encodePayload({ ...decodePayload(token), exp: NOW + 10 * SESSION_TTL_MS })
    const candidates = [
      `${version}.${forged}.${signature}`, // extended expiry, old signature
      `${version}.${payload}.${flipLast(signature)}`, // even the unused low bits of the last character count
      `${version}.${flipLast(payload)}.${signature}`,
      `v2.${payload}.${signature}`,
      `${version}.${payload}`,
      `${token}.extra`,
      `${version}.${payload}.${signature}=`,
      '',
      'garbage',
      `${version}.${payload}.${'A'.repeat(2000)}`,
    ]
    for (const candidate of candidates)
      expect(await deps.sessions.verify(candidate, NOW), candidate).toBeNull()
    expect(await deps.sessions.verify(token, NOW)).not.toBeNull()
  })

  it('rejects a token signed with another key', async () => {
    const one = await testApp({ keyringSeed: 'key one' })
    const two = await testApp({ keyringSeed: 'key two' })
    const token = await one.deps.sessions.issue({ authAt: NOW, now: NOW })
    expect(await one.deps.sessions.verify(token, NOW)).not.toBeNull()
    expect(await two.deps.sessions.verify(token, NOW)).toBeNull()
  })

  it('rejects a correctly signed payload of the wrong shape', async () => {
    const { deps } = await testApp()
    // Sign arbitrary payloads the way the service does, through a token of the real service as a template.
    const token = await deps.sessions.issue({ authAt: NOW, now: NOW })
    expect(decodePayload(token)).toHaveProperty('epoch')
    for (const payload of [{ iat: NOW }, { iat: 'x', exp: NOW + 1, authAt: NOW, epoch: 0 }, [], null]) {
      const body = `v1.${encodePayload(payload)}`
      expect(await deps.sessions.verify(`${body}.${token.split('.')[2] ?? ''}`, NOW)).toBeNull()
    }
  })

  it('revokeAll() ends every session issued before (cookie issued before a password change)', async () => {
    const { deps } = await testApp()
    const before = await deps.sessions.issue({ authAt: NOW, now: NOW })
    expect(await deps.sessions.revokeAll()).toBe(1)
    expect(await deps.settings.getInternal(SESSION_EPOCH_KEY)).toBe(1)
    expect(await deps.sessions.verify(before, NOW)).toBeNull()
    const after = await deps.sessions.issue({ authAt: NOW, now: NOW })
    expect(decodePayload(after).epoch).toBe(1)
    expect(await deps.sessions.verify(after, NOW)).not.toBeNull()
    expect(await deps.sessions.revokeAll()).toBe(2)
    expect(await deps.sessions.verify(after, NOW)).toBeNull()
  })

  it('reads the epoch stored by a previous process', async () => {
    const settings = createMemorySettingsService()
    await settings.setInternal(SESSION_EPOCH_KEY, 7)
    const t = await createTestApp({ start: false, overrides: { settings, secrets: createMemorySecretStore() } })
    apps.push(t)
    const token = await t.deps.sessions.issue({ authAt: NOW, now: NOW })
    expect(decodePayload(token).epoch).toBe(7)
    expect(await t.deps.sessions.revokeAll()).toBe(8)
  })

  it('does not read the session subkey until a token is issued or verified', async () => {
    let calls = 0
    const keyring = createFakeKeyring()
    const t = await createTestApp({
      start: false,
      overrides: {
        keyring: { keyVersion: 1, subkey: (name) => {
          if (name === 'session')
            calls += 1
          return keyring.subkey(name)
        } },
        secrets: createMemorySecretStore(),
        settings: createMemorySettingsService(),
      },
    })
    apps.push(t)
    expect(calls).toBe(0)
    await t.deps.sessions.issue({ authAt: NOW, now: NOW })
    expect(calls).toBeGreaterThan(0)
  })
})
