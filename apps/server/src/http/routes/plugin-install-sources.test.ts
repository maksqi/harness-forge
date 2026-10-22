// Plugin install routes with the Phase 12 sources (API.md 5.16; W12.2-T3 / T6): multipart `format`, the GitHub and
// marketplace JSON sources, fresh auth when trust is required, 409 offline / exists / stale, 404, and the Phase 12 fields
// of the details the plugin routes answer (`format`, `origin` without the entry overlay, `editable: false` for a Claude
// Code plugin). Claude Code plugins are read by the stand-in reader (`plugins/marketplaces/testing.ts`). v1.8.1: an
// install or removal of an entry's plugin emits `marketplace.changed`; reloading a Claude Code plugin that runs commands
// takes a stale session (real reader); the entry overlay file of an uploaded zip (CCR-1) is validated strictly and
// grants nothing (real reader).
import type { SourcesTestApp, SourcesTestAppOptions } from '../../plugins/marketplaces/testing.ts'
import type { FixtureTree } from '../../testing/claude-fixtures.ts'
import { harnessErrorEnvelopeSchema, marketplaceChangedDataSchema, parseMarketplaceJson, pluginDetailSchema, pluginInspectionSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { entryOverlayFile, OVERLAY_FILE_MAX_BYTES, OVERLAY_FILE_NAME } from '../../plugins/install/overlay-file.ts'
import { entryOverlay } from '../../plugins/marketplaces/sources.ts'
import { createSourcesTestApp } from '../../plugins/marketplaces/testing.ts'
import { CLAUDE_MARKETPLACE, claudePluginFiles, registerClaudeMarketplaceRemote } from '../../testing/claude-fixtures.ts'
import { createFakeRemoteRoutes, githubZipOf } from '../../testing/fake-remote.ts'

const PASSWORD = 'correct horse battery staple'
const apps: SourcesTestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

async function start(options: SourcesTestAppOptions = {}): Promise<SourcesTestApp> {
  const app = await createSourcesTestApp(options)
  apps.push(app)
  return app
}

interface Result {
  status: number
  body: unknown
}

async function send(app: SourcesTestApp, path: string, init: RequestInit = {}, cookie?: string): Promise<Result> {
  const headers = new Headers(init.headers)
  if (cookie !== undefined)
    headers.set('cookie', cookie)
  const response = await app.t.request(path, { ...init, headers })
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) as unknown }
}

function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/** A zip of a fixture tree (one top folder, Unix modes), like a zipped plugin folder. */
function zipped(files: FixtureTree, folder: string): Uint8Array {
  return githubZipOf(folder, '0'.repeat(40), files, { topFolder: folder, comment: null })
}

function multipart(data: Uint8Array, fields: Record<string, string> = {}, fileName = 'plugin.zip'): RequestInit {
  const form = new FormData()
  form.append('file', new Blob([data]), fileName)
  for (const [key, value] of Object.entries(fields))
    form.append(key, value)
  return { method: 'POST', body: form }
}

function error(result: Result): { code: string, message: string, details?: unknown } {
  return harnessErrorEnvelopeSchema.parse(result.body).error
}

async function cookieOf(app: SourcesTestApp, ageMs: number): Promise<string> {
  return `hf_session=${await app.t.deps.sessions.issue({ authAt: Date.now() - ageMs })}`
}

