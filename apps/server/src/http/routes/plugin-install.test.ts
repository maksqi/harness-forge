import type { FileSet, InstallTestApp, InstallTestAppOptions } from '../../plugins/install/testing.ts'
import type { BuiltinPlugin } from '../../plugins/types.ts'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { harnessErrorEnvelopeSchema, pluginDetailSchema, pluginInspectionSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { EntryCollector } from '../../plugins/install/archive.ts'
import { INSTALL_LIMITS } from '../../plugins/install/errors.ts'
import {
  codePlugin,
  createInstallTestApp,
  declarativePlugin,
  removeTempDirs,
  setupRuns,
  stdioPlugin,
  tempDir,
  writeFileSet,
  zipOf,
} from '../../plugins/install/testing.ts'
import { readZip } from '../../plugins/install/zip.ts'

const PASSWORD = 'correct horse battery staple'
const FRESH_WINDOW_MS = 10 * 60 * 1000

let app: InstallTestApp | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
  removeTempDirs()
})

async function start(options: InstallTestAppOptions = {}): Promise<InstallTestApp> {
  app = await createInstallTestApp(options)
  return app
}

interface Result {
  status: number
  body: unknown
  headers: Headers
}

async function send(a: InstallTestApp, path: string, init: RequestInit = {}, cookie?: string): Promise<Result> {
  const headers = new Headers(init.headers)
  if (cookie)
    headers.set('cookie', cookie)
  const response = await a.t.request(path, { ...init, headers })
  const type = response.headers.get('content-type') ?? ''
  const body = type.includes('application/json') ? await response.json() as unknown : new Uint8Array(await response.arrayBuffer())
  return { status: response.status, body, headers: response.headers }
}

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

function multipart(files: FileSet | Uint8Array, fields: Record<string, string> = {}, fileName = 'plugin.zip'): RequestInit {
  const form = new FormData()
  const data = files instanceof Uint8Array ? files : zipOf(files)
  form.append('file', new Blob([data]), fileName)
  for (const [key, value] of Object.entries(fields))
    form.append(key, value)
  return { method: 'POST', body: form }
}

function error(result: Result): { code: string, message: string, action?: string, details?: unknown } {
  return harnessErrorEnvelopeSchema.parse(result.body).error
}

/** A session cookie whose password login happened `ageMs` ago. */
async function sessionCookie(a: InstallTestApp, ageMs: number): Promise<string> {
  const token = await a.t.deps.sessions.issue({ authAt: Date.now() - ageMs })
  return `hf_session=${token}`
}

describe('inspect and install without a password', () => {
  it('inspects and installs a zip upload', async () => {
    const a = await start()
    const inspected = await send(a, '/api/plugins/inspect', multipart(declarativePlugin('route-zip')))
    expect(inspected.status).toBe(200)
    expect(pluginInspectionSchema.parse(inspected.body)).toMatchObject({ source: 'zip', requiresTrust: false })
    expect(existsSync(join(a.pluginsDir, 'route-zip'))).toBe(false)

    const installed = await send(a, '/api/plugins/install', multipart(declarativePlugin('route-zip'), { enable: 'true' }, 'route.zip'))
    expect(installed.status).toBe(201)
    expect(pluginDetailSchema.parse(installed.body)).toMatchObject({ id: 'route-zip', state: 'active', source: 'zip', sourceRef: 'route.zip' })
    expect(readdirSync(a.stagingDir)).toEqual([])
  })

  it('installs a JSON source and passes trust', async () => {
    const a = await start()
    const folder = writeFileSet(tempDir(), codePlugin('route-copy'))
    const installed = await send(a, '/api/plugins/install', json({ source: 'path', path: folder, mode: 'copy', trust: true }))
    expect(installed.status).toBe(201)
    expect(pluginDetailSchema.parse(installed.body)).toMatchObject({ id: 'route-copy', source: 'copy', state: 'active', trust: { trusted: true } })
    expect(setupRuns('route-copy')).toBe(1)
  })

  it('validates JSON and multipart bodies', async () => {
    const a = await start()
    const badJson = await send(a, '/api/plugins/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    expect(badJson.status).toBe(400)
    const badSpec = await send(a, '/api/plugins/inspect', json({ source: 'npm', spec: 'Not A Package!' }))
    expect(error(badSpec)).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['spec'] }] } })
    const relative = await send(a, '/api/plugins/install', json({ source: 'path', path: 'relative/folder', mode: 'link' }))
    expect(error(relative).code).toBe('validation_error')
    const plainUrl = await send(a, '/api/plugins/inspect', json({ source: 'url', url: 'http://example.com/p.zip', integrity: 'sha256-AAAA' }))
    expect(error(plainUrl).code).toBe('validation_error')
    const extraKey = await send(a, '/api/plugins/install', json({ source: 'npm', spec: 'pkg', admin: true }))
    expect(error(extraKey).code).toBe('validation_error')

    const unknownField = await send(a, '/api/plugins/install', multipart(declarativePlugin('x-field'), { force: 'true' }))
    expect(error(unknownField)).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['force'] }] } })
    const inspectField = await send(a, '/api/plugins/inspect', multipart(declarativePlugin('x-field'), { trust: 'true' }))
    expect(error(inspectField).code).toBe('validation_error')
    const badTrust = await send(a, '/api/plugins/install', multipart(declarativePlugin('x-field'), { trust: 'yes' }))
    expect(error(badTrust).code).toBe('validation_error')
    const form = new FormData()
    form.append('trust', 'true')
    const noFile = await send(a, '/api/plugins/install', { method: 'POST', body: form })
    expect(error(noFile)).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['file'] }] } })
    const zipSlip = await send(a, '/api/plugins/inspect', multipart({ 'plugin.json': '{}', '../evil.txt': 'x' }))
    expect(error(zipSlip).message).toContain('".." segment')
    expect(readdirSync(a.stagingDir)).toEqual([])
  })

  it('answers 413 for an upload over 20 MB', async () => {
    const a = await start()
    // A byte body with a declared length (a FormData stream cancelled half-way trips an undici bug in tests).
    const size = INSTALL_LIMITS.compressedBytes + 70 * 1024
    const tooBig = await send(a, '/api/plugins/install', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=hf', 'content-length': String(size) },
      body: new Uint8Array(size),
    })
    expect(tooBig.status).toBe(413)
    expect(error(tooBig)).toMatchObject({ code: 'payload_too_large', details: { limitBytes: INSTALL_LIMITS.compressedBytes } })
  })
})

