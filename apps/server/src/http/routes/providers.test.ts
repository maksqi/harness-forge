import type { ProvidersTestApp } from '../../providers/testing.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_PROVIDER_IDS,
  catalogModelSchema,
  harnessErrorEnvelopeSchema,
  listResponseSchema,
  providerSummarySchema,
  providerTestResultSchema,
} from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createProvidersTestApp } from '../../providers/testing.ts'

const ORIGIN = 'http://127.0.0.1:8787'
const KEY = 'sk-deepseek-test-0123456789abcdef'

let app: ProvidersTestApp | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json', 'origin': ORIGIN }, body: JSON.stringify(body) }
}

describe('gET /api/providers', () => {
  it('lists every provider with masked credentials only', async () => {
    const t = app = await createProvidersTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
    await t.credentials.set('deepseek', { apiKey: KEY })
    const response = await t.request('/api/providers')
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain(KEY)
    const { items } = listResponseSchema(providerSummarySchema).parse(JSON.parse(text))
    expect(items.map(item => item.id)).toEqual([...BUILTIN_PROVIDER_IDS, 'mock'])
    expect(items.find(item => item.id === 'deepseek')).toMatchObject({ status: 'connected', credentials: { apiKey: { set: true, hint: 'sk-…cdef', source: 'stored' } } })
    expect(items.every(item => item.icon === null || typeof item.icon === 'object')).toBe(true)
  })
})

describe('pATCH /api/providers/:id', () => {
  it('disables a provider across restarts and hides its models', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hf-providers-'))
    const databasePath = join(dataDir, 'harness.db')
    try {
      const first = app = await createProvidersTestApp({ dataDir, databasePath })
      expect(listResponseSchema(catalogModelSchema).parse(await (await first.request('/api/models?providerId=groq')).json()).items.length).toBeGreaterThan(0)
      const response = await first.request('/api/providers/groq', json('PATCH', { enabled: false }))
      expect(response.status).toBe(200)
      expect(providerSummarySchema.parse(await response.json())).toMatchObject({ id: 'groq', enabled: false })
      expect(first.events.ofType('provider.changed').at(-1)?.data).toMatchObject({ id: 'groq', provider: { enabled: false } })
      await first.close()
      app = undefined

      const second = app = await createProvidersTestApp({ dataDir, databasePath })
      const providers = listResponseSchema(providerSummarySchema).parse(await (await second.request('/api/providers')).json())
      expect(providers.items.find(item => item.id === 'groq')?.enabled).toBe(false)
      const models = await (await second.request('/api/models')).json() as { items: { providerId: string }[] }
      expect(models.items.some(model => model.providerId === 'groq')).toBe(false)
      expect(models.items.some(model => model.providerId === 'anthropic')).toBe(true)
    }
    finally {
      await app?.close()
      app = undefined
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('validates the body and the provider id', async () => {
    const t = app = await createProvidersTestApp()
    const unknown = await t.request('/api/providers/nope', json('PATCH', { enabled: false }))
    expect(unknown.status).toBe(404)
    expect(harnessErrorEnvelopeSchema.parse(await unknown.json()).error.code).toBe('not_found')
    const invalid = await t.request('/api/providers/groq', json('PATCH', { enabled: 'no' }))
    expect(invalid.status).toBe(400)
    const extra = await t.request('/api/providers/groq', json('PATCH', { enabled: true, name: 'x' }))
    expect(extra.status).toBe(400)
  })
})

describe('pOST /api/providers/:id/test', () => {
  it('tests a provider and returns the result', async () => {
    const t = app = await createProvidersTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
    const response = await t.request('/api/providers/mock/test', json('POST', {}))
    expect(response.status).toBe(200)
    expect(providerTestResultSchema.parse(await response.json())).toMatchObject({ ok: true })
  })

  it('answers a failed test with ok: false and rejects unknown credential keys', async () => {
    const t = app = await createProvidersTestApp()
    const missing = await t.request('/api/providers/openai/test', json('POST', {}))
    expect(missing.status).toBe(200)
    expect(providerTestResultSchema.parse(await missing.json())).toMatchObject({ ok: false, error: { code: 'provider_not_configured' } })
    const unknownKey = await t.request('/api/providers/openai/test', json('POST', { values: { token: 'x' } }))
    expect(unknownKey.status).toBe(400)
    expect(harnessErrorEnvelopeSchema.parse(await unknownKey.json()).error.code).toBe('validation_error')
    const unknownProvider = await t.request('/api/providers/nope/test', json('POST', {}))
    expect(unknownProvider.status).toBe(404)
  })
})
