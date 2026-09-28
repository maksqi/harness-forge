import type { InstallTestApp } from './testing.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createReviewLog, reviewKey } from './reviews.ts'
import {
  allowAll,
  createFakeRegistry,
  createInstallTestApp,
  declarativePlugin,
  FAKE_REGISTRY,
  removeTempDirs,
  tempDir,
  writeFileSet,
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