describe('multipart format', () => {
  it('inspect reads the format field next to the zip; other fields stay refused', async () => {
    const app = await start()
    const zip = zipped(claudePluginFiles('notes-only'), 'notes-only')
    const inspected = await send(app, '/api/plugins/inspect', multipart(zip, { format: 'claude' }))
    expect(inspected.status).toBe(200)
    expect(pluginInspectionSchema.parse(inspected.body)).toMatchObject({ format: 'claude', source: 'zip', requiresTrust: false, manifest: { id: 'notes-only' } })
    expect(error(await send(app, '/api/plugins/inspect', multipart(zip, { format: 'cursor' })))).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['format'] }] } })
    expect(error(await send(app, '/api/plugins/inspect', multipart(zip, { trust: 'true' })))).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['trust'] }] } })
    const installed = await send(app, '/api/plugins/install', multipart(zip, { format: 'claude' }, 'notes.zip'))
    expect(installed.status).toBe(201)
    expect(pluginDetailSchema.parse(installed.body)).toMatchObject({ id: 'notes-only', format: 'claude', source: 'zip', origin: null, editable: false })
  })

  it('a zipped Claude Code plugin is detected without a format', async () => {
    const app = await start()
    const inspected = await send(app, '/api/plugins/inspect', multipart(zipped(claudePluginFiles('review-kit'), 'review-kit')))
    expect(inspected.status).toBe(200)
    expect(pluginInspectionSchema.parse(inspected.body)).toMatchObject({ format: 'claude', requiresTrust: true, manifest: { id: 'review-kit' } })
  })
})

describe('github and marketplace sources', () => {
  it('a GitHub plugin that runs anything needs fresh auth to install (403), then installs with its origin', async () => {
    const routes = createFakeRemoteRoutes()
    const sha = routes.commit('acme/review-kit', claudePluginFiles('review-kit'))
    const app = await start({ routes, env: { HF_PASSWORD: PASSWORD } })
    const stale = await cookieOf(app, 24 * 60 * 60 * 1000)
    const fresh = await cookieOf(app, 0)
    const source = { source: 'github', repo: 'acme/review-kit', format: 'claude' }
    const inspected = await send(app, '/api/plugins/inspect', json(source), stale)
    expect(inspected.status).toBe(200)
    const inspection = pluginInspectionSchema.parse(inspected.body)
    expect(inspection).toMatchObject({ requiresTrust: true, sourceRef: `acme/review-kit@${sha.slice(0, 12)}` })
    const refused = await send(app, '/api/plugins/install', json({ ...source, trust: true, sha256: inspection.sha256 }), stale)
    expect(refused.status).toBe(403)
    expect(await app.t.deps.plugins.record('review-kit')).toBeNull()
    const installed = await send(app, '/api/plugins/install', json({ ...source, trust: true, sha256: inspection.sha256 }), fresh)
    expect(installed.status).toBe(201)
    expect(pluginDetailSchema.parse(installed.body)).toMatchObject({
      id: 'review-kit',
      format: 'claude',
      source: 'github',
      editable: false,
      origin: { kind: 'github', repo: 'acme/review-kit', ref: null, commit: sha, path: null },
      trust: { trusted: true },
    })
    const listed = await send(app, '/api/plugins', {}, stale)
    expect((listed.body as { items: Array<{ id: string, format: string }> }).items.find(item => item.id === 'review-kit')?.format).toBe('claude')
  })

  it('a marketplace install answers the origin without the entry overlay; 404 for an unknown entry; offline 409', async () => {
    const routes = createFakeRemoteRoutes()
    const shas = registerClaudeMarketplaceRemote(routes)
    const app = await start({ routes })
    const marketplace = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    const installed = await send(app, '/api/plugins/install', json({ source: 'marketplace', marketplaceId: marketplace.id, plugin: 'review-kit', trust: true }))
    expect(installed.status).toBe(201)
    const detail = pluginDetailSchema.parse(installed.body)
    expect(detail).toMatchObject({ source: 'marketplace', sourceRef: 'review-kit@acme-tools', format: 'claude', editable: false })
    expect(detail.origin).toEqual({ kind: 'marketplace', marketplaceId: marketplace.id, marketplace: 'acme-tools', plugin: 'review-kit', sourceKind: 'relative', commit: shas.marketplace, path: 'plugins/review-kit', version: '1.2.0' })
    const got = pluginDetailSchema.parse((await send(app, '/api/plugins/review-kit')).body)
    expect(got.origin).toEqual(detail.origin)
    expect(JSON.stringify(got)).not.toContain('"overlay"')

    expect(error(await send(app, '/api/plugins/inspect', json({ source: 'marketplace', marketplaceId: marketplace.id, plugin: 'missing' })))).toMatchObject({ code: 'not_found' })
    expect((await send(app, '/api/plugins/inspect', json({ source: 'marketplace', marketplaceId: marketplace.id, plugin: 'command-plugin' }))).status).toBe(400)
    // Another source holding the id: 409 exists.
    const zip = zipped(claudePluginFiles('review-kit'), 'review-kit')
    expect(error(await send(app, '/api/plugins/install', multipart(zip, { trust: 'true' })))).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })

    const offline = await start({ routes, env: { HF_OFFLINE: '1' } })
    expect(error(await send(offline, '/api/plugins/inspect', json({ source: 'github', repo: 'acme/review-kit' })))).toMatchObject({ code: 'conflict', details: { reason: 'offline' } })
  })

  it('a GitHub source body is validated (repo, ref, path)', async () => {
    const app = await start()
    expect(error(await send(app, '/api/plugins/inspect', json({ source: 'github', repo: 'acme' })))).toMatchObject({ details: { issues: [{ path: ['repo'] }] } })
    expect(error(await send(app, '/api/plugins/inspect', json({ source: 'github', repo: 'acme/x', ref: '../main' })))).toMatchObject({ details: { issues: [{ path: ['ref'] }] } })
    expect(error(await send(app, '/api/plugins/inspect', json({ source: 'github', repo: 'acme/x', path: '../up' })))).toMatchObject({ details: { issues: [{ path: ['path'] }] } })
    expect(app.routes.requests).toEqual([])
  })
})

