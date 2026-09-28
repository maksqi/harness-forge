import type { TestApp } from '../../testing/create-test-app.ts'
import type { AppDeps } from '../../types.ts'
import type { SecretScope } from './types.ts'
import { Buffer } from 'node:buffer'
import { HarnessError } from '@harness-forge/shared'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { secrets } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeKeyring } from '../../testing/fakes.ts'
import { decryptSecret, secretAad } from './crypto.ts'
import { createSecretStore } from './index.ts'

const API_KEY = 'sk-store-test-0123456789abcdefghijklmnop9fQ2'
const scope: SecretScope = 'provider:openai'

let t: TestApp

beforeEach(async () => {
  t = await createTestApp({ builtins: [], start: false })
})

afterEach(async () => {
  await t.close()
})

async function rowOf(rowScope: string, name: string) {
  const [row] = await t.db.select().from(secrets).where(and(eq(secrets.scope, rowScope), eq(secrets.name, name))).limit(1)
  return row
}

/** A second store over the same database with other deps (e.g. another master key). */
function storeWith(overrides: Partial<AppDeps>) {
  return createSecretStore({ ...t.deps, ...overrides } as AppDeps)
}

function warnings(): string[] {
  return t.logs.records.filter(record => record.level === 'warn').map(record => record.msg)
}

