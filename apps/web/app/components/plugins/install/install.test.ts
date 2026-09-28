import { HarnessError, LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import {
  buildRequest,
  contributionSummary,
  emptyDraft,
  filesSummary,
  isFreshAuthError,
  manifestIcon,
  npmSpec,
  passwordErrorText,
  permissionLabel,
  pluginSourceLabel,
  requestSourceLabel,
  serverFieldErrors,
  zipForm,
} from './install'

const SHA256 = `sha256-${'A'.repeat(43)}=`

function file(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: 'application/zip' })
}

describe('buildRequest', () => {
  it('requires a non-empty zip of at most 20 MB', () => {
    expect(buildRequest('zip', emptyDraft()).errors).toEqual({ file: 'Choose a .zip file.' })
    expect(buildRequest('zip', { ...emptyDraft(), file: file('a.zip', 0) }).errors).toEqual({ file: 'The file is empty.' })
    expect(buildRequest('zip', { ...emptyDraft(), file: file('a.zip', LIMITS.pluginZipBytes + 1) }).errors.file).toContain('larger than 20 MB')
    const zip = file('plugin.zip', 10)
    expect(buildRequest('zip', { ...emptyDraft(), file: zip })).toEqual({ request: { kind: 'zip', file: zip }, errors: {} })
  })

  it('builds npm specs from the package and the optional version', () => {
    expect(npmSpec({ npmName: ' @scope/pkg ', npmVersion: ' ^1.2 ' })).toBe('@scope/pkg@^1.2')
    expect(buildRequest('npm', { ...emptyDraft(), npmName: 'harness-plugin-x' }).request)
      .toEqual({ kind: 'json', source: { source: 'npm', spec: 'harness-plugin-x' } })
    expect(buildRequest('npm', { ...emptyDraft(), npmName: '@scope/pkg', npmVersion: '2.0.0' }).request)
      .toEqual({ kind: 'json', source: { source: 'npm', spec: '@scope/pkg@2.0.0' } })
    expect(buildRequest('npm', emptyDraft()).errors).toEqual({ npmName: 'Enter a package name.' })
    expect(buildRequest('npm', { ...emptyDraft(), npmName: 'pkg@1.0.0', npmVersion: '2.0.0' }).errors.npmVersion).toContain('already contains a version')
    expect(buildRequest('npm', { ...emptyDraft(), npmName: 'Not Valid!' }).errors.npmName).toContain('npm package spec')
  })

  it('validates URL sources and their integrity', () => {
    const ok = buildRequest('url', { ...emptyDraft(), url: 'https://example.com/p.zip', integrity: SHA256 })
    expect(ok.request).toEqual({ kind: 'json', source: { source: 'url', url: 'https://example.com/p.zip', integrity: SHA256 } })
    const bad = buildRequest('url', { ...emptyDraft(), url: 'http://example.com/p.zip', integrity: 'md5-abc' })
    expect(bad.request).toBeNull()
    expect(Object.keys(bad.errors).sort()).toEqual(['integrity', 'url'])
  })

  it('validates folder sources', () => {
    expect(buildRequest('folder', { ...emptyDraft(), folderPath: '/srv/plugins/my-plugin', folderMode: 'copy' }).request)
      .toEqual({ kind: 'json', source: { source: 'path', path: '/srv/plugins/my-plugin', mode: 'copy' } })
    expect(buildRequest('folder', { ...emptyDraft(), folderPath: 'relative/path' }).errors.folderPath).toContain('absolute')
  })
})

describe('server errors and fresh auth', () => {
  it('maps validation issues to the fields of the tab', () => {
    const error = new HarnessError({ code: 'validation_error', message: 'Bad', details: { issues: [{ path: ['integrity'], message: 'Mismatch', code: 'custom' }] } })
    expect(serverFieldErrors('url', error)).toEqual({ integrity: 'Mismatch' })
    expect(serverFieldErrors('npm', error)).toBeNull()
    expect(serverFieldErrors('url', new HarnessError({ code: 'conflict', message: 'x' }))).toBeNull()
    const spec = new HarnessError({ code: 'validation_error', message: 'Bad', details: { issues: [{ path: ['spec'], message: 'Unknown', code: 'custom' }] } })
    expect(serverFieldErrors('npm', spec)).toEqual({ npmName: 'Unknown' })
  })

  it('recognizes fresh-auth refusals and login failures', () => {
    expect(isFreshAuthError(new HarnessError({ code: 'forbidden', message: 'x', action: 'login' }))).toBe(true)
    expect(isFreshAuthError(new HarnessError({ code: 'forbidden', message: 'x' }))).toBe(false)
    expect(passwordErrorText(new HarnessError({ code: 'unauthorized', message: 'Invalid password' }))).toBe('Wrong password')
    expect(passwordErrorText(new HarnessError({ code: 'rate_limited', message: 'x', retryAfterMs: 2500 }))).toBe('Too many attempts. Try again in 3 s.')
  })
})

describe('labels', () => {
  it('names the source to trust', () => {
    expect(requestSourceLabel({ kind: 'zip', file: file('dice.zip', 1) })).toBe('dice.zip')
    expect(requestSourceLabel({ kind: 'json', source: { source: 'npm', spec: '@scope/pkg@1.0.0' } })).toBe('@scope/pkg@1.0.0')
    expect(requestSourceLabel({ kind: 'json', source: { source: 'url', url: 'https://cdn.example.com:8443/p.zip', integrity: SHA256 } })).toBe('cdn.example.com:8443')
    expect(requestSourceLabel({ kind: 'json', source: { source: 'path', path: '/srv/p', mode: 'link' } })).toBe('/srv/p')
    expect(pluginSourceLabel({ source: 'url', sourceRef: 'https://cdn.example.com/p.zip', name: 'P' })).toBe('cdn.example.com')
    expect(pluginSourceLabel({ source: 'npm', sourceRef: 'pkg@1.0.0', name: 'P' })).toBe('pkg@1.0.0')
    expect(pluginSourceLabel({ source: 'created', sourceRef: null, name: 'My tool' })).toBe('My tool')
  })

  it('summarizes contributions, files, permissions and icons', () => {
    expect(contributionSummary({ providers: ['a', 'b'], models: 3, tools: [], mcpServers: ['m'], commands: ['c', 'd'], hooks: [] }))
      .toBe('2 providers · 3 models · 1 MCP server · 2 commands')
    expect(contributionSummary({ providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [] })).toBe('')
    expect(filesSummary({ count: 1, bytes: 2048 })).toBe('1 file · 2 KB')
    expect(permissionLabel('hooks')).toBe('Reads and changes conversations')
    expect(permissionLabel('unknown')).toBe('unknown')
    expect(manifestIcon('lobe:together')).toEqual({ color: '/api/icons/lobe/together-color', mono: '/api/icons/lobe/together' })
    expect(manifestIcon('lobe:together-color')).toEqual({ color: '/api/icons/lobe/together-color', mono: '/api/icons/lobe/together' })
    expect(manifestIcon('icon.svg')).toBeNull()
  })

  it('builds multipart bodies', () => {
    const zip = file('p.zip', 3)
    const form = zipForm(zip, true)
    expect((form.get('file') as File).name).toBe('p.zip')
    expect(form.get('trust')).toBe('true')
    expect(zipForm(zip).get('trust')).toBeNull()
  })
})