describe('marketplace.changed after installs and removals (v1.8.1)', () => {
  it('installing, updating and removing an entry\'s plugin emit marketplace.changed with the install state', async () => {
    const routes = createFakeRemoteRoutes()
    registerClaudeMarketplaceRemote(routes)
    const app = await start({ routes })
    const marketplace = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    app.events.clear()
    const body = { source: 'marketplace', marketplaceId: marketplace.id, plugin: 'notes-only' }
    expect((await send(app, '/api/plugins/install', json(body))).status).toBe(201)
    const types = app.events.events.map(event => event.type)
    // The host's plugin.changed first, then the marketplace's.
    expect(types.lastIndexOf('marketplace.changed')).toBeGreaterThan(types.indexOf('plugin.changed'))
    expect(app.events.ofType('marketplace.changed').map(event => event.data)).toEqual([{ id: marketplace.id, marketplace: expect.objectContaining({ id: marketplace.id, name: 'acme-tools', updates: 0 }) }])
    expect(marketplaceChangedDataSchema.parse(app.events.ofType('marketplace.changed')[0]!.data).marketplace).not.toBeNull()

    // An update from the same entry emits again.
    app.events.clear()
    expect((await send(app, '/api/plugins/install', json(body))).status).toBe(201)
    expect(app.events.ofType('marketplace.changed')).toHaveLength(1)

    app.events.clear()
    expect((await send(app, '/api/plugins/notes-only', { method: 'DELETE' })).status).toBe(204)
    expect(app.events.ofType('marketplace.changed').map(event => event.data)).toEqual([{ id: marketplace.id, marketplace: expect.objectContaining({ id: marketplace.id }) }])
    expect((await app.t.deps.marketplaces.get(marketplace.id)).entries.find(entry => entry.name === 'notes-only')?.installedPluginId).toBeNull()
  })

  it('plugins from other sources emit no marketplace.changed', async () => {
    const routes = createFakeRemoteRoutes()
    registerClaudeMarketplaceRemote(routes)
    const app = await start({ routes })
    await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    app.events.clear()
    expect((await send(app, '/api/plugins/install', multipart(zipped(claudePluginFiles('notes-only'), 'notes-only')))).status).toBe(201)
    expect((await send(app, '/api/plugins/notes-only', { method: 'DELETE' })).status).toBe(204)
    expect(app.events.ofType('plugin.changed').length).toBeGreaterThan(0)
    expect(app.events.ofType('marketplace.changed')).toEqual([])
  })
})

