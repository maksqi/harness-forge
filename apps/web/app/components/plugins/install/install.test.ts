import { HarnessError, LIMITS, pluginInstallBodySchema, pluginInstallFormSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { claudePluginInfo } from '~/utils/testing/fixtures'
import {
  buildRequest,
  claudePreview,
  contributionSummary,
  emptyDraft,
  filesSummary,
  inspectionSourceLabel,
  INSTALL_TABS,
  installBody,
  isStaleReview,
  manifestIcon,
  npmSpec,
  parseGithubSpec,
  permissionLabel,
  pluginSourceLabel,
  requestSourceLabel,
  runCommands,
  serverFieldErrors,
  TAB_LABELS,
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

describe('server errors', () => {
  it('maps validation issues to the fields of the tab', () => {
    const error = new HarnessError({ code: 'validation_error', message: 'Bad', details: { issues: [{ path: ['integrity'], message: 'Mismatch', code: 'custom' }] } })
    expect(serverFieldErrors('url', error)).toEqual({ integrity: 'Mismatch' })
    expect(serverFieldErrors('npm', error)).toBeNull()
    expect(serverFieldErrors('url', new HarnessError({ code: 'conflict', message: 'x' }))).toBeNull()
    const spec = new HarnessError({ code: 'validation_error', message: 'Bad', details: { issues: [{ path: ['spec'], message: 'Unknown', code: 'custom' }] } })
    expect(serverFieldErrors('npm', spec)).toEqual({ npmName: 'Unknown' })
  })

  it('recognizes a stale review (the package changed since it was inspected)', () => {
    expect(isStaleReview(new HarnessError({ code: 'conflict', message: 'Changed.', details: { reason: 'stale' } }))).toBe(true)
    expect(isStaleReview(new HarnessError({ code: 'conflict', message: 'Exists.', details: { reason: 'exists' } }))).toBe(false)
    expect(isStaleReview(new HarnessError({ code: 'forbidden', message: 'x', action: 'login' }))).toBe(false)
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
    expect(contributionSummary({ providers: ['a', 'b'], models: 3, tools: [], mcpServers: ['m'], commands: ['c', 'd'], hooks: [], agents: [], skills: [], commandHooks: 0, outputStyles: [] }))
      .toBe('2 providers · 3 models · 1 MCP server · 2 commands')
    expect(contributionSummary({ providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [], commandHooks: 0, outputStyles: [] })).toBe('')
    // Phase 11: output styles, and the command hooks counted with the code hooks.
    expect(contributionSummary({ providers: [], models: 0, tools: [], mcpServers: [], commands: ['c'], hooks: ['prompt.submit'], agents: [], skills: [], commandHooks: 2, outputStyles: ['terse'] }))
      .toBe('1 command · 1 output style · 3 hooks')
    // Every kind of the plugin card's summary, in its order: agents and skills after commands, hooks last.
    expect(contributionSummary({ providers: [], models: 0, tools: ['t'], mcpServers: [], commands: ['c'], hooks: ['chat.before'], agents: ['a', 'b'], skills: ['s'], commandHooks: 1, outputStyles: ['terse', 'plain'] }))
      .toBe('1 tool · 1 command · 2 agents · 1 skill · 2 output styles · 2 hooks')
    expect(contributionSummary({ providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: ['a'], skills: [], commandHooks: 0, outputStyles: [] })).toBe('1 agent')
    expect(contributionSummary({ providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: ['s', 't'], commandHooks: 0, outputStyles: [] })).toBe('2 skills')
    expect(filesSummary({ count: 1, bytes: 2048 })).toBe('1 file · 2 KB')
    expect(permissionLabel('hooks')).toBe('Reads and changes conversations')
    expect(permissionLabel('unknown')).toBe('unknown')
    expect(manifestIcon('lobe:together')).toEqual({ color: '/api/icons/lobe/together-color', mono: '/api/icons/lobe/together' })
    expect(manifestIcon('lobe:together-color')).toEqual({ color: '/api/icons/lobe/together-color', mono: '/api/icons/lobe/together' })
    expect(manifestIcon('icon.svg')).toBeNull()
  })

  it('builds multipart bodies with trust and the reviewed hash', () => {
    const zip = file('p.zip', 3)
    const hash = 'a'.repeat(64)
    const form = zipForm(zip, { trust: true, sha256: hash })
    expect((form.get('file') as File).name).toBe('p.zip')
    expect(form.get('trust')).toBe('true')
    expect(form.get('sha256')).toBe(hash)
    expect(zipForm(zip).get('trust')).toBeNull()
    expect(zipForm(zip).get('sha256')).toBeNull()
  })

  it('builds JSON install bodies the shared schema accepts', () => {
    const hash = 'b'.repeat(64)
    const body = installBody({ source: 'npm', spec: 'pkg@^1.0.0' }, { trust: true, sha256: hash })
    expect(body).toEqual({ source: 'npm', spec: 'pkg@^1.0.0', sha256: hash, trust: true })
    expect(pluginInstallBodySchema.safeParse(body).success).toBe(true)
    expect(installBody({ source: 'path', path: '/srv/p', mode: 'copy' })).toEqual({ source: 'path', path: '/srv/p', mode: 'copy' })
    const form = zipForm(file('p.zip', 3), { sha256: hash })
    expect(pluginInstallFormSchema.parse({ sha256: form.get('sha256') })).toEqual({ sha256: hash })
  })

  it('prefers the source the server resolved for "I trust {source}"', () => {
    const npm = { kind: 'json' as const, source: { source: 'npm' as const, spec: 'pkg@latest' } }
    expect(inspectionSourceLabel({ sourceRef: 'pkg@1.4.2' }, npm)).toBe('pkg@1.4.2')
    expect(inspectionSourceLabel({ sourceRef: undefined }, npm)).toBe('pkg@latest')
    expect(inspectionSourceLabel({ sourceRef: '  ' }, { kind: 'zip', file: file('dice.zip', 1) })).toBe('dice.zip')
  })
})

describe('phase 12 additions (C46)', () => {
  it('has a GitHub tab between URL and Local folder', () => {
    expect(INSTALL_TABS).toEqual(['zip', 'npm', 'url', 'github', 'folder'])
    expect(TAB_LABELS.github).toBe('GitHub')
    expect(emptyDraft()).toMatchObject({ githubRepo: '', githubRef: '', githubPath: '' })
  })

  it.each([
    ['anthropics/review-kit', { repo: 'anthropics/review-kit' }],
    ['anthropics/review-kit#v1.2.0', { repo: 'anthropics/review-kit', ref: 'v1.2.0' }],
    ['anthropics/review-kit@main', { repo: 'anthropics/review-kit', ref: 'main' }],
    ['https://github.com/anthropics/review-kit', { repo: 'anthropics/review-kit' }],
    ['https://gitlab.com/acme/tools', null],
    ['/srv/plugins/x', null],
    ['', null],
  ])('splits the GitHub spec %j', (text, expected) => {
    expect(parseGithubSpec(text)).toEqual(expected)
  })

  it('builds a GitHub request from the tab', () => {
    const draft = { ...emptyDraft(), githubRepo: 'anthropics/review-kit#v1', githubPath: '/plugins/review-kit/' }
    expect(buildRequest('github', draft).request).toEqual({ kind: 'json', source: { source: 'github', repo: 'anthropics/review-kit', ref: 'v1', path: 'plugins/review-kit' } })
    expect(buildRequest('github', { ...draft, githubRef: 'v2' }).errors.githubRef).toContain('clear one of them')
    expect(buildRequest('github', emptyDraft()).errors.githubRepo).toBe('Enter a repository as owner/repo.')
    expect(buildRequest('github', { ...emptyDraft(), githubRepo: 'not a repo' }).errors.githubRepo).toContain('owner/repo')
  })

  it('reads the Claude Code preview and the executables of a Claude Code plugin', () => {
    const inspection = {
      format: 'claude' as const,
      sourceRef: 'anthropics/review-kit@0123456789ab/plugins/review-kit',
      claude: claudePluginInfo(),
    }
    expect(claudePreview(inspection as never)).toEqual({
      namespace: 'review-kit',
      asksFor: ['API token (secret) (required)'],
      ignored: ['.lsp.json: LSP servers are not supported.'],
      commit: '0123456789ab',
    })
    expect(claudePreview({ format: 'harness', claude: null } as never)).toBeNull()
    expect(runCommands({ manifestVersion: 1, id: 'review-kit', name: 'Review kit', version: '1.2.0', engines: { harness: '^1.0.0' } }, claudePluginInfo())).toEqual([
      { source: 'PostToolUse Write|Edit', command: 'sh "$CLAUDE_PLUGIN_ROOT/hooks/format.sh"' },
      { source: 'review-kit', command: 'node server.mjs' },
    ])
  })
})
