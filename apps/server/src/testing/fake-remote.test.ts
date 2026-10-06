// Smoke tests of the fake remote (C45-T2): every route and archive variant through both front ends (the loopback HTTP
// server and `createFakeSafeFetch`), the request log, `githubZipOf` read back by the installer's zip reader.
import type { FakeRemote } from './fake-remote.ts'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { EntryCollector } from '../plugins/install/archive.ts'
import { INSTALL_LIMITS } from '../plugins/install/errors.ts'
import { githubZipOf as reexportedGithubZipOf } from '../plugins/install/testing.ts'
import { readZip } from '../plugins/install/zip.ts'
import {
  createFakeRemoteRoutes,
  createFakeSafeFetch,
  FAKE_ARCHIVE_VARIANTS,
  fakeTgzOf,
  githubZipOf,
  startFakeRemote,
} from './fake-remote.ts'

const SHA = 'a'.repeat(40)
const decoder = new TextDecoder()
const remotes: FakeRemote[] = []

afterEach(async () => {
  for (const remote of remotes.splice(0))
    await remote.close()
})

async function started(): Promise<FakeRemote> {
  const remote = await startFakeRemote()
  remotes.push(remote)
  return remote
}

/** GET `<url>/<host>/<path>` from the loopback server. */
async function get(remote: FakeRemote, host: string, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${remote.url}/${host}${path}`, { headers })
}

interface CentralEntry {
  name: string
  mode: number
}

/** The central directory (names and Unix modes) and the archive comment of a zip. */
function zipDirectory(zip: Uint8Array): { entries: CentralEntry[], comment: string } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = zip.length - 22
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054B50)
    eocd--
  const count = view.getUint16(eocd + 10, true)
  const commentLength = view.getUint16(eocd + 20, true)
  let offset = view.getUint32(eocd + 16, true)
  const entries: CentralEntry[] = []
  for (let index = 0; index < count; index++) {
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const fileCommentLength = view.getUint16(offset + 32, true)
    entries.push({ name: decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength)), mode: view.getUint32(offset + 38, true) >>> 16 })
    offset += 46 + nameLength + extraLength + fileCommentLength
  }
  return { entries, comment: decoder.decode(zip.subarray(eocd + 22, eocd + 22 + commentLength)) }
}

const FILES = {
  '.claude-plugin/plugin.json': '{"name":"tools"}\n',
  'commands/hello.md': 'Say hello.\n',
  'scripts/run.sh': { content: '#!/bin/sh\necho run\n', mode: 0o755 },
} as const

describe('githubZipOf', () => {
  it('builds a codeload zip: top folder <repo>-<sha>/, folder entries, Unix modes (exec bit kept), the sha as comment', async () => {
    const zip = githubZipOf('acme/tools', SHA, FILES)
    expect(reexportedGithubZipOf).toBe(githubZipOf)
    const { entries, comment } = zipDirectory(zip)
    expect(comment).toBe(SHA)
    expect(entries.map(entry => [entry.name, entry.mode.toString(8)])).toEqual([
      [`tools-${SHA}/`, '40755'],
      [`tools-${SHA}/.claude-plugin/`, '40755'],
      [`tools-${SHA}/commands/`, '40755'],
      [`tools-${SHA}/scripts/`, '40755'],
      [`tools-${SHA}/.claude-plugin/plugin.json`, '100644'],
      [`tools-${SHA}/commands/hello.md`, '100644'],
      [`tools-${SHA}/scripts/run.sh`, '100755'],
    ])
    const read = await readZip(zip, new EntryCollector(INSTALL_LIMITS))
    expect(read.filter(entry => entry.type === 'file').map(entry => [entry.path, decoder.decode(entry.data!)])).toEqual([
      [`tools-${SHA}/.claude-plugin/plugin.json`, '{"name":"tools"}\n'],
      [`tools-${SHA}/commands/hello.md`, 'Say hello.\n'],
      [`tools-${SHA}/scripts/run.sh`, '#!/bin/sh\necho run\n'],
    ])
    expect(githubZipOf('acme/tools', SHA, FILES)).toEqual(zip)
  })

  it('has the broken variants: traversal and link entries are refused by the zip reader; comment and top folder differ', async () => {
    await expect(readZip(githubZipOf('acme/tools', SHA, FILES, { variant: 'traversal' }), new EntryCollector(INSTALL_LIMITS))).rejects.toBeInstanceOf(HarnessError)
    await expect(readZip(githubZipOf('acme/tools', SHA, FILES, { variant: 'link' }), new EntryCollector(INSTALL_LIMITS))).rejects.toThrow(/symbolic link/)
    expect(zipDirectory(githubZipOf('acme/tools', SHA, FILES, { variant: 'link' })).entries.at(-1)).toEqual({ name: `tools-${SHA}/link`, mode: 0o120777 })
    const wrongComment = zipDirectory(githubZipOf('acme/tools', SHA, FILES, { variant: 'wrong-comment' })).comment
    expect(wrongComment).toMatch(/^[\da-f]{40}$/)
    expect(wrongComment).not.toBe(SHA)
    expect(zipDirectory(githubZipOf('acme/tools', SHA, FILES, { variant: 'wrong-top-folder' })).entries[0]?.name).toBe('tools-wrong/')
    expect(zipDirectory(githubZipOf('tools', SHA, {}, { topFolder: 'x', comment: null }))).toEqual({ entries: [{ name: 'x/', mode: 0o40755 }], comment: '' })
    expect(() => githubZipOf('acme/tools', SHA, { '../x': 'y' })).toThrow(TypeError)
  })
})

describe('fake remote routes (HTTP front end)', () => {
  it('resolves refs to commits through the API (sha media type and JSON), with movable refs and HEAD', async () => {
    const remote = await started()
    const first = remote.routes.commit('acme/tools', FILES)
    expect(first).toMatch(/^[\da-f]{40}$/)
    const shaOf = async (ref: string): Promise<string> => (await get(remote, 'api.github.com', `/repos/acme/tools/commits/${ref}`, { accept: 'application/vnd.github.sha' })).text()
    expect(await shaOf('main')).toBe(first)
    expect(await shaOf('HEAD')).toBe(first)
    const second = remote.routes.commit('acme/tools', { ...FILES, 'commands/bye.md': 'Bye.\n' }, { refs: ['main', 'v2'] })
    expect(await shaOf('main')).toBe(second)
    expect(await shaOf('v2')).toBe(second)
    expect(await shaOf('refs/tags/v2')).toBe(second)
    expect(await shaOf(first)).toBe(first)
    expect(await shaOf(first.slice(0, 7))).toBe(first)
    remote.routes.moveRef('acme/tools', 'main', first)
    expect(await shaOf('main')).toBe(first)
    expect(remote.routes.resolve('acme/tools', 'v2')).toBe(second)
    const json = await get(remote, 'api.github.com', '/repos/acme/tools/commits/main')
    expect(json.headers.get('content-type')).toContain('application/json')
    expect(await json.json()).toMatchObject({ sha: first })
    expect((await get(remote, 'api.github.com', '/repos/acme/missing/commits/main')).status).toBe(404)
    const unknownRef = await get(remote, 'api.github.com', '/repos/acme/tools/commits/nope')
    expect(unknownRef.status).toBe(422)
    expect(await unknownRef.json()).toMatchObject({ message: 'No commit found for SHA: nope' })
    expect(remote.requests[0]).toEqual({ method: 'GET', host: 'api.github.com', path: '/repos/acme/tools/commits/main', status: 200 })
  })

  it('switches the API rate limit (403 with x-ratelimit-remaining: 0) while raw and codeload keep working', async () => {
    const remote = await started()
    const sha = remote.routes.commit('acme/tools', FILES)
    remote.routes.setRateLimited(true, { resetAt: 1_900_000_000 })
    const limited = await get(remote, 'api.github.com', '/repos/acme/tools/commits/main')
    expect(limited.status).toBe(403)
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(limited.headers.get('x-ratelimit-reset')).toBe('1900000000')
    expect((await get(remote, 'codeload.github.com', '/acme/tools/zip/refs/heads/main')).status).toBe(200)
    expect((await get(remote, 'raw.githubusercontent.com', `/acme/tools/${sha}/commands/hello.md`)).status).toBe(200)
    remote.routes.setRateLimited(false)
    expect((await get(remote, 'api.github.com', '/repos/acme/tools/commits/main')).status).toBe(200)
  })

  it('serves raw files at a commit or ref, 404 otherwise', async () => {
    const remote = await started()
    const sha = remote.routes.commit('acme/tools', FILES)
    expect(await (await get(remote, 'raw.githubusercontent.com', `/acme/tools/${sha}/.claude-plugin/plugin.json`)).text()).toBe('{"name":"tools"}\n')
    expect(await (await get(remote, 'raw.githubusercontent.com', '/acme/tools/main/commands/hello.md')).text()).toBe('Say hello.\n')
    expect(await (await get(remote, 'raw.githubusercontent.com', '/acme/tools/refs/heads/main/commands/hello.md')).text()).toBe('Say hello.\n')
    const missing = await get(remote, 'raw.githubusercontent.com', `/acme/tools/${sha}/nope.md`)
    expect([missing.status, await missing.text()]).toEqual([404, '404: Not Found'])
  })

  it('serves codeload zips of a sha and of refs/heads/<ref> (the ref names the top folder, the comment is the sha), never redirecting', async () => {
    const remote = await started()
    const sha = remote.routes.commit('acme/tools', FILES)
    const bySha = await get(remote, 'codeload.github.com', `/acme/tools/zip/${sha}`)
    expect(bySha.status).toBe(200)
    expect(bySha.headers.get('content-type')).toBe('application/zip')
    const zip = new Uint8Array(await bySha.arrayBuffer())
    expect(zip).toEqual(githubZipOf('acme/tools', sha, FILES))
    const byRef = zipDirectory(new Uint8Array(await (await get(remote, 'codeload.github.com', '/acme/tools/zip/refs/heads/main')).arrayBuffer()))
    expect(byRef.comment).toBe(sha)
    expect(byRef.entries[0]?.name).toBe('tools-main/')
    expect((await get(remote, 'codeload.github.com', `/acme/tools/zip/${'b'.repeat(40)}`)).status).toBe(404)
    expect((await get(remote, 'codeload.github.com', `/acme/tools/tar.gz/${sha}`)).status).toBe(404)
  })

  it.each(FAKE_ARCHIVE_VARIANTS.filter(variant => variant !== 'oversize').map(variant => [variant] as const))('serves the %s variant of a commit', async (variant) => {
    const remote = await started()
    const sha = remote.routes.commit('acme/tools', FILES, { variant })
    const zip = new Uint8Array(await (await get(remote, 'codeload.github.com', `/acme/tools/zip/${sha}`)).arrayBuffer())
    expect(zip).toEqual(githubZipOf('acme/tools', sha, FILES, { variant }))
  })

  it('streams the oversize variant: content-length and body of LIMITS.repoArchiveBytes + 1 zero bytes', async () => {
    const remote = await started()
    const sha = remote.routes.commit('acme/tools', FILES, { variant: 'oversize' })
    const response = await get(remote, 'codeload.github.com', `/acme/tools/zip/${sha}`)
    expect(response.headers.get('content-length')).toBe(String(LIMITS.repoArchiveBytes + 1))
    const reader = response.body!.getReader()
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done)
        break
      total += value.length
    }
    expect(total).toBe(LIMITS.repoArchiveBytes + 1)
  })

  it('serves registered archive and hosted files (a registered redirect included) and npm packuments and tarballs', async () => {
    const remote = await started()
    const zip = githubZipOf('acme/archive', SHA, FILES)
    remote.routes.serve('https://downloads.example.com/tools.zip', zip)
    remote.routes.serve('https://downloads.example.com/old.zip', { status: 302, headers: { Location: 'https://downloads.example.com/tools.zip' } })
    remote.routes.serve('https://example.com/acme/marketplace.json?raw=1', '{"name":"acme"}')
    expect(new Uint8Array(await (await get(remote, 'downloads.example.com', '/tools.zip')).arrayBuffer())).toEqual(zip)
    const redirect = await fetch(`${remote.url}/downloads.example.com/old.zip`, { redirect: 'manual' })
    expect([redirect.status, redirect.headers.get('location')]).toEqual([302, 'https://downloads.example.com/tools.zip'])
    expect(await (await get(remote, 'example.com', '/acme/marketplace.json?raw=1')).text()).toBe('{"name":"acme"}')
    expect((await get(remote, 'downloads.example.com', '/other.zip')).status).toBe(404)

    remote.routes.npmPackage('@acme/tools', { '1.0.0': { files: { 'package.json': '{"name":"@acme/tools"}' } }, '1.1.0': { files: { 'package.json': '{"name":"@acme/tools","version":"1.1.0"}' } } })
    const packument = await (await get(remote, 'registry.npmjs.org', '/@acme%2Ftools')).json() as { 'dist-tags': Record<string, string>, 'versions': Record<string, { dist: { tarball: string, integrity: string } }> }
    expect(packument['dist-tags']).toEqual({ latest: '1.1.0' })
    const dist = packument.versions['1.1.0']!.dist
    expect(dist.tarball).toBe(`${remote.url}/registry.npmjs.org/@acme/tools/-/tools-1.1.0.tgz`)
    const tarball = new Uint8Array(await (await fetch(dist.tarball)).arrayBuffer())
    expect(dist.integrity).toBe(`sha512-${createHash('sha512').update(tarball).digest('base64')}`)
    expect(decoder.decode(gunzipSync(tarball)).slice(0, 20)).toBe('package/package.json')
    expect((await get(remote, 'registry.npmjs.org', '/missing')).status).toBe(404)
  })

  it('logs every request; unknown hosts answer 502 and other methods 405', async () => {
    const remote = await started()
    expect((await get(remote, 'evil.example', '/x')).status).toBe(502)
    expect((await fetch(`${remote.url}/api.github.com/repos/a/b/commits/main`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${remote.url}/api.github.com/repos/a/b/commits/main`, { method: 'HEAD' })).status).toBe(404)
    expect(remote.requests).toEqual([
      { method: 'GET', host: 'evil.example', path: '/x', status: 502 },
      { method: 'POST', host: 'api.github.com', path: '/repos/a/b/commits/main', status: 405 },
      { method: 'HEAD', host: 'api.github.com', path: '/repos/a/b/commits/main', status: 404 },
    ])
  })

  it('builds npm tarballs with fakeTgzOf (ustar, modes kept)', () => {
    const tar = gunzipSync(fakeTgzOf({ 'package/bin/run': { content: 'x', mode: 0o755 } }))
    expect(decoder.decode(tar.subarray(0, 15))).toBe('package/bin/run')
    expect(decoder.decode(tar.subarray(100, 107))).toBe('0000755')
  })
})