describe('reloading a Claude Code plugin (ADR-017, ARCHITECTURE.md 10.13)', () => {
  it('needs no fresh auth, also when the plugin runs commands: the trust pin is checked again instead', async () => {
    const app = await start({ fakeClaude: false, env: { HF_PASSWORD: PASSWORD } })
    const zip = zipped(claudePluginFiles('review-kit'), 'review-kit')
    const inspection = await app.t.deps.installer.inspect({ source: 'zip', fileName: 'review-kit.zip', data: zip })
    expect(inspection.requiresTrust).toBe(true)
    await app.t.deps.installer.install({ source: 'zip', fileName: 'review-kit.zip', data: zip }, { trust: true, sha256: inspection.sha256, authorize: () => {} })
    const stale = await cookieOf(app, 24 * 60 * 60 * 1000)
    const reloaded = await send(app, '/api/plugins/review-kit/reload', { method: 'POST' }, stale)
    expect(reloaded.status).toBe(200)
    expect(pluginDetailSchema.parse(reloaded.body)).toMatchObject({ id: 'review-kit', format: 'claude', kind: 'declarative', state: 'active', trust: { trusted: true, hash: inspection.sha256 } })
  })
})

describe('the entry overlay file of an uploaded zip (v1.8.1, CCR-1)', () => {
  /** notes-only zipped with an overlay file. */
  function withOverlayFile(content: string | Uint8Array): Uint8Array {
    return zipped({ ...claudePluginFiles('notes-only'), [OVERLAY_FILE_NAME]: { content, mode: 0o644 } }, 'notes-only')
  }

  it('a malformed or oversized overlay file is a validation error of the upload', async () => {
    const app = await start({ fakeClaude: false })
    for (const content of ['{ not json', JSON.stringify({ format: 'hf-entry-overlay/v1', entry: { name: 'notes-only', strict: true, overlay: { evil: true } } }), new Uint8Array(OVERLAY_FILE_MAX_BYTES + 1).fill(0x20)]) {
      const result = await send(app, '/api/plugins/inspect', multipart(withOverlayFile(content)))
      expect(result.status).toBe(400)
      expect(error(result)).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['file'] }] } })
      expect(error(result).message).toContain(OVERLAY_FILE_NAME)
    }
    expect((await send(app, '/api/plugins/install', multipart(withOverlayFile('{ not json'))))).toMatchObject({ status: 400 })
    expect(await app.t.deps.plugins.record('notes-only')).toBeNull()
  })

  it('grants nothing: an overlay that adds a stdio MCP server needs trust and fresh auth like a plugin.json would', async () => {
    const marketplace = parseMarketplaceJson(JSON.stringify({ name: 'crafted', owner: { name: 'x' }, plugins: [{ name: 'notes-only', source: './x', mcpServers: { tool: { command: 'node', args: ['server.js'] } } }] })).marketplace
    const overlay = entryOverlay(marketplace!.plugins[0]!)
    expect(overlay.overlay).toHaveProperty('mcpServers')
    const zip = withOverlayFile(entryOverlayFile(overlay))
    const app = await start({ fakeClaude: false, env: { HF_PASSWORD: PASSWORD } })
    const stale = await cookieOf(app, 24 * 60 * 60 * 1000)
    const fresh = await cookieOf(app, 0)
    const inspection = pluginInspectionSchema.parse((await send(app, '/api/plugins/inspect', multipart(zip), stale)).body)
    expect(inspection).toMatchObject({ requiresTrust: true, claude: { executables: [expect.objectContaining({ kind: 'mcp' })] } })
    expect((await send(app, '/api/plugins/install', multipart(zip, { trust: 'true', sha256: inspection.sha256 }), stale)).status).toBe(403)
    expect(await app.t.deps.plugins.record('notes-only')).toBeNull()
    // Without trust it installs but runs nothing; the DTO origin stays null.
    const installed = await send(app, '/api/plugins/install', multipart(zip, { sha256: inspection.sha256 }), fresh)
    expect(installed.status).toBe(201)
    expect(pluginDetailSchema.parse(installed.body)).toMatchObject({ source: 'zip', origin: null, state: 'untrusted', trust: { required: true, trustedHash: null } })
  })
})
