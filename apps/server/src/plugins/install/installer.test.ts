import type { PluginInstallInput } from '../types.ts'
import type { FileSet, InstallTestApp, InstallTestAppOptions } from './testing.ts'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { HarnessError, pluginDetailSchema, pluginInspectionSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSafeFetch } from '../../security/ssrf.ts'
import { pathPin } from '../loader.ts'
import { EntryCollector } from './archive.ts'
import { INSTALL_LIMITS } from './errors.ts'
import { isCredentialFile } from './export.ts'
import { integrityOf } from './integrity.ts'
import {
  allowAll,
  codePlugin,
  createFakeRegistry,
  createFakeSafeFetch,
  createInstallTestApp,
  declarativePlugin,
  FAKE_REGISTRY,
  inFolder,
  manifestOf,
  removeTempDirs,
  setupRuns,
  stdioPlugin,
  tempDir,
  tgzOf,
  writeFileSet,
  zipOf,
} from './testing.ts'
import { readZip } from './zip.ts'

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

function zip(files: FileSet, fileName = 'plugin.zip'): PluginInstallInput {
  return { source: 'zip', fileName, data: zipOf(files) }
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

function stagingEntries(a: InstallTestApp): string[] {
  return existsSync(a.stagingDir) ? readdirSync(a.stagingDir) : []
}

describe('inspect', () => {
  it('previews a zip without installing anything', async () => {
    const a = await start()
    const inspection = await a.t.deps.installer.inspect(zip(declarativePlugin('acme-zip')))
    expect(pluginInspectionSchema.parse(inspection)).toMatchObject({
      source: 'zip',
      kind: 'declarative',
      requiresTrust: false,
      compatible: true,
      existing: null,
      networkHosts: ['api.example.com'],
      secretsRequested: ['API key (Provider acme-zip)'],
      contributions: { providers: ['acme-zip'], models: 1 },
      files: { count: 1 },
      warnings: [],
    })
    expect(inspection.sha256).toMatch(/^[\da-f]{64}$/)
    expect(stagingEntries(a)).toEqual([])
    expect(existsSync(join(a.pluginsDir, 'acme-zip'))).toBe(false)
    expect(await a.t.deps.plugins.record('acme-zip')).toBeNull()
  })

  it('reports code, programs, plain HTTP, private hosts, secrets and the installed version', async () => {
    const a = await start()
    const code = await a.t.deps.installer.inspect(zip(codePlugin('code-preview')))
    expect(code).toMatchObject({ kind: 'code', requiresTrust: true, permissions: ['storage'] })
    expect(code.warnings).toContain('Runs code with full server privileges.')

    const stdio = await a.t.deps.installer.inspect(zip(stdioPlugin('stdio-preview')))
    expect(stdio).toMatchObject({ kind: 'declarative', requiresTrust: true, secretsRequested: [] })
    expect(stdio.warnings).toContain('Starts a program on your server: node server.mjs')

    const local = await a.t.deps.installer.inspect(zip({
      'plugin.json': manifestOf('local-llm', {
        settings: { type: 'object', properties: { token: { type: 'string', format: 'secret', title: 'Token' } } },
        contributes: {
          providers: [{ id: 'local-llm', name: 'Local', baseURL: 'http://192.168.1.20:8080/v1', apiFormat: 'openai-chat', auth: { type: 'none' } }],
          mcpServers: [{ id: 'local-llm', name: 'Docs', transport: { type: 'http', url: 'https://{{settings.token}}.example.com/mcp', headers: { Authorization: 'Bearer {{settings.token}}' } } }],
        },
      }),
    }))
    expect(local.networkHosts).toEqual(['192.168.1.20:8080', '{{settings.token}}.example.com'])
    expect(local.secretsRequested).toEqual(['Token (setting)', 'Authorization header (Docs)'])
    expect(local.warnings).toEqual([
      'Sends requests over unencrypted HTTP to 192.168.1.20:8080.',
      'Connects to a local or private network address: 192.168.1.20:8080.',
    ])

    await a.t.deps.installer.install(zip(declarativePlugin('acme-zip')), { authorize: allowAll })
    const again = await a.t.deps.installer.inspect(zip(declarativePlugin('acme-zip', { version: '0.9.0' })))
    expect(again.existing).toMatchObject({ version: '1.0.0', state: 'active', source: 'zip' })
    expect(again.warnings).toContain('Downgrades the installed version 1.0.0 to 0.9.0.')
  })

  it('refuses reserved ids and archives without a valid plugin.json, and cleans the staging area', async () => {
    const a = await start()
    const reserved = await rejection(a.t.deps.installer.inspect(zip(declarativePlugin('core-evil'))))
    expect(reserved).toMatchObject({ code: 'validation_error' })
    expect(reserved.message).toContain('reserved')
    const missing = await rejection(a.t.deps.installer.inspect(zip({ 'readme.md': 'no manifest' })))
    expect(missing.message).toContain('plugin.json must be at the root')
    const invalid = await rejection(a.t.deps.installer.inspect(zip({ 'plugin.json': '{"manifestVersion":1,"id":"x"}' })))
    expect(invalid.code).toBe('validation_error')
    const outside = await rejection(a.t.deps.installer.inspect(zip({ 'plugin.json': manifestOf('entry-out', { main: 'index.mjs' }) })))
    expect(outside.message).toContain('entry')
    expect(stagingEntries(a)).toEqual([])
  })
})

describe('install from zip', () => {
  it('installs a declarative plugin, unwrapping a single top-level folder', async () => {
    const a = await start()
    const detail = await a.t.deps.installer.install(zip(inFolder('acme-1.0', { ...declarativePlugin('acme-zip'), 'docs/readme.md': 'hi' }), 'acme.zip'), { authorize: allowAll })
    expect(pluginDetailSchema.parse(detail)).toMatchObject({ id: 'acme-zip', state: 'active', source: 'zip', sourceRef: 'acme.zip', enabled: true })
    const dir = join(a.pluginsDir, 'acme-zip')
    expect(readFileSync(join(dir, 'docs', 'readme.md'), 'utf8')).toBe('hi')
    expect(statSync(join(dir, 'plugin.json')).mode & 0o777).toBe(0o644)
    expect(statSync(join(dir, 'docs')).mode & 0o777).toBe(0o755)
    expect(statSync(dir).mode & 0o777).toBe(0o755)
    expect(stagingEntries(a)).toEqual([])
    expect(a.events.ofType('plugin.changed').some(event => event.data.id === 'acme-zip' && event.data.plugin?.state === 'active')).toBe(true)
  })

  it('keeps an untrusted code plugin inert until it is trusted', async () => {
    const a = await start()
    const authorize = vi.fn()
    const detail = await a.t.deps.installer.install(zip(codePlugin('inert-code')), { authorize })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ kind: 'code', requiresTrust: true }))
    expect(detail).toMatchObject({ state: 'untrusted', trust: { required: true, trusted: false, trustedHash: null } })
    expect(setupRuns('inert-code')).toBe(0)
    const trusted = await a.t.deps.plugins.trust('inert-code', detail.trust.hash!)
    expect(trusted.state).toBe('active')
    expect(setupRuns('inert-code')).toBe(1)
  })

  it('pins the hash with trust; a changed entry needs trust again', async () => {
    const a = await start()
    const v1 = await a.t.deps.installer.install(zip(codePlugin('pinned-code', { marker: 'v1' })), { trust: true, authorize: allowAll })
    expect(v1).toMatchObject({ state: 'active', trust: { trusted: true } })
    expect(v1.trust.trustedHash).toBe(v1.trust.hash)
    const v2 = await a.t.deps.installer.install(zip(codePlugin('pinned-code', { version: '1.1.0', marker: 'v2' })), { authorize: allowAll })
    expect(v2).toMatchObject({ state: 'untrusted', version: '1.1.0', trust: { trusted: false, trustedHash: v1.trust.hash } })
    expect(v2.trust.hash).not.toBe(v1.trust.hash)
    expect(readFileSync(join(a.pluginsDir, 'pinned-code', 'index.mjs'), 'utf8')).toContain('v2')
    expect(stagingEntries(a)).toEqual([])
  })

  it('keeps the previous version when the update fails to load', async () => {
    const a = await start()
    await a.t.deps.installer.install(zip(codePlugin('stable-code', { marker: 'v1' })), { trust: true, authorize: allowAll })
    const entry = join(a.pluginsDir, 'stable-code', 'index.mjs')
    const before = readFileSync(entry, 'utf8')
    const error = await rejection(a.t.deps.installer.install(zip(codePlugin('stable-code', { version: '2.0.0', fail: true })), { trust: true, authorize: allowAll }))
    expect(error).toMatchObject({ code: 'plugin_error', details: { pluginId: 'stable-code', phase: 'install' } })
    expect(error.message).toContain('setup failed on purpose')
    expect(readFileSync(entry, 'utf8')).toBe(before)
    const detail = await a.t.deps.plugins.get('stable-code')
    expect(detail).toMatchObject({ state: 'active', version: '1.0.0', trust: { trusted: true } })
    expect(await a.t.deps.plugins.record('stable-code')).toMatchObject({ version: '1.0.0', source: 'zip' })
    expect(stagingEntries(a)).toEqual([])
  })

  it('removes a fresh install that fails to load', async () => {
    const a = await start()
    const error = await rejection(a.t.deps.installer.install(zip(codePlugin('broken-code', { fail: true })), { trust: true, authorize: allowAll }))
    expect(error.code).toBe('plugin_error')
    expect(existsSync(join(a.pluginsDir, 'broken-code'))).toBe(false)
    expect(await a.t.deps.plugins.record('broken-code')).toBeNull()
    expect((await a.t.deps.plugins.list()).map(plugin => plugin.id)).not.toContain('broken-code')
    expect(stagingEntries(a)).toEqual([])
  })

  it('commits nothing when authorize refuses (fresh auth missing)', async () => {
    const a = await start()
    const refused = new HarnessError({ code: 'forbidden', message: 'Confirm your password.', action: 'login' })
    const error = await rejection(a.t.deps.installer.install(zip(codePlugin('guarded-code')), {
      trust: true,
      authorize: () => {
        throw refused
      },
    }))
    expect(error).toBe(refused)
    expect(existsSync(join(a.pluginsDir, 'guarded-code'))).toBe(false)
    expect(await a.t.deps.plugins.record('guarded-code')).toBeNull()
    expect(stagingEntries(a)).toEqual([])
  })

  it('refuses reserved ids, incompatible plugins and an id installed from another source', async () => {
    const a = await start()
    const reserved = await rejection(a.t.deps.installer.install(zip(declarativePlugin('openai')), { authorize: allowAll }))
    expect(reserved.code).toBe('forbidden')

    const future = zip({ 'plugin.json': manifestOf('future-api', { engines: { harness: '^2.0.0' } }) })
    const inspection = await a.t.deps.installer.inspect(future)
    expect(inspection.compatible).toBe(false)
    expect(inspection.warnings.join(' ')).toContain('Needs plugin API ^2.0.0')
    expect((await rejection(a.t.deps.installer.install(future, { authorize: allowAll }))).code).toBe('validation_error')

    const folder = writeFileSet(join(tempDir(), 'shared-id'), declarativePlugin('shared-id'))
    await a.t.deps.installer.install({ source: 'path', path: folder, mode: 'link' }, { authorize: allowAll })
    const conflict = await rejection(a.t.deps.installer.install(zip(declarativePlugin('shared-id')), { authorize: allowAll }))
    expect(conflict).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    const preview = await a.t.deps.installer.inspect(zip(declarativePlugin('shared-id')))
    expect(preview.warnings.join(' ')).toContain('uninstall it first')
    expect(stagingEntries(a)).toEqual([])
  })

  it('refuses a stray folder that has no row', async () => {
    const a = await start()
    mkdirSync(join(a.pluginsDir, 'stray-folder'))
    const error = await rejection(a.t.deps.installer.install(zip(declarativePlugin('stray-folder')), { authorize: allowAll }))
    expect(error).toMatchObject({ code: 'conflict' })
    expect(readdirSync(join(a.pluginsDir, 'stray-folder'))).toEqual([])
  })

  it('updates in place and keeps the enabled choice', async () => {
    const a = await start()
    await a.t.deps.installer.install(zip(declarativePlugin('toggle-me')), { authorize: allowAll })
    await a.t.deps.plugins.disable('toggle-me')
    const updated = await a.t.deps.installer.install(zip(declarativePlugin('toggle-me', { version: '1.1.0' })), { authorize: allowAll })
    expect(updated).toMatchObject({ version: '1.1.0', enabled: false, state: 'disabled' })
    const enabled = await a.t.deps.installer.install(zip(declarativePlugin('toggle-me', { version: '1.2.0' })), { enable: true, authorize: allowAll })
    expect(enabled).toMatchObject({ version: '1.2.0', enabled: true, state: 'active' })
    expect(stagingEntries(a)).toEqual([])
  })

  it('installs a stdio MCP plugin untrusted unless trust is given', async () => {
    const a = await start()
    const detail = await a.t.deps.installer.install(zip(stdioPlugin('stdio-install')), { authorize: allowAll })
    expect(detail).toMatchObject({ state: 'untrusted', runsCode: true })
  })
})

