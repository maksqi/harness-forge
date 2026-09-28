import type { PluginInstallOptions } from '../types.ts'
import type { InstallTestApp } from './testing.ts'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginInspectionSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { integrityOf } from './integrity.ts'
import { checkReviewedHash, createReviewLog, reviewedHashOf, reviewKey } from './reviews.ts'
import {
  allowAll,
  codePlugin,
  createFakeRegistry,
  createFakeSafeFetch,
  createInstallTestApp,
  declarativePlugin,
  FAKE_REGISTRY,
  removeTempDirs,
  setupRuns,
  tempDir,
  writeFileSet,
  zipOf,
} from './testing.ts'

let app: InstallTestApp | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
  removeTempDirs()
})

async function rejection(promise: Promise<unknown>): Promise<{ code: string, message: string, details?: unknown }> {
  try {
    await promise
  }
  catch (error) {
    return error as { code: string, message: string }
  }
  throw new Error('expected a rejection')
}

describe('review log', () => {
  it('keys only sources whose content can change and expires entries', () => {
    expect(reviewKey({ source: 'npm', spec: ' pkg@latest ' })).toBe('npm:pkg@latest')
    expect(reviewKey({ source: 'path', path: '/srv/p', mode: 'copy' })).toBe('path:copy:/srv/p')
    expect(reviewKey({ source: 'zip', fileName: 'a.zip', data: new Uint8Array(1) })).toBeNull()
    expect(reviewKey({ source: 'url', url: 'https://x.test/a.zip', integrity: 'sha256-x' })).toBeNull()

    let now = 0
    const log = createReviewLog(() => now)
    const input = { source: 'npm', spec: 'pkg' } as const
    log.check(input, 'a')
    log.remember(input, 'a')
    log.check(input, 'a')
    expect(() => log.check(input, 'b')).toThrow(/changed since you reviewed it/)
    now += 31 * 60 * 1000
    log.check(input, 'b')
    log.remember(input, 'b')
    log.forget(input)
    log.check(input, 'c')
  })

  it('checks a reviewed hash sent with the install request', () => {
    expect(() => checkReviewedHash('a'.repeat(64), 'a'.repeat(64))).not.toThrow()
    expect(() => checkReviewedHash('a'.repeat(64), 'b'.repeat(64))).toThrow(/changed since you reviewed it/)
    const options: PluginInstallOptions & { sha256?: string } = { authorize: allowAll, sha256: 'c'.repeat(64) }
    expect(reviewedHashOf(options)).toBe('c'.repeat(64))
    expect(reviewedHashOf({ authorize: allowAll })).toBeUndefined()
  })
})

describe('install after inspect', () => {
  it('refuses an npm tag that moved to another version since the inspection', async () => {
    const v1 = createFakeRegistry({ 'moving-tag': { versions: { '1.0.0': { files: declarativePlugin('moving-tag') } } } })
    const v2 = createFakeRegistry({ 'moving-tag': { versions: {
      '1.0.0': { files: declarativePlugin('moving-tag') },
      '2.0.0': { files: declarativePlugin('moving-tag', { version: '2.0.0' }) },
    } } })
    let registry = v1
    const a = app = await createInstallTestApp({ installer: { fetch: (...args) => registry.fetch(...args), npmRegistry: FAKE_REGISTRY } })

    const inspection = await a.t.deps.installer.inspect({ source: 'npm', spec: 'moving-tag' })
    expect(inspection.manifest.version).toBe('1.0.0')
    registry = v2
    const stale = await rejection(a.t.deps.installer.install({ source: 'npm', spec: 'moving-tag' }, { trust: true, authorize: allowAll }))
    expect(stale).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    expect(await a.t.deps.plugins.record('moving-tag')).toBeNull()

    const again = await a.t.deps.installer.inspect({ source: 'npm', spec: 'moving-tag' })
    expect(again.manifest.version).toBe('2.0.0')
    const detail = await a.t.deps.installer.install({ source: 'npm', spec: 'moving-tag' }, { authorize: allowAll })
    expect(detail).toMatchObject({ version: '2.0.0', sourceRef: 'moving-tag@2.0.0' })
  })

  it('refuses a folder that changed since the inspection', async () => {
    const a = app = await createInstallTestApp()
    const folder = writeFileSet(tempDir(), declarativePlugin('changing-folder'))
    await a.t.deps.installer.inspect({ source: 'path', path: folder, mode: 'copy' })
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'changing-folder', name: 'Changed', version: '1.0.1', engines: { harness: '^1.0.0' } }))
    const stale = await rejection(a.t.deps.installer.install({ source: 'path', path: folder, mode: 'copy' }, { authorize: allowAll }))
    expect(stale).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    await a.t.deps.installer.inspect({ source: 'path', path: folder, mode: 'copy' })
    expect(await a.t.deps.installer.install({ source: 'path', path: folder, mode: 'copy' }, { authorize: allowAll })).toMatchObject({ version: '1.0.1' })
  })
})