describe('createFakeSafeFetch', () => {
  it('maps https URLs to the model, records the calls and logs the requests', async () => {
    const routes = createFakeRemoteRoutes()
    const sha = routes.commit('acme/tools', FILES)
    const { safeFetch, calls } = createFakeSafeFetch(routes)
    const api = await safeFetch('https://api.github.com/repos/acme/tools/commits/main', { maxBytes: 1024, protocols: ['https:'], headers: { Accept: 'application/vnd.github.sha' } })
    expect([api.status, decoder.decode(api.body), api.url]).toEqual([200, sha, 'https://api.github.com/repos/acme/tools/commits/main'])
    const zip = await safeFetch(`https://codeload.github.com/acme/tools/zip/${sha}`, { maxBytes: LIMITS.repoArchiveBytes, maxRedirects: 0 })
    expect(zip.body).toEqual(githubZipOf('acme/tools', sha, FILES))
    expect(zip.headers.get('content-type')).toBe('application/zip')
    expect(calls.map(call => [call.url, call.status])).toEqual([
      ['https://api.github.com/repos/acme/tools/commits/main', 200],
      [`https://codeload.github.com/acme/tools/zip/${sha}`, 200],
    ])
    expect(routes.requests.map(request => request.host)).toEqual(['api.github.com', 'codeload.github.com'])
  })

  it('refuses unmapped hosts, other protocols and credentials, and enforces maxBytes (the oversize variant allocates nothing)', async () => {
    const routes = createFakeRemoteRoutes()
    const sha = routes.commit('acme/tools', FILES, { variant: 'oversize' })
    const { safeFetch, calls } = createFakeSafeFetch(routes)
    await expect(safeFetch('https://evil.example/x', { maxBytes: 10 })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(safeFetch('https://127.0.0.1/x', { maxBytes: 10 })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(safeFetch('http://api.github.com/x', { maxBytes: 10, protocols: ['https:'] })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(safeFetch('https://user:pw@api.github.com/x', { maxBytes: 10 })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(safeFetch(`https://codeload.github.com/acme/tools/zip/${sha}`, { maxBytes: LIMITS.repoArchiveBytes })).rejects.toMatchObject({ code: 'payload_too_large', details: { limitBytes: LIMITS.repoArchiveBytes } })
    expect(calls.map(call => call.status)).toEqual([null, null, null, null, null])
    expect(routes.requests.map(request => request.status)).toEqual([200])
  })

  it('follows redirects up to maxRedirects (codeload callers pass 0: a redirect fails), honors HEAD and the signal', async () => {
    const routes = createFakeRemoteRoutes()
    routes.serve('https://downloads.example.com/a.zip', { status: 302, headers: { location: 'https://cdn.example.com/a.zip' } })
    routes.serve('https://cdn.example.com/a.zip', new Uint8Array([1, 2, 3]))
    const { safeFetch } = createFakeSafeFetch(routes)
    const followed = await safeFetch('https://downloads.example.com/a.zip', { maxBytes: 10 })
    expect([followed.url, [...followed.body]]).toEqual(['https://cdn.example.com/a.zip', [1, 2, 3]])
    await expect(safeFetch('https://downloads.example.com/a.zip', { maxBytes: 10, maxRedirects: 0 })).rejects.toThrow(/Too many redirects/)
    expect((await safeFetch('https://cdn.example.com/a.zip', { maxBytes: 1, method: 'HEAD' })).body).toEqual(new Uint8Array(0))
    const controller = new AbortController()
    controller.abort()
    await expect(safeFetch('https://cdn.example.com/a.zip', { maxBytes: 10, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