describe('install from npm and URL', () => {
  it('installs a verified npm package', async () => {
    const registry = createFakeRegistry({ 'npm-plugin': { versions: { '1.0.0': { files: declarativePlugin('npm-plugin') }, '1.1.0': { files: declarativePlugin('npm-plugin', { version: '1.1.0' }) } } } })
    const a = await start({ installer: { fetch: registry.fetch, npmRegistry: FAKE_REGISTRY } })
    const detail = await a.t.deps.installer.install({ source: 'npm', spec: 'npm-plugin@^1.0.0' }, { authorize: allowAll })
    expect(detail).toMatchObject({ id: 'npm-plugin', source: 'npm', sourceRef: 'npm-plugin@1.1.0', state: 'active', version: '1.1.0' })
    expect(stagingEntries(a)).toEqual([])
  })

  it('installs nothing when the tarball does not match its integrity', async () => {
    const registry = createFakeRegistry({ tampered: { versions: { '1.0.0': { files: declarativePlugin('tampered'), integrity: integrityOf(new Uint8Array([1])) } } } })
    const a = await start({ installer: { fetch: registry.fetch, npmRegistry: FAKE_REGISTRY } })
    const error = await rejection(a.t.deps.installer.install({ source: 'npm', spec: 'tampered' }, { authorize: allowAll }))
    expect(error.code).toBe('validation_error')
    expect(existsSync(join(a.pluginsDir, 'tampered'))).toBe(false)
    expect(stagingEntries(a)).toEqual([])
  })

  it('installs zip and tgz URLs through SafeFetch with a verified integrity', async () => {
    const zipData = zipOf(declarativePlugin('url-zip'))
    const tgzData = tgzOf(Object.entries(declarativePlugin('url-tgz')).map(([path, data]) => ({ name: `url-tgz/${path}`, data })))
    const fake = createFakeSafeFetch({
      'https://plugins.example/url-zip.zip': zipData,
      'https://plugins.example/download?id=2': tgzData,
      'https://plugins.example/missing.zip': 404,
      'https://plugins.example/readme.txt': new TextEncoder().encode('just text'),
    })
    const a = await start({ installer: { safeFetch: fake.safeFetch } })
    const fromZip = await a.t.deps.installer.install({ source: 'url', url: 'https://plugins.example/url-zip.zip', integrity: integrityOf(zipData, 'sha256') }, { authorize: allowAll })
    expect(fromZip).toMatchObject({ id: 'url-zip', source: 'url', sourceRef: 'https://plugins.example/url-zip.zip', state: 'active' })
    expect(fake.calls[0]!.options).toMatchObject({ maxBytes: INSTALL_LIMITS.compressedBytes, protocols: ['https:'], maxRedirects: 3 })
    const fromTgz = await a.t.deps.installer.install({ source: 'url', url: 'https://plugins.example/download?id=2', integrity: integrityOf(tgzData) }, { authorize: allowAll })
    expect(fromTgz).toMatchObject({ id: 'url-tgz', state: 'active' })

    const mismatch = await rejection(a.t.deps.installer.inspect({ source: 'url', url: 'https://plugins.example/url-zip.zip', integrity: integrityOf(tgzData) }))
    expect(mismatch).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['integrity'] }] } })
    const blocked = await rejection(a.t.deps.installer.inspect({ source: 'url', url: 'https://10.0.0.1/x.zip', integrity: integrityOf(zipData) }))
    expect(blocked.code).toBe('validation_error')
    expect(await rejection(a.t.deps.installer.inspect({ source: 'url', url: 'https://plugins.example/missing.zip', integrity: integrityOf(zipData) })))
      .toMatchObject({ code: 'provider_error', status: 404 })
    const text = new TextEncoder().encode('just text')
    const notArchive = await rejection(a.t.deps.installer.inspect({ source: 'url', url: 'https://plugins.example/readme.txt', integrity: integrityOf(text) }))
    expect(notArchive.message).toContain('.zip or .tgz')
    expect(stagingEntries(a)).toEqual([])
  })
})