describe('secret store', () => {
  it('round-trips values and stores only ciphertext and a masked hint', async () => {
    await t.deps.secrets.set(scope, 'apiKey', API_KEY)
    expect(await t.deps.secrets.get(scope, 'apiKey')).toBe(API_KEY)

    const row = await rowOf(scope, 'apiKey')
    expect(row?.hint).toBe('sk-…9fQ2')
    expect(row?.keyVersion).toBe(1)
    expect(Buffer.isBuffer(row?.ciphertext)).toBe(true)
    expect(row?.ciphertext.includes(Buffer.from(API_KEY))).toBe(false)
    expect(row?.ciphertext.toString('latin1')).not.toContain('9fQ2')
    expect(decryptSecret(t.deps.keyring.subkey('encryption'), secretAad(scope, 'apiKey'), row?.ciphertext ?? Buffer.alloc(0))).toBe(API_KEY)
  })

  it('replaces a value (new ciphertext and hint)', async () => {
    await t.deps.secrets.set(scope, 'apiKey', API_KEY)
    const before = await rowOf(scope, 'apiKey')
    await t.deps.secrets.set(scope, 'apiKey', 'short')
    const after = await rowOf(scope, 'apiKey')
    expect(await t.deps.secrets.get(scope, 'apiKey')).toBe('short')
    expect(after?.hint).toBeNull()
    expect(after?.ciphertext.equals(before?.ciphertext ?? Buffer.alloc(0))).toBe(false)
    expect(await t.db.select().from(secrets)).toHaveLength(1)
  })

  it('never stores a hint for the auth scope', async () => {
    await t.deps.secrets.set('auth', 'password', 'scrypt$15$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2g=')
    expect((await t.deps.secrets.list('auth'))[0]?.hint).toBeNull()
  })

  it('returns null for a missing secret', async () => {
    expect(await t.deps.secrets.get(scope, 'apiKey')).toBeNull()
  })

  it('lists metadata sorted by name, never values', async () => {
    await t.deps.secrets.set('mcp:everything', 'header.X-Api-Key', 'value-of-the-x-api-key-header')
    await t.deps.secrets.set('mcp:everything', 'env.TOKEN', 'another-long-token-value-123')
    await t.deps.secrets.set('mcp:other', 'env.TOKEN', 'not-in-this-scope-000000000')
    const entries = await t.deps.secrets.list('mcp:everything')
    expect(entries.map(entry => entry.name)).toEqual(['env.TOKEN', 'header.X-Api-Key'])
    expect(entries[0]).toEqual({ scope: 'mcp:everything', name: 'env.TOKEN', hint: 'ano…-123', keyVersion: 1, updatedAt: expect.any(Number) })
    expect(JSON.stringify(entries)).not.toContain('value-of-the-x-api-key-header')
  })

  it('deletes one secret or a whole scope', async () => {
    await t.deps.secrets.set('plugin:demo', 'settings.token', 'token-value-000000000001')
    await t.deps.secrets.set('plugin:demo', 'settings.other', 'token-value-000000000002')
    await t.deps.secrets.set('plugin:keep', 'settings.token', 'token-value-000000000003')
    expect(await t.deps.secrets.delete('plugin:demo', 'settings.token')).toBe(true)
    expect(await t.deps.secrets.delete('plugin:demo', 'settings.token')).toBe(false)
    expect(await t.deps.secrets.deleteScope('plugin:demo')).toBe(1)
    expect(await t.deps.secrets.deleteScope('plugin:demo')).toBe(0)
    expect(await t.deps.secrets.get('plugin:keep', 'settings.token')).toBe('token-value-000000000003')
  })

  it('reports a row copied to another scope or name as absent (AAD) and warns once', async () => {
    await t.deps.secrets.set(scope, 'apiKey', API_KEY)
    const row = await rowOf(scope, 'apiKey')
    await t.db.insert(secrets).values({ scope, name: 'stolen', ciphertext: row?.ciphertext ?? Buffer.alloc(0), hint: row?.hint ?? null })
    await t.db.insert(secrets).values({ scope: 'provider:anthropic', name: 'apiKey', ciphertext: row?.ciphertext ?? Buffer.alloc(0) })
    expect(await t.deps.secrets.get(scope, 'stolen')).toBeNull()
    expect(await t.deps.secrets.get('provider:anthropic', 'apiKey')).toBeNull()
    expect(await t.deps.secrets.get(scope, 'stolen')).toBeNull()
    expect(warnings().filter(msg => msg.includes('cannot be decrypted'))).toHaveLength(2)
    expect(t.logs.text()).not.toContain(API_KEY)
  })

  it('reports a tampered row as absent', async () => {
    await t.deps.secrets.set(scope, 'apiKey', API_KEY)
    const row = await rowOf(scope, 'apiKey')
    const tampered = Buffer.from(row?.ciphertext ?? Buffer.alloc(0))
    tampered[20] = (tampered[20] ?? 0) ^ 0xFF
    await t.db.update(secrets).set({ ciphertext: tampered }).where(and(eq(secrets.scope, scope), eq(secrets.name, 'apiKey')))
    expect(await t.deps.secrets.get(scope, 'apiKey')).toBeNull()
    expect(() => decryptSecret(t.deps.keyring.subkey('encryption'), secretAad(scope, 'apiKey'), tampered)).toThrow(HarnessError)
  })

  it('reports rows written with another master key or key version as absent', async () => {
    await t.deps.secrets.set(scope, 'apiKey', API_KEY)
    expect(await storeWith({ keyring: createFakeKeyring('another-master-key') }).get(scope, 'apiKey')).toBeNull()
    const rotated = { keyVersion: 2, subkey: t.deps.keyring.subkey }
    expect(await storeWith({ keyring: rotated }).get(scope, 'apiKey')).toBeNull()
    expect(await t.deps.secrets.get(scope, 'apiKey')).toBe(API_KEY)
  })

  it('registers values with the redactor so they never reach a log line', async () => {
    const other = storeWith({})
    await t.deps.secrets.set(scope, 'apiKey', API_KEY)
    t.deps.logger.info(`request failed for key ${API_KEY}`, { detail: `x ${API_KEY} y` })
    expect(t.logs.text()).not.toContain(API_KEY)
    expect(await other.get(scope, 'apiKey')).toBe(API_KEY)
  })

  it.each([
    ['an unknown scope kind', 'user:me', 'apiKey'],
    ['an uppercase id', 'provider:OpenAI', 'apiKey'],
    ['an empty id', 'plugin:', 'apiKey'],
    ['an empty name', 'provider:openai', ''],
    ['a name with spaces', 'provider:openai', 'api key'],
    ['a name with a newline', 'provider:openai', 'api\nkey'],
  ])('rejects %s', async (_label, badScope, name) => {
    await expect(t.deps.secrets.set(badScope as SecretScope, name, 'value')).rejects.toMatchObject({ code: 'validation_error' })
    await expect(t.deps.secrets.get(badScope as SecretScope, name)).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('rejects oversized and malformed values', async () => {
    await expect(t.deps.secrets.set(scope, 'apiKey', 'x'.repeat(65_537))).rejects.toMatchObject({ code: 'validation_error' })
    await expect(t.deps.secrets.set(scope, 'apiKey', '\uD800lone')).rejects.toMatchObject({ code: 'validation_error' })
    await expect(t.deps.secrets.set(scope, 'apiKey', 42 as unknown as string)).rejects.toMatchObject({ code: 'validation_error' })
    expect(await t.db.select().from(secrets)).toEqual([])
  })

  it('accepts empty and Unicode values', async () => {
    await t.deps.secrets.set('plugin:demo', 'empty', '')
    await t.deps.secrets.set('plugin:demo', 'unicode', 'päss wörd ✓ 🔑')
    expect(await t.deps.secrets.get('plugin:demo', 'empty')).toBe('')
    expect(await t.deps.secrets.get('plugin:demo', 'unicode')).toBe('päss wörd ✓ 🔑')
  })
})
