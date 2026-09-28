import type { ProviderTestResult } from '@harness-forge/shared'
import type { RecordingCatalog, TestProviderService } from '../../services/secrets/testing.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import type { AppDeps } from '../../types.ts'
import { Buffer } from 'node:buffer'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_ROUTE_KEYS, apiRoutes, harnessErrorEnvelopeSchema, providerSummarySchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKeyring } from '../../security/keyring.ts'
import { createRecordingCatalog, createTestProviderService, createTestRegistry } from '../../services/secrets/testing.ts'
import { sampleRequest } from '../../testing/api-samples.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { createValidationScheduler, validateCredentialsInBackground } from './credentials.ts'

const RAW_KEY = 'sk-proj-ROUTE-raw-key-0123456789abcdefghijklmnop9fQ2'
const ENV_KEY = 'sk-env-ROUTE-key-0123456789abcdefghijklmnopqrstZZ99'

interface Setup {
  t: TestApp
  events: RecordingEventBus
  providers: TestProviderService
  catalog: RecordingCatalog
}

interface SetupOptions {
  env?: Record<string, string>
  testResult?: ProviderTestResult
  dataDir?: string
  databasePath?: string
  realKeyring?: boolean
}

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const events = createRecordingEventBus()
  const catalog = createRecordingCatalog()
  let providers: TestProviderService | undefined
  const t = await createTestApp({
    env: options.env,
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    builtins: [],
    start: false,
    overrides: { registry: createTestRegistry(), events, catalog },
    factories: {
      providers: deps => (providers = createTestProviderService(deps, options.testResult)),
      ...(options.realKeyring ? { keyring: createKeyring } : {}),
    },
  })
  cleanups.push(() => t.close())
  if (providers === undefined)
    throw new Error('The providers factory did not run.')
  return { t, events, providers, catalog }
}