describe('url installs through the real SSRF guard', () => {
  it('refuses loopback, link-local and private targets before connecting', async () => {
    // `internal.example` resolves to a private address; no request leaves the process.
    const lookup = async () => [{ address: '10.1.2.3', family: 4 as const }]
    const a = await start({ installer: { safeFetch: createSafeFetch({ lookup }) } })
    const integrity = integrityOf(new Uint8Array([1]))
    for (const url of ['https://127.0.0.1/p.zip', 'https://169.254.169.254/latest/p.zip', 'https://[::1]/p.zip', 'https://internal.example/p.zip']) {
      const error = await rejection(a.t.deps.installer.inspect({ source: 'url', url, integrity }))
      expect(error.code, url).toBe('validation_error')
    }
    expect(stagingEntries(a)).toEqual([])
  })
})

describe('install from a local folder', () => {
  it('links a folder in place with a path pin', async () => {
    const a = await start()
    const folder = writeFileSet(join(tempDir(), 'linked-code'), codePlugin('linked-code'))
    const inspection = await a.t.deps.installer.inspect({ source: 'path', path: folder, mode: 'link' })
    expect(inspection).toMatchObject({ source: 'link', requiresTrust: true })
    expect(inspection.warnings).toContain('Linked folder: file changes reload the plugin without another trust review.')
    const detail = await a.t.deps.installer.install({ source: 'path', path: folder, mode: 'link' }, { trust: true, authorize: allowAll })
    const real = realpathSync(folder)
    expect(detail).toMatchObject({ source: 'link', sourceRef: real, state: 'active', trust: { trusted: true, trustedHash: pathPin(real) } })
    expect(existsSync(join(a.pluginsDir, 'linked-code'))).toBe(false)
    expect(stagingEntries(a)).toEqual([])
  })

  it('refuses a linked folder named differently, the data directory and missing folders', async () => {
    const a = await start()
    const wrong = writeFileSet(join(tempDir(), 'wrong-name'), declarativePlugin('right-name'))
    expect((await rejection(a.t.deps.installer.install({ source: 'path', path: wrong, mode: 'link' }, { authorize: allowAll }))).message)
      .toContain('rename "wrong-name" to "right-name"')
    const inside = writeFileSet(join(a.t.env.paths.root, 'inside'), declarativePlugin('inside'))
    const insideError = await rejection(a.t.deps.installer.inspect({ source: 'path', path: inside, mode: 'copy' }))
    expect(insideError).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
    expect(insideError.message).toContain('outside the harness-forge data directory')
    const containing = await rejection(a.t.deps.installer.inspect({ source: 'path', path: join(a.t.env.paths.root, '..'), mode: 'link' }))
    expect(containing.message).toContain('outside the harness-forge data directory')
    expect((await rejection(a.t.deps.installer.inspect({ source: 'path', path: '/definitely/not/here', mode: 'copy' }))).message).toContain('does not exist')
  })

  it.skipIf(process.platform === 'win32')('refuses to link a folder any local user could change (world-writable, or in a replaceable parent)', async () => {
    const a = await start()
    const open = writeFileSet(join(tempDir(), 'open-plugin'), codePlugin('open-plugin'))
    chmodSync(open, 0o777)
    const refused = await rejection(a.t.deps.installer.inspect({ source: 'path', path: open, mode: 'link' }))
    expect(refused).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['path'] }] } })
    expect(refused.message).toContain('chmod o-w')
    // A copy snapshots the files and pins their hash: it stays allowed.
    expect((await a.t.deps.installer.inspect({ source: 'path', path: open, mode: 'copy' })).source).toBe('copy')

    const shared = join(tempDir(), 'shared')
    const inShared = writeFileSet(join(shared, 'shared-plugin'), codePlugin('shared-plugin'))
    chmodSync(shared, 0o777)
    expect((await rejection(a.t.deps.installer.inspect({ source: 'path', path: inShared, mode: 'link' }))).message).toContain('world-writable')
    // With the sticky bit (like /tmp) nobody else can rename the folder: linking is fine.
    chmodSync(shared, 0o1777)
    expect((await a.t.deps.installer.inspect({ source: 'path', path: inShared, mode: 'link' })).source).toBe('link')
    chmodSync(shared, 0o755)
  })

  it('copies a folder without node_modules and .git, refusing links inside', async () => {
    const a = await start()
    const folder = writeFileSet(tempDir(), {
      ...declarativePlugin('copied-plugin'),
      'notes/readme.md': 'notes',
      'node_modules/dep/index.js': 'module.exports = 1',
      '.git/HEAD': 'ref: refs/heads/main',
    })
    const detail = await a.t.deps.installer.install({ source: 'path', path: folder, mode: 'copy' }, { authorize: allowAll })
    expect(detail).toMatchObject({ id: 'copied-plugin', source: 'copy', sourceRef: realpathSync(folder), state: 'active', editable: true })
    const dir = join(a.pluginsDir, 'copied-plugin')
    expect(readdirSync(dir).sort()).toEqual(['notes', 'plugin.json'])

    const withLink = writeFileSet(tempDir(), declarativePlugin('link-inside'))
    symlinkSync('/etc/hosts', join(withLink, 'hosts'))
    expect((await rejection(a.t.deps.installer.inspect({ source: 'path', path: withLink, mode: 'copy' }))).message).toContain('symbolic link')
    const noManifest = writeFileSet(tempDir(), inFolder('nested', declarativePlugin('nested')))
    expect((await rejection(a.t.deps.installer.inspect({ source: 'path', path: noManifest, mode: 'copy' }))).message).toContain('no plugin.json')
    expect(stagingEntries(a)).toEqual([])
  })
})

