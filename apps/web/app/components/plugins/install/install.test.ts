import { HarnessError, LIMITS, pluginInstallBodySchema, pluginInstallFormSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { claudePluginInfo } from '~/utils/testing/fixtures'
import {
  buildRequest,
  claudeComponentsSummary,
  claudeNamespaceLines,
  claudePreview,
  contributionSummary,
  emptyDraft,
  executableSource,
  filesSummary,
  inspectionHosts,
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
  splitGithubRepoField,
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
      ignored: ['.lsp.json (LSP servers are not supported)'],
      commit: '0123456789ab',
    })
    expect(claudePreview({ format: 'harness', claude: null } as never)).toBeNull()
    expect(runCommands({ manifestVersion: 1, id: 'review-kit', name: 'Review kit', version: '1.2.0', engines: { harness: '^1.0.0' } }, claudePluginInfo())).toEqual([
      { source: 'PostToolUse hook', command: 'sh "$CLAUDE_PLUGIN_ROOT/hooks/format.sh"' },
      { source: 'MCP server review-kit', command: 'node server.mjs' },
    ])
  })
})

describe('phase 12: the Claude Code preview (W12.9)', () => {
  const manifest = { manifestVersion: 1 as const, id: 'review-kit', name: 'Review kit', version: '1.2.0', engines: { harness: '^1.6.0' } }
  const contributions = { providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [], commandHooks: 0, outputStyles: [] }

  it('names where each executable comes from like the trust consent', () => {
    expect(executableSource({ kind: 'hook', label: 'PostToolUse Write|Edit', command: 'x' })).toBe('PostToolUse hook')
    expect(executableSource({ kind: 'hook', label: 'Stop', command: 'x' })).toBe('Stop hook')
    expect(executableSource({ kind: 'hook', label: '', command: 'x' })).toBe('Hook')
    expect(executableSource({ kind: 'mcp', label: 'github', command: 'x' })).toBe('MCP server github')
    expect(executableSource({ kind: 'span', label: 'deploy', command: 'x' }, 'review-kit')).toBe('/review-kit:deploy')
    expect(executableSource({ kind: 'span', label: '/review-kit:db:migrate', command: 'x' }, 'review-kit')).toBe('/review-kit:db:migrate')
    expect(executableSource({ kind: 'span', label: 'deploy', command: 'x' })).toBe('/deploy')
    expect(runCommands(manifest, claudePluginInfo({ executables: [{ kind: 'span', label: 'status', command: 'git status --short' }] })))
      .toEqual([{ source: '/review-kit:status', command: 'git status --short' }])
    // A harness manifest keeps its own reading (no `claude`).
    expect(runCommands(manifest, null)).toEqual([])
  })

  it('reads the commit of a GitHub source and keeps an ignored part without a reason as is', () => {
    const base = { format: 'claude' as const, claude: claudePluginInfo({ unsupported: [{ component: 'bin/', reason: '' }, { component: 'themes/', reason: 'Never run.' }] }) }
    expect(claudePreview({ ...base, sourceRef: 'acme/tools@0123456789abcdef0123456789abcdef01234567' } as never)?.commit).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(claudePreview({ ...base, sourceRef: 'review-kit.zip' } as never)?.commit).toBeNull()
    expect(claudePreview({ ...base, sourceRef: undefined } as never)?.ignored).toEqual(['bin/', 'themes/ (Never run)'])
    expect(claudePreview({ ...base, claude: claudePluginInfo({ userConfig: [{ key: 'BRANCH', title: '', sensitive: false, required: false }] }) } as never)?.asksFor).toEqual(['BRANCH'])
  })

  it('builds the namespace lines from the qualified names', () => {
    const claude = claudePluginInfo()
    expect(claudeNamespaceLines({ format: 'claude', claude, contributions: { ...contributions, commands: ['review-kit:review'], agents: ['review-kit:code-reviewer'] } }))
      .toEqual(['Commands run as /review-kit:review.', 'Agents start as review-kit:code-reviewer.'])
    // Bare names are qualified; counts without names show the pattern.
    expect(claudeNamespaceLines({ format: 'claude', claude, contributions: { ...contributions, commands: ['review'] } }))
      .toEqual(['Commands run as /review-kit:review.', 'Agents start as review-kit:<agent>.'])
    expect(claudeNamespaceLines({ format: 'claude', claude: claudePluginInfo({ components: { commands: 0, agents: 0, skills: 1, outputStyles: 0, hooks: 0, mcpServers: 0 } }), contributions }))
      .toEqual([])
    expect(claudeNamespaceLines({ format: 'harness', claude: null, contributions: { ...contributions, commands: ['deploy'] } })).toEqual([])
  })

  it('summarizes the components and merges the hosts', () => {
    expect(claudeComponentsSummary({ commands: 3, agents: 1, skills: 1, outputStyles: 2, hooks: 2, mcpServers: 1 }))
      .toBe('3 commands · 1 agent · 1 skill · 2 output styles · 2 hooks · 1 MCP server')
    expect(claudeComponentsSummary({ commands: 0, agents: 0, skills: 0, outputStyles: 0, hooks: 0, mcpServers: 0 })).toBe('')
    expect(inspectionHosts({ networkHosts: ['mcp.example.com'], claude: claudePluginInfo({ hosts: ['api.example.com', 'mcp.example.com'] }) }))
      .toEqual(['api.example.com', 'mcp.example.com'])
    expect(inspectionHosts({ networkHosts: ['b.example', 'a.example'], claude: null })).toEqual(['a.example', 'b.example'])
  })
})

describe('phase 12: the GitHub Repository field (W12.9)', () => {
  it.each([
    [{ githubRepo: 'anthropics/review-kit#v1.2.0', githubRef: '' }, { githubRepo: 'anthropics/review-kit', githubRef: 'v1.2.0' }],
    [{ githubRepo: 'anthropics/review-kit@main', githubRef: '' }, { githubRepo: 'anthropics/review-kit', githubRef: 'main' }],
    [{ githubRepo: 'https://github.com/anthropics/review-kit/tree/dev', githubRef: '' }, { githubRepo: 'anthropics/review-kit', githubRef: 'dev' }],
    [{ githubRepo: 'https://github.com/anthropics/review-kit', githubRef: 'v2' }, { githubRepo: 'anthropics/review-kit', githubRef: 'v2' }],
    [{ githubRepo: ' anthropics/review-kit#main', githubRef: 'main' }, { githubRepo: 'anthropics/review-kit', githubRef: 'main' }],
    // Nothing changes: already split, another ref typed (Inspect reports it), or not a GitHub repository.
    [{ githubRepo: 'anthropics/review-kit', githubRef: 'main' }, null],
    [{ githubRepo: 'anthropics/review-kit#v1', githubRef: 'v2' }, null],
    [{ githubRepo: 'https://gitlab.com/acme/tools', githubRef: '' }, null],
    [{ githubRepo: '', githubRef: '' }, null],
  ])('splits %j', (draft, expected) => {
    expect(splitGithubRepoField(draft)).toEqual(expected)
  })
})
