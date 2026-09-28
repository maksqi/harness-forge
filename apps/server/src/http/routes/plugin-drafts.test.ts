import type { PluginManifest } from '@harness-forge/plugin-sdk'
import type { DeclarativeProvider } from '@harness-forge/shared'
import type { PluginDraftsService } from '../../plugins/drafts/index.ts'
import type { FakeLlmServer } from '../../plugins/drafts/testing.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { RecordingEventBus } from '../../testing/fakes.ts'
import { Buffer } from 'node:buffer'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  catalogModelSchema,
  draftTestResultSchema,
  harnessErrorEnvelopeSchema,
  listResponseSchema,
  pluginDetailSchema,
  providerSummarySchema,
} from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { secrets } from '../../db/schema.ts'
import { createPluginDraftsWith } from '../../plugins/drafts/index.ts'
import { createInertMcpManager, startFakeLlmServer, TINY_PNG } from '../../plugins/drafts/testing.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createRecordingEventBus } from '../../testing/fakes.ts'
import { requireFreshAuth } from '../middleware/fresh-auth.ts'

vi.mock('../middleware/fresh-auth.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../middleware/fresh-auth.ts')>(),
  requireFreshAuth: vi.fn(),
}))

const KEY = 'sk-fake-draft-key-0123456789abcdef'

let t: TestApp
let llm: FakeLlmServer
let events: RecordingEventBus

beforeEach(async () => {
  vi.mocked(requireFreshAuth).mockReset()
  llm = await startFakeLlmServer({ apiKey: KEY, models: ['fake-small', 'fake-large'] })
  events = createRecordingEventBus()
  t = await createTestApp({
    overrides: { events, mcp: createInertMcpManager() },
    factories: { drafts: deps => createPluginDraftsWith(deps, { timeoutMs: 5000 }) },
  })
})

afterEach(async () => {
  await t.close()
  await llm.close()
})

function drafts(): PluginDraftsService {
  return t.deps.drafts as PluginDraftsService
}

function provider(id: string, extra: Partial<DeclarativeProvider> = {}): DeclarativeProvider {
  return { id, name: 'Fake gateway', baseURL: llm.baseURL, apiFormat: 'openai-chat', ...extra }
}

function manifest(id: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifestVersion: 1,
    id,
    name: 'Fake gateway',
    version: '1.0.0',
    engines: { harness: '^1.0.0' },
    contributes: {
      providers: [provider(id, { models: [{ id: 'fake-large', name: 'Fake Large', capabilities: { tools: true } }], smallModelId: 'fake-small' })],
    },
    ...extra,
  }
}

async function send(method: string, path: string, body?: unknown): Promise<{ status: number, body: unknown }> {
  const response = await t.request(path, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null }
}

function error(body: unknown) {
  return harnessErrorEnvelopeSchema.parse(body).error
}

function pluginDir(id: string): string {
  return join(t.env.paths.plugins, id)
}

/** Every file below `dir` (recursively), for "never written in plain text" checks. */
function allFiles(dir: string): string[] {
  if (!existsSync(dir))
    return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? allFiles(path) : [path]
  })
}