describe('export', () => {
  it('exports an installable zip without node_modules, .git and local credential files', async () => {
    const a = await start()
    await a.t.deps.installer.install(zip({ ...declarativePlugin('exported'), 'docs/readme.md': 'docs', '.env': 'API_KEY=local-secret', '.env.local': 'X=1', '.npmrc': '//registry.npmjs.org/:_authToken=npm_secret', 'docs/.ENV.production': 'Y=2', '.envrc': 'kept' }), { authorize: allowAll })
    mkdirSync(join(a.pluginsDir, 'exported', 'node_modules'))
    writeFileSync(join(a.pluginsDir, 'exported', 'node_modules', 'x.js'), 'x')
    symlinkSync('/etc/hosts', join(a.pluginsDir, 'exported', 'hosts-link'))
    const exported = await a.t.deps.installer.export('exported')
    expect(exported.fileName).toBe('exported-1.0.0.zip')
    const entries = await readZip(exported.data, new EntryCollector(INSTALL_LIMITS))
    expect(entries.map(entry => entry.path)).toEqual(['exported/.envrc', 'exported/docs/readme.md', 'exported/plugin.json'])
    expect(isCredentialFile('.Env')).toBe(true)
    expect(isCredentialFile('env.example')).toBe(false)
    const reinstalled = await a.t.deps.installer.install({ source: 'zip', fileName: exported.fileName, data: exported.data }, { authorize: allowAll })
    expect(reinstalled).toMatchObject({ id: 'exported', state: 'active', sourceRef: 'exported-1.0.0.zip' })
    expect((await rejection(a.t.deps.installer.export('unknown-plugin'))).code).toBe('not_found')
  })
})

describe('recover', () => {
  it('restores an interrupted update at boot and removes leftovers', async () => {
    const dataDir = tempDir()
    const staging = join(dataDir, 'plugins', '.staging')
    writeFileSet(join(staging, 'restored-plugin.prev-0b0f8c2e-6a39-4d4b-9f39-2f1f2f3f4f5f'), declarativePlugin('restored-plugin'))
    writeFileSet(join(staging, '6c3c9d8e-1b2a-4c3d-8e9f-0a1b2c3d4e5f'), { 'half.txt': 'x' })
    const a = await start({ dataDir })
    expect(stagingEntries(a)).toEqual([])
    expect((await a.t.deps.plugins.get('restored-plugin')).state).toBe('active')
  })
})
