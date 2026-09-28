// plugin-files routes (API.md 5.18, W3.4): status codes and DTOs over HTTP, traversal attempts in the URL, size limits,
// stale writes, and fresh auth (ADR-017) with a password: scaffold and build always, writes and deletes of code plugins.
import type { PluginTestApp } from '../../plugins/__fixtures__/harness.ts'
import { Buffer } from 'node:buffer'
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildResultSchema,
  harnessErrorEnvelopeSchema,
  LIMITS,
  listResponseSchema,
  pluginDetailSchema,
  pluginFileContentSchema,
  pluginFileEntrySchema,
} from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginTestApp, manifest, removeTempDirs } from '../../plugins/__fixtures__/harness.ts'
import { SESSION_COOKIE_NAME } from '../middleware/session-auth.ts'

const PASSWORD = 'correct horse battery staple'
const MINUTE = 60_000

let h: PluginTestApp | undefined

afterEach(async () => {
  await h?.close()
  h = undefined
  removeTempDirs()
})

interface JsonResponse {
  status: number
  body: unknown
}

async function call(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const response = await h!.t.request(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

function error(response: JsonResponse): { code: string, action?: string, details?: unknown } {
  return harnessErrorEnvelopeSchema.parse(response.body).error
}

async function scaffold(id: string, template = 'tool', headers: Record<string, string> = {}): Promise<JsonResponse> {
  return call('/api/plugins/scaffold', jsonInit('POST', { id, name: `Plugin ${id}`, template }), headers)
}

describe('without a password', () => {
  it('scaffolds, lists, reads, writes, deletes and builds', async () => {
    h = await createPluginTestApp()
    const created = await scaffold('http-tool')
    expect(created.status).toBe(201)
    expect(pluginDetailSchema.parse(created.body)).toMatchObject({ id: 'http-tool', state: 'active', source: 'created', kind: 'code' })

    const listed = await call('/api/plugins/http-tool/files')
    expect(listed.status).toBe(200)
    const entries = listResponseSchema(pluginFileEntrySchema).parse(listed.body).items
    expect(entries.map(entry => entry.path)).toEqual(['README.md', 'harness-forge.d.ts', 'index.mjs', 'plugin.json'])

    const read = await call('/api/plugins/http-tool/files/index.mjs')
    expect(read.status).toBe(200)
    const file = pluginFileContentSchema.parse(read.body)
    expect(file.content).toContain('http_tool_text_stats')

    const written = await call('/api/plugins/http-tool/files/lib/notes.md', jsonInit('PUT', { content: '# Notes\n' }))
    expect(written.status).toBe(200)
    expect(pluginFileEntrySchema.parse(written.body)).toMatchObject({ path: 'lib/notes.md', type: 'file', size: 8, editable: true })
    expect((await call('/api/plugins/http-tool/files/lib/notes.md')).body).toMatchObject({ content: '# Notes\n' })

    const removed = await h.t.request('/api/plugins/http-tool/files/lib/notes.md', { method: 'DELETE' })
    expect(removed.status).toBe(204)
    expect((await call('/api/plugins/http-tool/files/lib/notes.md')).status).toBe(404)

    const built = await call('/api/plugins/http-tool/build', jsonInit('POST', { reload: true }))
    expect(built.status).toBe(200)
    expect(buildResultSchema.parse(built.body)).toMatchObject({ ok: true, state: 'active', diagnostics: [] })
    // An empty body means { reload: true }.
    expect((await call('/api/plugins/http-tool/build', { method: 'POST' })).status).toBe(200)
  })

  it('answers the documented errors of scaffold', async () => {
    h = await createPluginTestApp()
    expect((await scaffold('core-mine')).status).toBe(403)
    await scaffold('twice')
    const again = await scaffold('twice', 'command-pack')
    expect(again.status).toBe(409)
    expect(error(again).details).toEqual({ reason: 'exists' })
    expect((await scaffold('Bad_Id')).status).toBe(400)
    expect((await scaffold('ok-id', 'widget')).status).toBe(400)
    expect((await call('/api/plugins/scaffold', jsonInit('POST', { id: 'x', name: 'X', template: 'tool', extra: 1 }))).status).toBe(400)
  })

  it('rejects traversal attempts in the URL before touching the disk', async () => {
    h = await createPluginTestApp()
    await scaffold('safe')
    const dir = h.pluginDir('safe')
    symlinkSync(join(dir, '..', '..'), join(dir, 'up'))
    const attempts = [
      '..%2f..%2fpackage.json',
      '%2e%2e%2f%2e%2e%2fpackage.json',
      '%2E%2E%2Fplugin.json',
      '%252e%252e%252fpackage.json',
      '%2Fetc%2Fpasswd',
      'lib%00.mjs',
      '..%5c..%5cpackage.json',
      'a//b.mjs',
      'up/package.json',
    ]
    for (const attempt of attempts) {
      const response = await call(`/api/plugins/safe/files/${attempt}`)
      expect(response.status, attempt).toBe(400)
      expect(error(response).code, attempt).toBe('validation_error')
      const write = await call(`/api/plugins/safe/files/${attempt}`, jsonInit('PUT', { content: 'x' }))
      expect(write.status, attempt).toBe(400)
    }
    // Dot segments that the URL parser normalizes never reach the files routes.
    expect((await call('/api/plugins/safe/files/%2e%2e/%2e%2e/package.json')).status).toBeGreaterThanOrEqual(400)
    expect((await call('/api/plugins/safe/files/%2e%2e/%2e%2e/package.json')).status).toBeLessThan(500)
  })

  it('answers 413 for files over 1 MB and 409 for stale writes', async () => {
    h = await createPluginTestApp()
    await scaffold('sizes')
    const justOver = 'a'.repeat(LIMITS.pluginFileBytes + 1)
    const tooBig = await call('/api/plugins/sizes/files/big.md', jsonInit('PUT', { content: justOver }))
    expect(tooBig.status).toBe(413)
    expect(error(tooBig).details).toEqual({ limitBytes: LIMITS.pluginFileBytes })
    const huge = await call('/api/plugins/sizes/files/big.md', jsonInit('PUT', { content: 'a'.repeat(3 * LIMITS.pluginFileBytes) }))
    expect(huge.status).toBe(413)

    const malformed = await call('/api/plugins/sizes/files/a.md', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{ "content": ' })
    expect(malformed.status).toBe(400)
    expect(error(malformed).code).toBe('validation_error')

    writeFileSync(join(h.pluginDir('sizes'), 'big.txt'), Buffer.alloc(LIMITS.pluginFileBytes + 1, 97))
    expect((await call('/api/plugins/sizes/files/big.txt')).status).toBe(413)

    const { etag } = pluginFileContentSchema.parse((await call('/api/plugins/sizes/files/README.md')).body)
    expect((await call('/api/plugins/sizes/files/README.md', jsonInit('PUT', { content: 'one\n', baseEtag: etag }))).status).toBe(200)
    const stale = await call('/api/plugins/sizes/files/README.md', jsonInit('PUT', { content: 'two\n', baseEtag: etag }))
    expect(stale.status).toBe(409)
    expect(error(stale).details).toEqual({ reason: 'stale' })
    expect(readFileSync(join(h.pluginDir('sizes'), 'README.md'), 'utf8')).toBe('one\n')
  })

  it('protects plugin.json and the entry, reports build diagnostics and refuses builtins', async () => {
    h = await createPluginTestApp()
    await scaffold('guarded')
    expect((await h.t.request('/api/plugins/guarded/files/plugin.json', { method: 'DELETE' })).status).toBe(400)
    expect((await h.t.request('/api/plugins/guarded/files/index.mjs', { method: 'DELETE' })).status).toBe(400)
    expect((await call('/api/plugins/guarded/files/plugin.json', jsonInit('PUT', { content: '{"id":"guarded"}' }))).status).toBe(400)

    await call('/api/plugins/guarded/files/index.mjs', jsonInit('PUT', { content: 'export default {\n  setup( {\n}\n' }))
    const built = buildResultSchema.parse((await call('/api/plugins/guarded/build', jsonInit('POST', {}))).body)
    expect(built.ok).toBe(false)
    expect(built.diagnostics[0]).toMatchObject({ severity: 'error', file: 'index.mjs', line: expect.any(Number), column: expect.any(Number) })
    expect(built.state).toBe('active')

    expect((await call('/api/plugins/missing/files')).status).toBe(404)
    expect((await call('/api/plugins/missing/build', jsonInit('POST', {}))).status).toBe(404)
  })
})

describe('with a password (fresh auth, ADR-017)', () => {
  async function cookie(authAt: number): Promise<Record<string, string>> {
    return { cookie: `${SESSION_COOKIE_NAME}=${await h!.t.deps.sessions.issue({ authAt })}` }
  }

  it('scaffold and build need a login within 10 minutes', async () => {
    h = await createPluginTestApp({ env: { HF_PASSWORD: PASSWORD } })
    const stale = await cookie(Date.now() - 11 * MINUTE)
    const fresh = await cookie(Date.now() - MINUTE)
    expect((await scaffold('fresh-tool', 'tool', {})).status).toBe(401)
    const refused = await scaffold('fresh-tool', 'tool', stale)
    expect(refused.status).toBe(403)
    expect(error(refused)).toMatchObject({ code: 'forbidden', action: 'login' })
    expect((await scaffold('fresh-tool', 'tool', fresh)).status).toBe(201)

    expect((await call('/api/plugins/fresh-tool/build', jsonInit('POST', {}), stale)).status).toBe(403)
    expect((await call('/api/plugins/fresh-tool/build', jsonInit('POST', {}), fresh)).status).toBe(200)
    // Reading needs only a session.
    expect((await call('/api/plugins/fresh-tool/files', {}, stale)).status).toBe(200)
    expect((await call('/api/plugins/fresh-tool/files/index.mjs', {}, stale)).status).toBe(200)
  })

  it('writes and deletes of code plugins need fresh auth; declarative plugins do not', async () => {
    h = await createPluginTestApp({ env: { HF_PASSWORD: PASSWORD } })
    const stale = await cookie(Date.now() - 11 * MINUTE)
    const fresh = await cookie(Date.now())
    await scaffold('code-files', 'tool', fresh)

    const write = await call('/api/plugins/code-files/files/README.md', jsonInit('PUT', { content: 'x\n' }), stale)
    expect(write.status).toBe(403)
    expect(error(write)).toMatchObject({ code: 'forbidden', action: 'login' })
    expect((await call('/api/plugins/code-files/files/README.md', jsonInit('PUT', { content: 'x\n' }), fresh)).status).toBe(200)
    expect((await h.t.request('/api/plugins/code-files/files/README.md', { method: 'DELETE', headers: stale })).status).toBe(403)
    expect((await h.t.request('/api/plugins/code-files/files/README.md', { method: 'DELETE', headers: fresh })).status).toBe(204)

    await h.install({ id: 'plain-files', files: { 'plugin.json': manifest('plain-files') }, enabled: true })
    await h.t.deps.plugins.load('plain-files')
    expect((await call('/api/plugins/plain-files/files/notes.md', jsonInit('PUT', { content: 'notes\n' }), stale)).status).toBe(200)
    // Turning it into a code plugin is a fresh-auth write.
    const toCode = JSON.stringify(manifest('plain-files', { main: 'index.mjs' }))
    expect((await call('/api/plugins/plain-files/files/plugin.json', jsonInit('PUT', { content: toCode }), stale)).status).toBe(403)
  })

  it('a fresh-auth save keeps a created plugin trusted after a reload (gate scenario)', async () => {
    h = await createPluginTestApp({ env: { HF_PASSWORD: PASSWORD } })
    const fresh = await cookie(Date.now())
    await scaffold('gate-tool', 'tool', fresh)
    const listed = listResponseSchema(pluginFileEntrySchema).parse((await call('/api/plugins/gate-tool/files', {}, fresh)).body)
    expect(listed.items.length).toBeGreaterThan(0)
    expect((await call('/api/plugins/gate-tool/files/..%2f..%2fpackage.json', {}, fresh)).status).toBe(400)

    const file = pluginFileContentSchema.parse((await call('/api/plugins/gate-tool/files/index.mjs', {}, fresh)).body)
    const changed = file.content.replace('policy: \'ask\'', 'policy: \'safe\'')
    expect((await call('/api/plugins/gate-tool/files/index.mjs', jsonInit('PUT', { content: changed, baseEtag: file.etag }), fresh)).status).toBe(200)
    const reloaded = await call('/api/plugins/gate-tool/reload', { method: 'POST' }, fresh)
    expect(pluginDetailSchema.parse(reloaded.body)).toMatchObject({ state: 'active', trust: { trusted: true } })
    expect(h.t.deps.registry.tools.get('gate_tool_text_stats')?.definition.policy).toBe('safe')
  })
})