describe('fresh auth (ADR-017)', () => {
  it('requires a recent login to install code or stdio plugins, not declarative ones', async () => {
    const a = await start({ env: { HF_PASSWORD: PASSWORD } })
    const fresh = await sessionCookie(a, 1000)
    const stale = await sessionCookie(a, FRESH_WINDOW_MS + 60_000)

    expect((await send(a, '/api/plugins/install', multipart(codePlugin('fresh-code')))).status).toBe(401)

    const refused = await send(a, '/api/plugins/install', multipart(codePlugin('fresh-code'), { trust: 'true' }), stale)
    expect(refused.status).toBe(403)
    expect(error(refused)).toMatchObject({ code: 'forbidden', action: 'login' })
    expect(existsSync(join(a.pluginsDir, 'fresh-code'))).toBe(false)
    expect(setupRuns('fresh-code')).toBe(0)
    const refusedUntrusted = await send(a, '/api/plugins/install', multipart(stdioPlugin('fresh-stdio')), stale)
    expect(error(refusedUntrusted)).toMatchObject({ code: 'forbidden', action: 'login' })
    expect(readdirSync(a.stagingDir)).toEqual([])

    // Inspecting never runs anything and needs no fresh login; declarative plugins need none either.
    expect((await send(a, '/api/plugins/inspect', multipart(codePlugin('fresh-code')), stale)).status).toBe(200)
    expect((await send(a, '/api/plugins/install', multipart(declarativePlugin('fresh-declarative')), stale)).status).toBe(201)

    const accepted = await send(a, '/api/plugins/install', multipart(codePlugin('fresh-code'), { trust: 'true' }), fresh)
    expect(accepted.status).toBe(201)
    expect(pluginDetailSchema.parse(accepted.body)).toMatchObject({ state: 'active' })
  })

  it('logs in through POST /auth/login and trusts with the current hash only', async () => {
    const a = await start({ env: { HF_PASSWORD: PASSWORD } })
    const login = await a.t.request('/api/auth/login', json({ password: PASSWORD }))
    expect(login.status).toBe(200)
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const stale = await sessionCookie(a, FRESH_WINDOW_MS + 60_000)

    const installed = pluginDetailSchema.parse((await send(a, '/api/plugins/install', multipart(codePlugin('trust-me')), cookie)).body)
    expect(installed.state).toBe('untrusted')
    const hash = installed.trust.hash!

    const notFresh = await send(a, '/api/plugins/trust-me/trust', json({ sha256: hash }), stale)
    expect(error(notFresh)).toMatchObject({ code: 'forbidden', action: 'login' })
    const wrongHash = await send(a, '/api/plugins/trust-me/trust', json({ sha256: 'f'.repeat(64) }), cookie)
    expect(wrongHash.status).toBe(409)
    expect(error(wrongHash).details).toEqual({ reason: 'stale' })
    const badBody = await send(a, '/api/plugins/trust-me/trust', json({ sha256: 'xyz' }), cookie)
    expect(badBody.status).toBe(400)
    expect((await send(a, '/api/plugins/nobody/trust', json({ sha256: hash }), cookie)).status).toBe(404)

    const trusted = await send(a, '/api/plugins/trust-me/trust', json({ sha256: hash }), cookie)
    expect(trusted.status).toBe(200)
    expect(pluginDetailSchema.parse(trusted.body)).toMatchObject({ state: 'active', trust: { trusted: true, trustedHash: hash } })
    expect(setupRuns('trust-me')).toBe(1)
  })
})

describe('export', () => {
  const builtin: BuiltinPlugin = {
    id: 'core-tools',
    manifest: { manifestVersion: 1, id: 'core-tools', name: 'Core tools', version: '1.0.0', engines: { harness: '^1.0.0' } },
    module: { setup: () => {} },
  }

  it('downloads a zip of the plugin directory', async () => {
    const a = await start({ builtins: [builtin] })
    await send(a, '/api/plugins/install', multipart({ ...declarativePlugin('export-me'), 'docs/a.md': 'a' }))
    const exported = await send(a, '/api/plugins/export-me/export')
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-type')).toBe('application/zip')
    expect(exported.headers.get('content-disposition')).toBe('attachment; filename="export-me-1.0.0.zip"; filename*=UTF-8\'\'export-me-1.0.0.zip')
    expect(exported.headers.get('cache-control')).toBe('no-store')
    const entries = await readZip(exported.body as Uint8Array, new EntryCollector(INSTALL_LIMITS))
    expect(entries.map(entry => entry.path)).toEqual(['export-me/docs/a.md', 'export-me/plugin.json'])

    expect(error(await send(a, '/api/plugins/core-tools/export')).code).toBe('forbidden')
    expect(error(await send(a, '/api/plugins/missing/export')).code).toBe('not_found')
    expect(error(await send(a, '/api/plugins/Bad_Id/export')).code).toBe('validation_error')
  })
})