describe('pOST /api/plugins', () => {
  it('creates a declarative provider plugin that is active with its models, storing the key as an encrypted credential', async () => {
    const created = await send('POST', '/api/plugins', { manifest: manifest('fake-gw'), credentials: { 'fake-gw': { apiKey: KEY } } })
    expect(created.status).toBe(201)
    const detail = pluginDetailSchema.parse(created.body)
    expect(detail).toMatchObject({ id: 'fake-gw', kind: 'declarative', source: 'created', state: 'active', editable: true, runsCode: false })
    expect(detail.contributions.providers).toEqual(['fake-gw'])
    expect(requireFreshAuth).not.toHaveBeenCalled()

    // plugin.json is the manifest; the key never lands in a file.
    const onDisk = JSON.parse(readFileSync(join(pluginDir('fake-gw'), 'plugin.json'), 'utf8')) as PluginManifest
    expect(onDisk.id).toBe('fake-gw')
    for (const file of allFiles(t.env.paths.root))
      expect(readFileSync(file).includes(Buffer.from(KEY)), file).toBe(false)
    const rows = await t.db.select().from(secrets)
    expect(rows.map(row => `${row.scope}/${row.name}`)).toContain('provider:fake-gw/apiKey')
    expect(rows.some(row => Buffer.from(row.ciphertext).includes(Buffer.from(KEY)))).toBe(false)

    await drafts().idle()
    const providers = await send('GET', '/api/providers')
    const summary = listResponseSchema(providerSummarySchema).parse(providers.body).items.find(item => item.id === 'fake-gw')
    expect(summary).toMatchObject({ pluginId: 'fake-gw', status: 'connected', enabled: true })
    expect(summary?.credentials.apiKey).toMatchObject({ set: true, source: 'stored' })
    expect(JSON.stringify(providers.body)).not.toContain(KEY)

    // Plugin models and the live listing (fetched with the stored key) appear in the catalog without a restart.
    const models = listResponseSchema(catalogModelSchema).parse((await send('GET', '/api/models?providerId=fake-gw')).body)
    expect(models.items.map(model => model.ref).sort()).toEqual(['fake-gw:fake-large', 'fake-gw:fake-small'])
    expect(models.items.find(model => model.id === 'fake-large')).toMatchObject({ name: 'Fake Large', capabilities: { tools: true } })
    expect(llm.requests.some(request => request.url === '/v1/models' && request.headers.authorization === `Bearer ${KEY}`)).toBe(true)

    expect(events.ofType('plugin.changed').some(event => event.data.id === 'fake-gw' && event.data.plugin?.state === 'active')).toBe(true)
    expect(events.ofType('provider.changed').some(event => event.data.id === 'fake-gw')).toBe(true)
    expect(t.logs.text()).not.toContain(KEY)
  })

  it('creates a keyless provider with runtime listing off', async () => {
    const body = manifest('local-llm', {
      contributes: { providers: [provider('local-llm', { auth: { type: 'none' }, listModels: false, models: [{ id: 'fake-small' }] })] },
    })
    const created = await send('POST', '/api/plugins', { manifest: body })
    expect(created.status).toBe(201)
    const models = listResponseSchema(catalogModelSchema).parse((await send('GET', '/api/models?providerId=local-llm')).body)
    expect(models.items.map(model => model.ref)).toEqual(['local-llm:fake-small'])
    const providers = listResponseSchema(providerSummarySchema).parse((await send('GET', '/api/providers')).body)
    expect(providers.items.find(item => item.id === 'local-llm')).toMatchObject({ local: true, status: 'connected', credentialFields: [] })
  })

  it('answers 403 for reserved ids, 400 for invalid ids and manifests, 409 for existing ids', async () => {
    for (const id of ['openai', 'core-thing', 'mock']) {
      const response = await send('POST', '/api/plugins', { manifest: manifest(id) })
      expect(response.status, id).toBe(403)
      expect(error(response.body).code).toBe('forbidden')
    }
    for (const id of ['Bad_Id', '-dash', 'a'.repeat(41)]) {
      const response = await send('POST', '/api/plugins', { manifest: manifest(id) })
      expect(response.status, id).toBe(400)
      expect(error(response.body).code).toBe('validation_error')
    }
    expect((await send('POST', '/api/plugins', { manifest: { ...manifest('with-main'), main: 'index.mjs' } })).status).toBe(400)
    const foreign = await send('POST', '/api/plugins', { manifest: manifest('owner', { contributes: { providers: [provider('other')] } }) })
    expect(foreign.status).toBe(400)

    expect((await send('POST', '/api/plugins', { manifest: manifest('fake-gw') })).status).toBe(201)
    const again = await send('POST', '/api/plugins', { manifest: manifest('fake-gw') })
    expect(again.status).toBe(409)
    expect(error(again.body)).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    // A provider id registered by another plugin is refused up front.
    const clash = await send('POST', '/api/plugins', { manifest: manifest('fake', { contributes: { providers: [provider('fake-gw')] } }) })
    expect(clash.status).toBe(409)
    expect(error(clash.body).message).toContain('fake-gw')
    expect(existsSync(pluginDir('fake'))).toBe(false)
  })

  it('validates credentials against the declared fields before writing anything', async () => {
    const unknownKey = await send('POST', '/api/plugins', { manifest: manifest('fake-gw'), credentials: { 'fake-gw': { token: 'x' } } })
    expect(unknownKey.status).toBe(400)
    expect(error(unknownKey.body).details).toMatchObject({ issues: [{ path: ['credentials', 'fake-gw', 'token'] }] })
    const unknownProvider = await send('POST', '/api/plugins', { manifest: manifest('fake-gw'), credentials: { other: { apiKey: 'x' } } })
    expect(unknownProvider.status).toBe(400)
    expect(existsSync(pluginDir('fake-gw'))).toBe(false)
    expect(readdirSync(t.env.paths.pluginStaging)).toEqual([])
  })

  it('stores a sanitized SVG icon and serves it', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><circle cx="4" cy="4" r="4"/></svg>'
    const response = await send('POST', '/api/plugins', {
      manifest: manifest('icon-svg', { icon: 'icon.svg' }),
      iconFile: { name: 'icon.svg', base64: Buffer.from(svg).toString('base64') },
    })
    expect(response.status).toBe(201)
    const detail = pluginDetailSchema.parse(response.body)
    expect(detail.icon?.color).toMatch(/^\/api\/plugins\/icon-svg\/icon\?v=[\da-f]{8}$/)
    const stored = readFileSync(join(pluginDir('icon-svg'), 'icon.svg'), 'utf8')
    expect(stored).toBe('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="4" cy="4" r="4"/></svg>\n')
    const served = await t.request('/api/plugins/icon-svg/icon')
    expect(served.headers.get('content-type')).toContain('image/svg+xml')
    expect(await served.text()).toBe(stored)

    const png = await send('POST', '/api/plugins', {
      manifest: manifest('icon-png', { icon: 'icon.png' }),
      iconFile: { name: 'icon.png', base64: TINY_PNG.toString('base64') },
    })
    expect(png.status).toBe(201)
    const invalid = await send('POST', '/api/plugins', {
      manifest: manifest('icon-bad', { icon: 'icon.svg' }),
      iconFile: { name: 'icon.svg', base64: Buffer.from('<html/>').toString('base64') },
    })
    expect(invalid.status).toBe(400)
    const mismatch = await send('POST', '/api/plugins', {
      manifest: manifest('icon-mismatch', { icon: 'lobe:together' }),
      iconFile: { name: 'icon.svg', base64: Buffer.from(svg).toString('base64') },
    })
    expect(mismatch.status).toBe(400)
  })

  it('requires fresh auth for a stdio MCP server and pins it at creation', async () => {
    const stdio = manifest('with-stdio', {
      contributes: {
        mcpServers: [{ id: 'with-stdio', name: 'Local tools', transport: { type: 'stdio', command: 'node', args: ['server.mjs'] } }],
      },
    })
    vi.mocked(requireFreshAuth).mockImplementation(() => {
      throw Object.assign(new Error('fresh auth needed'), { name: 'HarnessError', code: 'forbidden', action: 'login' })
    })
    const refused = await send('POST', '/api/plugins', { manifest: stdio })
    expect(refused.status).toBe(403)
    expect(error(refused.body)).toMatchObject({ code: 'forbidden', action: 'login' })
    expect(existsSync(pluginDir('with-stdio'))).toBe(false)

    vi.mocked(requireFreshAuth).mockReset()
    const created = await send('POST', '/api/plugins', { manifest: stdio })
    expect(created.status).toBe(201)
    expect(requireFreshAuth).toHaveBeenCalledTimes(1)
    const detail = pluginDetailSchema.parse(created.body)
    expect(detail).toMatchObject({ state: 'active', runsCode: true, trust: { required: true, trusted: true } })
    expect(detail.trust.trustedHash).toBe(detail.trust.hash)
  })

  it('keeps the credentials of a plugin created disabled', async () => {
    const created = await send('POST', '/api/plugins', { manifest: manifest('later'), credentials: { later: { apiKey: KEY } }, enable: false })
    expect(created.status).toBe(201)
    expect(pluginDetailSchema.parse(created.body)).toMatchObject({ state: 'disabled', enabled: false })
    const enabled = await send('POST', '/api/plugins/later/enable')
    expect(pluginDetailSchema.parse(enabled.body).state).toBe('active')
    expect((await t.deps.providers.get('later')).credentials.apiKey).toMatchObject({ set: true, source: 'stored' })
  })
})

