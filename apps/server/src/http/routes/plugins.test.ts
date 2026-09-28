import type { PluginTestApp } from '../../plugins/__fixtures__/harness.ts'
import {
  harnessErrorEnvelopeSchema,
  listResponseSchema,
  pluginDetailSchema,
  pluginLogEntrySchema,
  pluginSettingsViewSchema,
  pluginSummarySchema,
} from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinPlugins } from '../../builtin-plugins/index.ts'
import { createPluginTestApp, manifest, removeTempDirs } from '../../plugins/__fixtures__/harness.ts'
import { requireFreshAuth } from '../middleware/fresh-auth.ts'

vi.mock('../middleware/fresh-auth.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../middleware/fresh-auth.ts')>(),
  requireFreshAuth: vi.fn(),
}))

let h: PluginTestApp

beforeEach(async () => {
  vi.mocked(requireFreshAuth).mockReset()
  h = await createPluginTestApp({
    builtins: getBuiltinPlugins({ mockProvider: false }),
    plugins: [
      { fixture: 'acme-docs' },
      { fixture: 'dice-roller', trust: true },
      { id: 'lobe-icon', files: { 'plugin.json': manifest('lobe-icon', { icon: 'lobe:together' }) } },
    ],
  })
})

afterEach(async () => {
  await h.close()
  removeTempDirs()
})

async function json(path: string, init?: RequestInit): Promise<{ status: number, body: unknown, headers: Headers }> {
  const response = await h.t.request(path, init)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null, headers: response.headers }
}

