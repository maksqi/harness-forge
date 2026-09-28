import { describe, expect, it } from 'vitest'
import { INSTALL_LIMITS } from './errors.ts'
import { integrityOf, parseIntegrity, verifyIntegrity } from './integrity.ts'
import { downloadNpmPackage, packageMetadataUrl, parseNpmSpec, resolvePackage, resolveVersion } from './npm.ts'
import { createFakeRegistry, declarativePlugin, FAKE_REGISTRY, npmTarball } from './testing.ts'

async function rejection(promise: Promise<unknown>): Promise<{ code: string, message: string, status?: number, details?: unknown }> {
  try {
    await promise
  }
  catch (error) {
    return error as { code: string, message: string }
  }
  throw new Error('expected a rejection')
}

const data = new TextEncoder().encode('tarball bytes')

describe('integrity', () => {
  it('verifies sha512 and sha256 SRI strings', () => {
    expect(verifyIntegrity(data, integrityOf(data, 'sha512'), ['sha512'])).toBe(true)
    expect(verifyIntegrity(data, integrityOf(data, 'sha256'), ['sha256', 'sha512'])).toBe(true)
    expect(verifyIntegrity(new TextEncoder().encode('other'), integrityOf(data), ['sha512'])).toBe(false)
    // An algorithm that is not allowed never matches; several hashes: the strongest algorithm decides.
    expect(verifyIntegrity(data, integrityOf(data, 'sha256'), ['sha512'])).toBe(false)
    expect(verifyIntegrity(data, `${integrityOf(data, 'sha256')} ${integrityOf(new Uint8Array([1]), 'sha512')}`, ['sha256', 'sha512'])).toBe(false)
    expect(verifyIntegrity(data, `${integrityOf(new Uint8Array([1]), 'sha512')} ${integrityOf(data, 'sha512')}?opt`, ['sha512'])).toBe(true)
  })

  it('skips malformed tokens', () => {
    expect(parseIntegrity('sha512-short sha1-abc md5-xyz nothing', ['sha512'])).toEqual([])
    expect(verifyIntegrity(data, '', ['sha512'])).toBe(false)
  })
})

describe('npm specs and versions', () => {
  it('parses specs', () => {
    expect(parseNpmSpec('harness-plugin-x')).toEqual({ name: 'harness-plugin-x', selector: null })
    expect(parseNpmSpec('harness-plugin-x@1.2.3')).toEqual({ name: 'harness-plugin-x', selector: '1.2.3' })
    expect(parseNpmSpec('@scope/pkg')).toEqual({ name: '@scope/pkg', selector: null })
    expect(parseNpmSpec('@scope/pkg@^2')).toEqual({ name: '@scope/pkg', selector: '^2' })
    expect(packageMetadataUrl('https://registry.npmjs.org/', '@scope/pkg')).toBe('https://registry.npmjs.org/@scope%2Fpkg')
  })

  const metadata = {
    'name': 'pkg',
    'dist-tags': { latest: '1.2.0', next: '2.0.0-beta.1' },
    'versions': { '1.0.0': {}, '1.2.0': {}, '1.3.0': {}, '2.0.0-beta.1': {} },
  }

  it('resolves versions, ranges and dist-tags like npm', () => {
    expect(resolveVersion(metadata, { name: 'pkg', selector: null })).toBe('1.2.0')
    expect(resolveVersion(metadata, { name: 'pkg', selector: '1.0.0' })).toBe('1.0.0')
    expect(resolveVersion(metadata, { name: 'pkg', selector: 'next' })).toBe('2.0.0-beta.1')
    // `latest` wins when it satisfies the range; otherwise the highest match.
    expect(resolveVersion(metadata, { name: 'pkg', selector: '^1.0.0' })).toBe('1.2.0')
    expect(resolveVersion(metadata, { name: 'pkg', selector: '>=1.3.0 <2' })).toBe('1.3.0')
    expect(() => resolveVersion(metadata, { name: 'pkg', selector: '9.9.9' })).toThrow(/no version matching/)
    expect(() => resolveVersion(metadata, { name: 'pkg', selector: 'missing-tag' })).toThrow(/no version matching/)
    expect(() => resolveVersion({ nope: true }, { name: 'pkg', selector: null })).toThrow(/unreadable metadata/)
  })

  it('requires a same-origin tarball and a sha512 integrity', () => {
    const version = (dist: Record<string, unknown>) => ({ ...metadata, versions: { '1.2.0': { version: '1.2.0', dist } } })
    const integrity = integrityOf(data)
    expect(resolvePackage(version({ tarball: `${FAKE_REGISTRY}/pkg/-/pkg-1.2.0.tgz`, integrity }), { name: 'pkg', selector: null }, FAKE_REGISTRY))
      .toMatchObject({ version: '1.2.0', integrity, warnings: [] })
    expect(() => resolvePackage(version({ tarball: 'https://evil.example/pkg.tgz', integrity }), { name: 'pkg', selector: null }, FAKE_REGISTRY))
      .toThrow(/not served by registry.test/)
    expect(() => resolvePackage(version({ tarball: `${FAKE_REGISTRY}/pkg.tgz`, integrity: 'sha1-abc' }), { name: 'pkg', selector: null }, FAKE_REGISTRY))
      .toThrow(/no sha512 integrity/)
  })
})