describe('pOST /api/plugins/drafts/test', () => {
  it('lists models and pings a model with the supplied key, storing nothing', async () => {
    const listed = await send('POST', '/api/plugins/drafts/test', { provider: provider('draft'), credentials: { apiKey: KEY }, action: 'list-models' })
    expect(listed.status).toBe(200)
    const listing = draftTestResultSchema.parse(listed.body)
    expect(listing).toMatchObject({ ok: true })
    expect(listing.models?.map(model => model.id)).toEqual(['fake-small', 'fake-large'])
    expect(listing.models?.[0]?.contextWindow).toBe(32_768)
    expect(listing.latencyMs).toBeGreaterThanOrEqual(0)

    const pinged = draftTestResultSchema.parse((await send('POST', '/api/plugins/drafts/test', {
      provider: provider('draft', { listModels: false }),
      credentials: { apiKey: KEY },
      action: 'ping',
      modelId: 'fake-small',
    })).body)
    expect(pinged).toMatchObject({ ok: true, output: 'pong' })
    const completion = llm.requests.find(request => request.url === '/v1/chat/completions')
    expect(completion?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(completion?.body).toMatchObject({ model: 'fake-small', max_tokens: 1 })

    // Nothing registered or stored.
    expect(t.deps.registry.providers.get('draft')).toBeUndefined()
    expect(await t.db.select().from(secrets)).toEqual([])
    expect(t.logs.text()).not.toContain(KEY)
  })

  it('lists models even when runtime listing is off, with the anthropic wire format', async () => {
    const result = draftTestResultSchema.parse((await send('POST', '/api/plugins/drafts/test', {
      provider: provider('draft', { apiFormat: 'anthropic', listModels: false }),
      credentials: { apiKey: KEY },
      action: 'list-models',
    })).body)
    expect(result.ok).toBe(true)
    const request = llm.requests.at(-1)
    expect(request?.url).toBe('/v1/models?limit=1000')
    expect(request?.headers['x-api-key']).toBe(KEY)

    const ping = draftTestResultSchema.parse((await send('POST', '/api/plugins/drafts/test', {
      provider: provider('draft', { apiFormat: 'anthropic' }),
      credentials: { apiKey: KEY },
      action: 'ping',
      modelId: 'fake-large',
    })).body)
    expect(ping).toMatchObject({ ok: true, output: 'pong' })
    expect(llm.requests.at(-1)).toMatchObject({ url: '/v1/messages', body: { model: 'fake-large', max_tokens: 1 } })
  })

  it('reports failures as ok: false', async () => {
    const wrongKey = draftTestResultSchema.parse((await send('POST', '/api/plugins/drafts/test', {
      provider: provider('draft'),
      credentials: { apiKey: 'sk-wrong-key-0000000000000000' },
      action: 'list-models',
    })).body)
    expect(wrongKey).toMatchObject({ ok: false, error: { code: 'auth_invalid', status: 401, providerId: 'draft' } })
    expect(wrongKey.error?.message).toContain('rejected the credentials')

    const unknownModel = draftTestResultSchema.parse((await send('POST', '/api/plugins/drafts/test', {
      provider: provider('draft'),
      credentials: { apiKey: KEY },
      action: 'ping',
      modelId: 'nope',
    })).body)
    expect(unknownModel).toMatchObject({ ok: false, error: { code: 'model_not_found', status: 404 } })

    const missingKey = draftTestResultSchema.parse((await send('POST', '/api/plugins/drafts/test', { provider: provider('draft'), action: 'list-models' })).body)
    expect(missingKey).toMatchObject({ ok: false, latencyMs: 0, error: { code: 'provider_not_configured' } })

    const closed = await startFakeLlmServer()
    await closed.close()
    const unreachable = draftTestResultSchema.parse((await send('POST', '/api/plugins/drafts/test', {
      provider: provider('draft', { baseURL: closed.baseURL, auth: { type: 'none' } }),
      action: 'list-models',
    })).body)
    expect(unreachable).toMatchObject({ ok: false, error: { code: 'provider_unreachable' } })
  })

  it('rejects invalid requests with 400', async () => {
    const unknownKey = await send('POST', '/api/plugins/drafts/test', { provider: provider('draft'), credentials: { token: 'x' }, action: 'list-models' })
    expect(unknownKey.status).toBe(400)
    expect(error(unknownKey.body).details).toMatchObject({ issues: [{ path: ['credentials', 'token'] }] })
    expect((await send('POST', '/api/plugins/drafts/test', { provider: provider('draft'), action: 'ping' })).status).toBe(400)
    expect((await send('POST', '/api/plugins/drafts/test', { provider: { ...provider('draft'), baseURL: 'ftp://x' }, action: 'ping', modelId: 'a' })).status).toBe(400)
  })
})

describe('pUT /api/plugins/:id/manifest', () => {
  it('saves and hot-reloads an edited manifest', async () => {
    await send('POST', '/api/plugins', { manifest: manifest('fake-gw'), credentials: { 'fake-gw': { apiKey: KEY } } })
    await drafts().idle()
    const next = manifest('fake-gw', {
      name: 'Renamed gateway',
      version: '1.1.0',
      contributes: { providers: [provider('fake-gw', { name: 'Renamed gateway', listModels: false, models: [{ id: 'fake-small', name: 'Small' }] })] },
    })
    const saved = await send('PUT', '/api/plugins/fake-gw/manifest', { manifest: next })
    expect(saved.status).toBe(200)
    expect(pluginDetailSchema.parse(saved.body)).toMatchObject({ name: 'Renamed gateway', version: '1.1.0', state: 'active' })
    expect((await t.deps.providers.get('fake-gw')).name).toBe('Renamed gateway')
    const models = listResponseSchema(catalogModelSchema).parse((await send('GET', '/api/models?providerId=fake-gw')).body)
    expect(models.items.map(model => model.name)).toContain('Small')
    expect(JSON.parse(readFileSync(join(pluginDir('fake-gw'), 'plugin.json'), 'utf8'))).toMatchObject({ name: 'Renamed gateway' })
    // Credentials survive a manifest save.
    expect((await t.deps.providers.get('fake-gw')).credentials.apiKey?.set).toBe(true)
  })

  it('refuses id changes, unknown, builtin and non-editable plugins', async () => {
    await send('POST', '/api/plugins', { manifest: manifest('fake-gw') })
    expect((await send('PUT', '/api/plugins/fake-gw/manifest', { manifest: manifest('other') })).status).toBe(400)
    expect((await send('PUT', '/api/plugins/missing/manifest', { manifest: manifest('missing') })).status).toBe(404)
    expect((await send('PUT', '/api/plugins/core-tools/manifest', { manifest: manifest('core-tools') })).status).toBe(403)
    await t.deps.plugins.saveRecord({ id: 'fake-gw', source: 'zip', sourceRef: 'fake.zip', version: '1.0.0' })
    const zip = await send('PUT', '/api/plugins/fake-gw/manifest', { manifest: manifest('fake-gw') })
    expect(zip.status).toBe(403)
    expect(error(zip.body).code).toBe('forbidden')
  })

  it('refuses an icon file that is not in the plugin', async () => {
    await send('POST', '/api/plugins', { manifest: manifest('fake-gw') })
    const response = await send('PUT', '/api/plugins/fake-gw/manifest', { manifest: manifest('fake-gw', { icon: 'icon.svg' }) })
    expect(response.status).toBe(400)
    expect(error(response.body).details).toMatchObject({ issues: [{ path: ['manifest', 'icon'] }] })
  })

  it('requires fresh auth to declare a stdio MCP server and re-pins the manifest', async () => {
    await send('POST', '/api/plugins', { manifest: manifest('fake-gw') })
    const withStdio = manifest('fake-gw', {
      contributes: {
        ...manifest('fake-gw').contributes,
        mcpServers: [{ id: 'fake-gw', name: 'Local tools', transport: { type: 'stdio', command: 'node', args: ['server.mjs'] } }],
      },
    })
    vi.mocked(requireFreshAuth).mockImplementation(() => {
      throw Object.assign(new Error('fresh auth needed'), { name: 'HarnessError', code: 'forbidden', action: 'login' })
    })
    expect((await send('PUT', '/api/plugins/fake-gw/manifest', { manifest: withStdio })).status).toBe(403)
    expect(JSON.parse(readFileSync(join(pluginDir('fake-gw'), 'plugin.json'), 'utf8')).contributes.mcpServers).toBeUndefined()

    vi.mocked(requireFreshAuth).mockReset()
    const saved = await send('PUT', '/api/plugins/fake-gw/manifest', { manifest: withStdio })
    expect(saved.status).toBe(200)
    const detail = pluginDetailSchema.parse(saved.body)
    expect(detail).toMatchObject({ state: 'active', trust: { required: true, trusted: true } })

    // Unchanged stdio server of a trusted plugin: no new prompt, still trusted after the save.
    const renamed = { ...withStdio, description: 'Now with tools' }
    const again = await send('PUT', '/api/plugins/fake-gw/manifest', { manifest: renamed })
    expect(requireFreshAuth).toHaveBeenCalledTimes(1)
    expect(pluginDetailSchema.parse(again.body)).toMatchObject({ state: 'active', description: 'Now with tools', trust: { trusted: true } })
  })
})