function post(path: string, body?: unknown): Promise<{ status: number, body: unknown, headers: Headers }> {
  return json(path, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
}

function errorCode(body: unknown): string {
  return harnessErrorEnvelopeSchema.parse(body).error.code
}

describe('list and detail', () => {
  it('lists builtins first, then plugins by id', async () => {
    const { status, body } = await json('/api/plugins')
    expect(status).toBe(200)
    const list = listResponseSchema(pluginSummarySchema).parse(body)
    expect(list.items.map(plugin => plugin.id)).toEqual(['core-providers', 'core-tools', 'core-commands', 'core-mcp', 'acme-docs', 'dice-roller', 'lobe-icon'])
  })

  it('returns the detail DTO, 404 for unknown ids and 400 for invalid ids', async () => {
    const { status, body } = await json('/api/plugins/acme-docs')
    expect(status).toBe(200)
    expect(pluginDetailSchema.parse(body)).toMatchObject({ id: 'acme-docs', state: 'active', hasSettings: true })
    const missing = await json('/api/plugins/missing')
    expect(missing.status).toBe(404)
    expect(errorCode(missing.body)).toBe('not_found')
    const invalid = await json('/api/plugins/Not_Valid')
    expect(invalid.status).toBe(400)
    expect(errorCode(invalid.body)).toBe('validation_error')
  })
})

describe('enable / disable / reload', () => {
  it('disables and enables a plugin', async () => {
    const disabled = await post('/api/plugins/acme-docs/disable')
    expect(disabled.status).toBe(200)
    expect(pluginDetailSchema.parse(disabled.body)).toMatchObject({ state: 'disabled', enabled: false })
    const enabled = await post('/api/plugins/acme-docs/enable')
    expect(pluginDetailSchema.parse(enabled.body)).toMatchObject({ state: 'active', enabled: true })
    expect((await post('/api/plugins/missing/enable')).status).toBe(404)
  })

  it('requires fresh auth to reload a code plugin, not a declarative plugin or a builtin', async () => {
    const declarative = await post('/api/plugins/acme-docs/reload')
    expect(declarative.status).toBe(200)
    expect(requireFreshAuth).not.toHaveBeenCalled()
    await post('/api/plugins/core-commands/reload')
    expect(requireFreshAuth).not.toHaveBeenCalled()

    const code = await post('/api/plugins/dice-roller/reload')
    expect(code.status).toBe(200)
    expect(requireFreshAuth).toHaveBeenCalledTimes(1)

    vi.mocked(requireFreshAuth).mockImplementation(() => {
      throw Object.assign(new Error('fresh auth needed'), { name: 'HarnessError', code: 'forbidden', action: 'login' })
    })
    const refused = await post('/api/plugins/dice-roller/reload')
    expect(refused.status).toBe(403)
    expect(harnessErrorEnvelopeSchema.parse(refused.body).error).toMatchObject({ code: 'forbidden', action: 'login' })
  })

  it('answers 409 when reloading a disabled plugin', async () => {
    await post('/api/plugins/acme-docs/disable')
    const response = await post('/api/plugins/acme-docs/reload')
    expect(response.status).toBe(409)
    expect(harnessErrorEnvelopeSchema.parse(response.body).error.details).toEqual({ reason: 'disabled' })
  })
})

describe('uninstall', () => {
  it('uninstalls plugins, refuses builtins, validates keepData', async () => {
    expect((await json('/api/plugins/core-tools', { method: 'DELETE' })).status).toBe(403)
    expect((await json('/api/plugins/acme-docs?keepData=maybe', { method: 'DELETE' })).status).toBe(400)
    const removed = await h.t.request('/api/plugins/acme-docs?keepData=true', { method: 'DELETE' })
    expect(removed.status).toBe(204)
    expect((await json('/api/plugins/acme-docs')).status).toBe(404)
    expect((await h.t.request('/api/plugins/dice-roller', { method: 'DELETE' })).status).toBe(204)
  })
})

describe('settings', () => {
  it('returns the schema and masked secrets, validates and stores updates', async () => {
    const initial = await json('/api/plugins/acme-docs/settings')
    expect(pluginSettingsViewSchema.parse(initial.body)).toMatchObject({ values: { region: 'eu', limit: 10 }, secrets: { token: { set: false } } })

    const secret = 'acme-token-0123456789abcdef'
    const updated = await json('/api/plugins/acme-docs/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { token: secret, region: 'us' } }),
    })
    expect(updated.status).toBe(200)
    expect(pluginSettingsViewSchema.parse(updated.body)).toMatchObject({ values: { region: 'us' }, secrets: { token: { set: true, source: 'stored' } } })
    expect(JSON.stringify(updated.body)).not.toContain(secret)
    expect(JSON.stringify((await json('/api/plugins/acme-docs/settings')).body)).not.toContain(secret)

    const invalid = await json('/api/plugins/acme-docs/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { region: 'mars' } }) })
    expect(invalid.status).toBe(400)
    expect(harnessErrorEnvelopeSchema.parse(invalid.body).error.details).toMatchObject({ issues: [expect.objectContaining({ path: ['region'] })] })
    const noSchema = await json('/api/plugins/dice-roller/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: {} }) })
    expect(noSchema.status).toBe(400)
    expect(pluginSettingsViewSchema.parse((await json('/api/plugins/dice-roller/settings')).body)).toEqual({ schema: null, values: {}, secrets: {} })
  })
})

describe('icon', () => {
  it('serves file icons with restrictive headers', async () => {
    const response = await h.t.request('/api/plugins/acme-docs/icon')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe('default-src \'none\'; style-src \'unsafe-inline\'')
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(await response.text()).toContain('<svg')
  })

  it('redirects lobe icons and answers 404 without an icon', async () => {
    const response = await h.t.request('/api/plugins/lobe-icon/icon', { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/api/icons/lobe/together?v=test')
    expect((await json('/api/plugins/dice-roller/icon')).status).toBe(404)
  })
})

describe('logs', () => {
  it('returns ring buffer entries after a sequence number', async () => {
    const all = listResponseSchema(pluginLogEntrySchema).parse((await json('/api/plugins/dice-roller/logs')).body).items
    expect(all.map(entry => entry.message)).toContain('dice roller ready')
    const last = all.at(-1)?.seq ?? 0
    h.t.deps.plugins.log('dice-roller', 'info', 'fresh entry')
    const after = listResponseSchema(pluginLogEntrySchema).parse((await json(`/api/plugins/dice-roller/logs?after=${last}&limit=5`)).body).items
    expect(after.map(entry => entry.message)).toEqual(['fresh entry'])
    expect((await json('/api/plugins/dice-roller/logs?limit=0')).status).toBe(400)
    expect((await json('/api/plugins/missing/logs')).status).toBe(404)
  })
})