describe('install with the reviewed sha256 (PluginInstallBody.sha256)', () => {
  it('installs what was reviewed and refuses another package with conflict (stale), for every source', async () => {
    const zipV1 = zipOf(declarativePlugin('pinned-zip'))
    const zipV2 = zipOf(declarativePlugin('pinned-zip', { version: '1.0.1' }))
    const fake = createFakeSafeFetch({ 'https://plugins.example/pinned.zip': zipV2 })
    const a = app = await createInstallTestApp({ installer: { safeFetch: fake.safeFetch } })
    const installer = a.t.deps.installer

    const reviewed = (await installer.inspect({ source: 'zip', fileName: 'pinned.zip', data: zipV1 })).sha256
    const other = await rejection(installer.install({ source: 'zip', fileName: 'pinned.zip', data: zipV2 }, { authorize: allowAll, sha256: reviewed } as PluginInstallOptions))
    expect(other).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    const url = { source: 'url', url: 'https://plugins.example/pinned.zip', integrity: integrityOf(zipV2, 'sha256') } as const
    expect(await rejection(installer.install(url, { authorize: allowAll, sha256: reviewed } as PluginInstallOptions)))
      .toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    expect(await a.t.deps.plugins.record('pinned-zip')).toBeNull()

    const detail = await installer.install({ source: 'zip', fileName: 'pinned.zip', data: zipV1 }, { authorize: allowAll, sha256: reviewed } as PluginInstallOptions)
    expect(detail).toMatchObject({ id: 'pinned-zip', version: '1.0.0', state: 'active' })
  })

  it('checks the hash before authorize: a stale package never asks for fresh auth and never runs', async () => {
    const a = app = await createInstallTestApp()
    const folder = writeFileSet(tempDir(), codePlugin('pinned-code'))
    const input = { source: 'path', path: folder, mode: 'copy' } as const
    const reviewed = (await a.t.deps.installer.inspect(input)).sha256
    writeFileSync(join(folder, 'index.mjs'), 'export default { setup() { globalThis.__hfPinnedChanged = true } }\n')
    let authorized = 0
    const stale = await rejection(a.t.deps.installer.install(input, { trust: true, sha256: reviewed, authorize: () => {
      authorized += 1
    } } as PluginInstallOptions))
    expect(stale).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    expect(authorized).toBe(0)
    expect(setupRuns('pinned-code')).toBe(0)
    expect(await a.t.deps.plugins.record('pinned-code')).toBeNull()
  })

  it('the request hash wins over the in-memory review of the same source', async () => {
    const a = app = await createInstallTestApp()
    const folder = writeFileSet(tempDir(), declarativePlugin('pinned-folder'))
    const input = { source: 'path', path: folder, mode: 'copy' } as const
    await a.t.deps.installer.inspect(input)
    writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'pinned-folder', name: 'Changed', version: '1.0.1', engines: { harness: '^1.0.0' } }))
    // Reviewed again in another tab (or on another server process): the memory still holds the first hash.
    const current = pluginInspectionSchema.parse(await a.t.deps.installer.inspect(input))
    const detail = await a.t.deps.installer.install(input, { authorize: allowAll, sha256: current.sha256 } as PluginInstallOptions)
    expect(detail).toMatchObject({ version: '1.0.1' })
  })

  it('the inspection names the resolved source (sourceRef) for "I trust <source>"', async () => {
    const registry = createFakeRegistry({ 'ref-npm': { versions: { '1.2.3': { files: declarativePlugin('ref-npm') } } } })
    const zipData = zipOf(declarativePlugin('ref-url'))
    const fake = createFakeSafeFetch({ 'https://plugins.example/ref.zip': zipData })
    const a = app = await createInstallTestApp({ installer: { fetch: registry.fetch, npmRegistry: FAKE_REGISTRY, safeFetch: fake.safeFetch } })
    const installer = a.t.deps.installer
    const folder = writeFileSet(tempDir(), declarativePlugin('ref-folder'))

    expect((await installer.inspect({ source: 'npm', spec: 'ref-npm@^1' })).sourceRef).toBe('ref-npm@1.2.3')
    expect((await installer.inspect({ source: 'url', url: 'https://plugins.example/ref.zip', integrity: integrityOf(zipData) })).sourceRef)
      .toBe('https://plugins.example/ref.zip')
    expect((await installer.inspect({ source: 'path', path: folder, mode: 'copy' })).sourceRef).toBe(realpathSync(folder))
    expect((await installer.inspect({ source: 'zip', fileName: '../My Plugin.zip', data: zipOf(declarativePlugin('ref-zip')) })).sourceRef)
      .toBe('My Plugin.zip')
  })
})