function putCredentials(t: TestApp, id: string, body: unknown): Promise<Response> {
  return t.request(`/api/providers/${id}/credentials`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function deleteCredentials(t: TestApp, id: string): Promise<Response> {
  return t.request(`/api/providers/${id}/credentials`, { method: 'DELETE' })
}

async function errorOf(response: Response) {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

function filesBelow(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesBelow(path) : [path]
  })
}

describe('saving credentials (PUT /api/providers/:id/credentials)', () => {
  it('stores the key and answers the summary with a masked hint only', async () => {
    const { t, events, providers, catalog } = await setup()
    const response = await putCredentials(t, 'openai', { values: { apiKey: RAW_KEY } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const text = await response.text()
    expect(text).not.toContain(RAW_KEY)
    const summary = providerSummarySchema.parse(JSON.parse(text))
    expect(summary.credentials.apiKey).toEqual({ set: true, hint: 'sk-…9fQ2', source: 'stored' })
    expect(summary.credentials.baseURL).toEqual({ set: false, hint: null, source: null })
    expect(summary.status).toBe('connected')

    expect(events.ofType('provider.changed')).toEqual([expect.objectContaining({ data: { id: 'openai', provider: summary } })])
    // Background: validate the stored credentials, then refresh the listing.
    await vi.waitFor(() => expect(catalog.refreshed).toEqual(['openai']))
    expect(providers.tested).toEqual(['openai'])
    expect((await t.deps.credentials.resolve('openai')).values.apiKey).toBe(RAW_KEY)
  })

  it('answers non-secret values and works through the typed client', async () => {
    const { t } = await setup()
    const summary = await t.client.credentials.set({ params: { id: 'openai' }, body: { values: { baseURL: 'https://proxy.example.com/v1' } } })
    expect(summary.credentials.baseURL).toEqual({ set: true, hint: null, source: 'stored', value: 'https://proxy.example.com/v1' })
    expect(summary.status).toBe('not_configured')
  })

  it('clears a stored value with an empty string', async () => {
    const { t } = await setup({ env: { OPENAI_API_KEY: ENV_KEY } })
    await putCredentials(t, 'openai', { values: { apiKey: RAW_KEY } })
    const response = await putCredentials(t, 'openai', { values: { apiKey: '' } })
    const summary = providerSummarySchema.parse(await response.json())
    expect(summary.credentials.apiKey).toEqual({ set: true, hint: null, source: 'env' })
    expect(summary.status).toBe('env')
  })

  it.each([
    ['an unknown field', { values: { nope: 'x' } }, ['values', 'nope']],
    ['an invalid URL', { values: { baseURL: 'javascript:alert(1)' } }, ['values', 'baseURL']],
    ['a value over 4096 characters', { values: { apiKey: 'k'.repeat(4097) } }, ['values', 'apiKey']],
    ['a missing values object', {}, ['values']],
    ['an extra top-level key', { values: {}, extra: true }, []],
  ])('answers 400 validation_error for %s and changes nothing', async (_label, body, path) => {
    const { t, events } = await setup()
    const response = await putCredentials(t, 'openai', body)
    expect(response.status).toBe(400)
    const error = await errorOf(response)
    expect(error.code).toBe('validation_error')
    expect(error.details).toMatchObject({ issues: [expect.objectContaining({ path })] })
    expect(events.events).toEqual([])
    expect((await t.deps.credentials.states('openai')).apiKey?.set).toBe(false)
  })

  it('answers 404 for an unknown provider and 400 for an invalid id', async () => {
    const { t, events } = await setup()
    const unknown = await putCredentials(t, 'nope', { values: { apiKey: RAW_KEY } })
    expect(unknown.status).toBe(404)
    expect((await errorOf(unknown)).code).toBe('not_found')
    const invalid = await putCredentials(t, 'Not_An_Id', { values: { apiKey: RAW_KEY } })
    expect(invalid.status).toBe(400)
    expect(events.events).toEqual([])
    expect(t.logs.text()).not.toContain(RAW_KEY)
  })
})

describe('clearing credentials (DELETE /api/providers/:id/credentials)', () => {
  it('removes stored values, keeps env fallbacks and emits provider.changed + catalog.changed', async () => {
    const { t, events } = await setup({ env: { OPENAI_API_KEY: ENV_KEY } })
    await putCredentials(t, 'openai', { values: { apiKey: RAW_KEY, baseURL: 'https://proxy.example.com/v1' } })
    events.clear()

    const response = await deleteCredentials(t, 'openai')
    expect(response.status).toBe(200)
    const summary = providerSummarySchema.parse(await response.json())
    expect(summary.credentials).toEqual({
      apiKey: { set: true, hint: null, source: 'env' },
      baseURL: { set: false, hint: null, source: null },
    })
    expect(summary.status).toBe('env')
    expect(events.events.map(event => event.type)).toEqual(['provider.changed', 'catalog.changed'])
    expect(events.ofType('catalog.changed')[0]?.data).toEqual({ providerId: 'openai' })
    expect((await t.deps.credentials.resolve('openai')).values.apiKey).toBe(ENV_KEY)
  })

  it('is idempotent and answers 404 for an unknown provider', async () => {
    const { t } = await setup()
    expect((await deleteCredentials(t, 'openai')).status).toBe(200)
    expect((await deleteCredentials(t, 'openai')).status).toBe(200)
    const unknown = await deleteCredentials(t, 'nope')
    expect(unknown.status).toBe(404)
  })
})

describe('background validation', () => {
  it('is skipped while required fields are missing', async () => {
    const { t, providers, catalog } = await setup()
    await validateCredentialsInBackground(t.deps, 'openai')
    expect(providers.tested).toEqual([])
    expect(catalog.refreshed).toEqual([])
  })

  it('does not refresh the listing after a failed test', async () => {
    const { t, providers, catalog } = await setup({
      env: { OPENAI_API_KEY: ENV_KEY },
      testResult: { ok: false, latencyMs: 3, error: { code: 'auth_invalid', message: 'The key was rejected.' } },
    })
    await validateCredentialsInBackground(t.deps, 'openai')
    expect(providers.tested).toEqual(['openai'])
    expect(catalog.refreshed).toEqual([])
  })

  it('coalesces repeated requests for one provider into a single rerun', async () => {
    const { t } = await setup({ env: { OPENAI_API_KEY: ENV_KEY } })
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    const providers = {
      ...t.deps.providers,
      test: async (): Promise<ProviderTestResult> => {
        calls += 1
        if (calls === 1)
          await gate
        return { ok: false, latencyMs: 1 }
      },
    }
    const schedule = createValidationScheduler({ ...t.deps, providers } as AppDeps)
    const first = schedule('openai')
    expect(schedule('openai')).toBe(first)
    expect(schedule('openai')).toBe(first)
    release()
    await first
    expect(calls).toBe(2)
    // Once idle, a new request starts a new run.
    await schedule('openai')
    expect(calls).toBe(3)
  })

  it('never rejects; failures are logged', async () => {
    const { t } = await setup({ env: { OPENAI_API_KEY: ENV_KEY } })
    await expect(validateCredentialsInBackground(t.deps, 'nope')).resolves.toBeUndefined()
    expect(t.logs.records.some(record => record.msg === 'background credential validation failed')).toBe(true)
  })
})

describe('secrets never leave the server', () => {
  it('the raw key appears in no response body, event or log line', async () => {
    const { t, events } = await setup()
    const put = await putCredentials(t, 'openai', { values: { apiKey: RAW_KEY } })
    expect(put.status).toBe(200)
    const fragment = RAW_KEY.slice(3, -4)
    const bodies: string[] = [await put.text()]

    for (const key of API_ROUTE_KEYS) {
      const route = apiRoutes[key]
      if (route.method !== 'GET' || route.response === 'sse' || route.response === 'ui-message-stream')
        continue
      const { path, init } = sampleRequest(key)
      const response = await t.request(path, init)
      bodies.push(`${key}: ${await response.text()}`)
    }
    const cleared = await deleteCredentials(t, 'openai')
    bodies.push(await cleared.text())

    for (const body of bodies) {
      expect(body).not.toContain(RAW_KEY)
      expect(body).not.toContain(fragment)
    }
    expect(JSON.stringify(events.events)).not.toContain(fragment)
    expect(t.logs.text()).not.toContain(fragment)
  })

  it('keeps only ciphertext at rest and decrypts after a restart with the key file', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'harness-forge-credentials-'))
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const databasePath = join(dataDir, 'harness.db')

    const first = await setup({ dataDir, databasePath, realKeyring: true })
    expect((await putCredentials(first.t, 'deepseek', { values: { apiKey: RAW_KEY } })).status).toBe(200)
    await first.t.close()

    for (const file of filesBelow(dataDir))
      expect(readFileSync(file).includes(Buffer.from(RAW_KEY)), file).toBe(false)

    const second = await setup({ dataDir, databasePath, realKeyring: true })
    expect((await second.t.deps.credentials.resolve('deepseek')).values.apiKey).toBe(RAW_KEY)
    const summary = await second.t.deps.providers.get('deepseek')
    expect(summary.credentials.apiKey).toEqual({ set: true, hint: 'sk-…9fQ2', source: 'stored' })
  })
})
