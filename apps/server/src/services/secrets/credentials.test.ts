import type { TestApp, TestAppOptions } from '../../testing/create-test-app.ts'
import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { providerConfigs, secrets } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { envCredentialValue, validateCredentialValues } from './credentials.ts'
import { ACME_PROVIDER, createTestRegistry } from './testing.ts'

const OPENAI_KEY = 'sk-proj-credentials-test-0123456789abcdefghijklmnop9fQ2'
const ENV_KEY = 'sk-env-credentials-test-0123456789abcdefghijklmnopZZ99'

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

async function app(env: TestAppOptions['env'] = {}): Promise<TestApp> {
  const t = await createTestApp({ env, builtins: [], start: false, overrides: { registry: createTestRegistry() } })
  apps.push(t)
  return t
}

async function configRow(t: TestApp, providerId: string) {
  const [row] = await t.db.select().from(providerConfigs).where(eq(providerConfigs.providerId, providerId)).limit(1)
  return row
}

describe('credentials.resolve', () => {
  it('resolves stored -> env -> default and reports missing required fields', async () => {
    const t = await app()
    expect(await t.deps.credentials.resolve('openai')).toEqual({
      values: { baseURL: 'https://api.openai.com/v1' },
      sources: { baseURL: 'default' },
      missing: ['apiKey'],
    })
    await t.deps.credentials.set('openai', { apiKey: OPENAI_KEY, baseURL: 'https://proxy.example.com/v1' })
    expect(await t.deps.credentials.resolve('openai')).toEqual({
      values: { apiKey: OPENAI_KEY, baseURL: 'https://proxy.example.com/v1' },
      sources: { apiKey: 'stored', baseURL: 'stored' },
      missing: [],
    })
  })

  it('falls back to the environment variable of the field', async () => {
    const t = await app({ OPENAI_API_KEY: `  ${ENV_KEY}\n` })
    const resolved = await t.deps.credentials.resolve('openai')
    expect(resolved.values.apiKey).toBe(ENV_KEY)
    expect(resolved.sources.apiKey).toBe('env')
    expect(resolved.missing).toEqual([])
  })

  it('prefers a stored value over the environment', async () => {
    const t = await app({ OPENAI_API_KEY: ENV_KEY })
    await t.deps.credentials.set('openai', { apiKey: OPENAI_KEY })
    const resolved = await t.deps.credentials.resolve('openai')
    expect(resolved.values.apiKey).toBe(OPENAI_KEY)
    expect(resolved.sources.apiKey).toBe('stored')
  })

  it('uses the first non-empty variable of an envVar list', async () => {
    const t = await app({ GOOGLE_GENERATIVE_AI_API_KEY: '   ', GEMINI_API_KEY: 'gemini-key-from-env-0000000', GOOGLE_API_KEY: 'google-key-from-env-0000000' })
    const resolved = await t.deps.credentials.resolve('google')
    expect(resolved.values.apiKey).toBe('gemini-key-from-env-0000000')
    expect(resolved.sources.apiKey).toBe('env')
  })

  it('never reads reserved HF_* variables', async () => {
    const t = await app({ HF_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') })
    const resolved = await t.deps.credentials.resolve('acme')
    expect(resolved.values.token).toBeUndefined()
    expect(resolved.sources.token).toBeUndefined()
    expect(envCredentialValue({ key: 'x', label: 'X', type: 'secret', envVar: ['HF_PASSWORD', 'hf_password'] }, { HF_PASSWORD: 'p', hf_password: 'q' })).toBeUndefined()
  })

  it('applies candidate values (provider test) without storing them', async () => {
    const t = await app({ ACME_API_KEY: ENV_KEY })
    await t.deps.credentials.set('acme', { apiKey: OPENAI_KEY, org: 'stored-org' })
    const resolved = await t.deps.credentials.resolve('acme', { apiKey: 'candidate-key-000000000000', region: 'us', org: '' })
    expect(resolved.values).toMatchObject({ apiKey: 'candidate-key-000000000000', region: 'us', baseURL: 'https://api.acme.test/v1' })
    // `''` resolves as if the stored value were cleared.
    expect(resolved.values.org).toBeUndefined()
    expect(resolved.sources).toMatchObject({ apiKey: 'stored', region: 'stored', baseURL: 'default' })
    expect((await t.deps.credentials.resolve('acme')).values).toMatchObject({ apiKey: OPENAI_KEY, org: 'stored-org', region: 'eu' })

    const cleared = await t.deps.credentials.resolve('acme', { apiKey: '' })
    expect(cleared.values.apiKey).toBe(ENV_KEY)
    expect(cleared.sources.apiKey).toBe('env')
  })

  it('validates candidate values', async () => {
    const t = await app()
    await expect(t.deps.credentials.resolve('acme', { nope: 'x' })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(t.deps.credentials.resolve('acme', { baseURL: 'not a url' })).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('registers resolved secrets with the redactor', async () => {
    const t = await app({ OPENAI_API_KEY: ENV_KEY })
    await t.deps.credentials.resolve('openai')
    t.deps.logger.warn(`upstream said: invalid key ${ENV_KEY}`)
    expect(t.logs.text()).not.toContain(ENV_KEY)
  })

  it('throws not_found for an unknown provider', async () => {
    const t = await app()
    await expect(t.deps.credentials.resolve('nope')).rejects.toMatchObject({ code: 'not_found', providerId: 'nope' })
    await expect(t.deps.credentials.states('nope')).rejects.toMatchObject({ code: 'not_found' })
    await expect(t.deps.credentials.set('nope', { apiKey: 'x' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(t.deps.credentials.clear('nope')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('credentials.states', () => {
  it('describes each field without secret values', async () => {
    const t = await app()
    expect(await t.deps.credentials.states('acme')).toEqual({
      apiKey: { set: false, hint: null, source: null },
      region: { set: false, hint: null, source: null },
      org: { set: false, hint: null, source: null },
      baseURL: { set: false, hint: null, source: null },
      token: { set: false, hint: null, source: null },
    })
    await t.deps.credentials.set('acme', { apiKey: OPENAI_KEY, region: 'us', org: 'my-org', token: 'short' })
    const states = await t.deps.credentials.states('acme')
    expect(states).toEqual({
      apiKey: { set: true, hint: 'sk-…9fQ2', source: 'stored' },
      region: { set: true, hint: null, source: 'stored', value: 'us' },
      org: { set: true, hint: null, source: 'stored', value: 'my-org' },
      baseURL: { set: false, hint: null, source: null },
      token: { set: true, hint: null, source: 'stored' },
    })
    expect(JSON.stringify(states)).not.toContain(OPENAI_KEY)
  })

  it('never echoes environment values, not even masked', async () => {
    const t = await app({ OPENAI_API_KEY: ENV_KEY })
    const states = await t.deps.credentials.states('openai')
    expect(states.apiKey).toEqual({ set: true, hint: null, source: 'env' })
    expect(JSON.stringify(states)).not.toContain('ZZ99')
  })

  it('shows a stored secret that cannot be decrypted as not stored', async () => {
    const t = await app({ OPENAI_API_KEY: ENV_KEY })
    await t.deps.credentials.set('openai', { apiKey: OPENAI_KEY })
    await t.db.update(secrets).set({ keyVersion: 99 }).where(eq(secrets.scope, 'provider:openai'))
    expect((await t.deps.credentials.states('openai')).apiKey).toEqual({ set: true, hint: null, source: 'env' })
    expect((await t.deps.credentials.resolve('openai')).sources.apiKey).toBe('env')
  })
})

describe('credentials.set / clear', () => {
  it('encrypts secret fields and keeps other fields in provider_configs.options', async () => {
    const t = await app()
    await t.deps.credentials.set('acme', { apiKey: OPENAI_KEY, region: 'us', baseURL: 'https://eu.acme.test/v1' })
    const [secret] = await t.db.select().from(secrets)
    expect(secret).toMatchObject({ scope: 'provider:acme', name: 'apiKey', hint: 'sk-…9fQ2' })
    expect(secret?.ciphertext.toString('latin1')).not.toContain(OPENAI_KEY)
    expect((await configRow(t, 'acme'))?.options).toEqual({ region: 'us', baseURL: 'https://eu.acme.test/v1' })
  })

  it('trims values, clears with an empty string and leaves omitted keys unchanged', async () => {
    const t = await app()
    await t.deps.credentials.set('acme', { apiKey: `  ${OPENAI_KEY}  `, region: 'us', org: 'my-org' })
    expect((await t.deps.credentials.resolve('acme')).values.apiKey).toBe(OPENAI_KEY)
    await t.deps.credentials.set('acme', { org: '' })
    expect((await configRow(t, 'acme'))?.options).toEqual({ region: 'us' })
    expect((await t.deps.credentials.states('acme')).apiKey?.source).toBe('stored')
    await t.deps.credentials.set('acme', { apiKey: '   ' })
    expect((await t.deps.credentials.states('acme')).apiKey?.set).toBe(false)
    expect(await t.db.select().from(secrets)).toEqual([])
  })

  it('clears lastError and keeps the enabled flag', async () => {
    const t = await app()
    await t.db.insert(providerConfigs).values({
      providerId: 'openai',
      enabled: false,
      lastError: { code: 'auth_invalid', message: 'The key was rejected.', providerId: 'openai' },
    })
    await t.deps.credentials.set('openai', { apiKey: OPENAI_KEY })
    expect(await configRow(t, 'openai')).toMatchObject({ enabled: false, lastError: null, options: {} })
  })

  it.each([
    ['an unknown key', { nope: 'x' }, ['values', 'nope']],
    ['a value over 4096 characters', { apiKey: 'x'.repeat(4097) }, ['values', 'apiKey']],
    ['an invalid URL', { baseURL: 'ftp://acme.test' }, ['values', 'baseURL']],
    ['a URL with credentials', { baseURL: 'https://user:pass@acme.test/v1' }, ['values', 'baseURL']],
    ['a value outside the select options', { region: 'mars' }, ['values', 'region']],
    ['a control character', { apiKey: 'sk-abc\ndef' }, ['values', 'apiKey']],
    ['an invalid field key', { '1bad': 'x' }, ['values', '1bad']],
  ])('rejects %s with validation_error and stores nothing', async (_label, values, path) => {
    const t = await app()
    await expect(t.deps.credentials.set('acme', values as Record<string, string>)).rejects.toMatchObject({
      code: 'validation_error',
      details: { issues: [expect.objectContaining({ path })] },
    })
    expect(await t.db.select().from(secrets)).toEqual([])
    expect(await configRow(t, 'acme')).toBeUndefined()
  })

  it('does not echo rejected values in validation errors', async () => {
    const t = await app()
    const error = await t.deps.credentials.set('acme', { apiKey: OPENAI_KEY, nope: OPENAI_KEY }).catch((caught: unknown) => caught)
    expect(JSON.stringify(error)).not.toContain(OPENAI_KEY)
    expect(await t.db.select().from(secrets)).toEqual([])
  })

  it('clear removes every stored value while env fallbacks keep working', async () => {
    const t = await app({ ACME_KEY: ENV_KEY })
    await t.deps.credentials.set('acme', { apiKey: OPENAI_KEY, token: 'secondary-token-00000000', region: 'us' })
    await t.db.insert(secrets).values({ scope: 'provider:acme', name: 'legacyField', ciphertext: Buffer.alloc(40) })
    await t.deps.credentials.clear('acme')
    expect(await t.db.select().from(secrets)).toEqual([])
    expect((await configRow(t, 'acme'))?.options).toEqual({})
    const resolved = await t.deps.credentials.resolve('acme')
    expect(resolved.values).toEqual({ apiKey: ENV_KEY, region: 'eu', baseURL: 'https://api.acme.test/v1' })
    expect(resolved.sources.apiKey).toBe('env')
  })

  it('serializes concurrent writes of one provider', async () => {
    const t = await app()
    await Promise.all([
      t.deps.credentials.set('acme', { region: 'us' }),
      t.deps.credentials.set('acme', { org: 'my-org' }),
      t.deps.credentials.set('acme', { baseURL: 'https://x.acme.test/v1' }),
    ])
    expect((await configRow(t, 'acme'))?.options).toEqual({ region: 'us', org: 'my-org', baseURL: 'https://x.acme.test/v1' })
  })
})

describe('credentials.setFor (provider not registered)', () => {
  const LATER = { ...ACME_PROVIDER, id: 'later-acme' }

  it('stores against the given fields in the layout that resolve / states read once the provider registers', async () => {
    const t = await app()
    expect(t.deps.registry.providers.get('later-acme')).toBeUndefined()
    await t.deps.credentials.setFor!('later-acme', LATER.credentials, { apiKey: `  ${OPENAI_KEY}  `, region: 'us', org: 'my-org' })
    const [secret] = await t.db.select().from(secrets)
    expect(secret).toMatchObject({ scope: 'provider:later-acme', name: 'apiKey', hint: 'sk-…9fQ2' })
    expect(secret?.ciphertext.toString('latin1')).not.toContain(OPENAI_KEY)
    expect(await configRow(t, 'later-acme')).toMatchObject({ options: { region: 'us', org: 'my-org' }, lastError: null })
    // The stored secret is masked in logs right away.
    t.deps.logger.warn(`upstream said: invalid key ${OPENAI_KEY}`)
    expect(t.logs.text()).not.toContain(OPENAI_KEY)

    t.deps.registry.providers.register('test-plugin', LATER)
    expect(await t.deps.credentials.resolve('later-acme')).toMatchObject({
      values: { apiKey: OPENAI_KEY, region: 'us', org: 'my-org' },
      sources: { apiKey: 'stored', region: 'stored', org: 'stored' },
      missing: [],
    })
    expect((await t.deps.credentials.states('later-acme')).apiKey).toEqual({ set: true, hint: 'sk-…9fQ2', source: 'stored' })
  })

  it('merges with stored options, clears with an empty string and validates like set', async () => {
    const t = await app()
    const setFor = t.deps.credentials.setFor!
    await setFor('later-acme', LATER.credentials, { region: 'us', org: 'first' })
    await Promise.all([
      setFor('later-acme', LATER.credentials, { org: '' }),
      setFor('later-acme', LATER.credentials, { baseURL: 'https://x.acme.test/v1' }),
    ])
    expect((await configRow(t, 'later-acme'))?.options).toEqual({ region: 'us', baseURL: 'https://x.acme.test/v1' })
    await expect(setFor('later-acme', LATER.credentials, { nope: 'x' })).rejects.toMatchObject({ code: 'validation_error', details: { issues: [expect.objectContaining({ path: ['values', 'nope'] })] } })
    await expect(setFor('later-acme', LATER.credentials, { region: 'mars' })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(setFor('Not An Id', LATER.credentials, { region: 'us' })).rejects.toMatchObject({ code: 'validation_error' })
    expect(await t.db.select().from(secrets)).toEqual([])
  })
})

describe('validateCredentialValues', () => {
  it('returns trimmed values and accepts clearing any known key', () => {
    expect(validateCredentialValues(ACME_PROVIDER.credentials, { apiKey: ' k ', region: '', baseURL: '' })).toEqual({ apiKey: 'k', region: '', baseURL: '' })
  })

  it('rejects a non-object', () => {
    expect(() => validateCredentialValues(ACME_PROVIDER.credentials, 'x')).toThrow(expect.objectContaining({ code: 'validation_error' }))
  })
})