describe('downloadNpmPackage', () => {
  const files = declarativePlugin('npm-plugin')
  const options = (fetch: typeof globalThis.fetch) => ({ fetch, registry: FAKE_REGISTRY, limits: INSTALL_LIMITS })

  it('downloads the verified tarball of the resolved version', async () => {
    const registry = createFakeRegistry({ 'npm-plugin': { versions: { '1.0.0': { files, deprecated: 'Use v2', hasInstallScript: true } } } })
    const result = await downloadNpmPackage('npm-plugin', options(registry.fetch))
    expect(result.resolution).toMatchObject({ name: 'npm-plugin', version: '1.0.0' })
    expect(result.resolution.warnings).toEqual(['Deprecated on npm: Use v2', 'The package declares install scripts; they are never run.'])
    expect(result.tarball).toEqual(npmTarball(files))
    expect(registry.requests).toEqual([`${FAKE_REGISTRY}/npm-plugin`, `${FAKE_REGISTRY}/npm-plugin/-/npm-plugin-1.0.0.tgz`])
  })

  it('reports unknown packages as not_found and refuses an integrity mismatch', async () => {
    const registry = createFakeRegistry({ 'npm-plugin': { versions: { '1.0.0': { files, integrity: integrityOf(new Uint8Array([1, 2, 3])) } } } })
    expect(await rejection(downloadNpmPackage('missing-plugin', options(registry.fetch)))).toMatchObject({ code: 'not_found', status: 404 })
    const mismatch = await rejection(downloadNpmPackage('npm-plugin@1.0.0', options(registry.fetch)))
    expect(mismatch.code).toBe('validation_error')
    expect(mismatch.message).toContain('does not match its published sha512 integrity')
  })

  it('maps network failures, redirects and oversized bodies', async () => {
    const offline: typeof globalThis.fetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    }
    expect(await rejection(downloadNpmPackage('pkg', options(offline)))).toMatchObject({ code: 'provider_unreachable', message: 'Cannot reach the npm registry: ENOTFOUND.' })
    const redirect: typeof globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
    expect(await rejection(downloadNpmPackage('pkg', options(redirect)))).toMatchObject({ code: 'provider_error', status: 302 })
    const huge: typeof globalThis.fetch = async () => new Response(new Uint8Array(64), { status: 200, headers: { 'content-length': '64' } })
    const tooBig = await rejection(downloadNpmPackage('pkg', { fetch: huge, registry: FAKE_REGISTRY, limits: { ...INSTALL_LIMITS, metadataBytes: 16 } }))
    expect(tooBig).toMatchObject({ code: 'payload_too_large', details: { limitBytes: 16 } })
    const failing: typeof globalThis.fetch = async () => new Response('oops', { status: 500 })
    expect(await rejection(downloadNpmPackage('pkg', options(failing)))).toMatchObject({ code: 'provider_error', status: 500 })
  })
})
