/// <reference types="node" />
/* eslint-disable no-template-curly-in-string -- `${CLAUDE_PLUGIN_ROOT}` / `${user_config.KEY}` references are the subject of these tests */
import type { ClaudeMarketplaceEntry, ClaudePluginDiagnostic, ClaudePluginManifest, ClaudeUserConfigOption, MarketplaceShorthand } from './claude-plugins.ts'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isReservedPluginId, PLUGIN_ID_PATTERN } from '../ids.ts'
import { settingsSchemaSchema } from '../schemas/plugin-settings.ts'
import {
  CLAUDE_ENTRY_SOURCE_KINDS,
  CLAUDE_PLUGIN_DIAGNOSTIC_CODES,
  CLAUDE_PLUGIN_LIMITS,
  claudePluginId,
  isOfficialMarketplaceName,
  mergeEntryOverlay,
  parseClaudePluginManifest,
  parseMarketplaceJson,
  parseMarketplaceShorthand,
  substitutePluginVariables,
  userConfigToSettings,
} from './claude-plugins.ts'

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function codes(diagnostics: readonly ClaudePluginDiagnostic[]): string[] {
  return diagnostics.map(entry => `${entry.level}:${entry.code}${entry.field === undefined ? '' : `@${entry.field}`}`)
}

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function manifestOf(value: unknown): ClaudePluginManifest {
  const result = parseClaudePluginManifest(JSON.stringify(value))
  if (result.manifest === null)
    throw new Error(`manifest expected: ${JSON.stringify(result.diagnostics)}`)
  return result.manifest
}

const SHA = '0123456789abcdef0123456789abcdef01234567'
const SHA256 = 'ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789'

/** A `plugin.json` using every documented field form (code.claude.com plugins/manifest-reference). */
const FULL_PLUGIN = {
  $schema: 'https://anthropic.com/claude-code/plugin.schema.json',
  name: 'review-kit',
  displayName: 'Review Kit',
  version: '2.1.0-beta.1',
  description: 'Code review helpers.',
  author: { name: 'Ada Lovelace', email: 'ada@example.invalid', url: 'https://example.invalid/ada' },
  homepage: 'https://example.invalid/review-kit',
  repository: 'https://github.com/example/review-kit',
  license: 'MIT',
  keywords: ['review', 'quality', 'review', 7],
  metadata: { anything: true },
  icon: 'icon.png',
  documentationUrl: 'https://example.invalid/docs',
  defaultEnabled: false,
  commands: ['./commands/', './extra/deploy.md'],
  agents: './agents/code-reviewer.md',
  skills: ['./skills', '.'],
  outputStyles: './styles',
  hooks: [
    './hooks/hooks.json',
    { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/format.sh' }] }] },
  ],
  mcpServers: [
    './.mcp.json',
    { docs: { type: 'http', url: 'https://docs.example.invalid/mcp' } },
    './bundle.mcpb',
    'https://example.invalid/servers.json',
  ],
  lspServers: './.lsp.json',
  channels: [],
  dependencies: ['helper', 'other@mkt'],
  settings: { agent: 'x' },
  experimental: { themes: './themes' },
  userConfig: {
    API_URL: { type: 'string', title: 'API URL', description: 'Base URL of the review API.', default: 'https://api.example.invalid' },
    API_TOKEN: { type: 'string', title: 'API token', sensitive: true, required: true },
    LEVEL: { type: 'string', title: 'Level', options: ['low', 'high'], default: 'low' },
    TAGS: { type: 'string', title: 'Tags', multiple: true, options: ['a', 'b'], default: ['a'] },
    RETRIES: { type: 'number', title: 'Retries', min: 0, max: 5, default: 2 },
    VERBOSE: { type: 'boolean', title: 'Verbose', default: false },
    WORKDIR: { type: 'directory', title: 'Work folder', default: '/srv/work' },
    CONFIG: { type: 'file', title: 'Config file', required: true },
  },
  futureField: 1,
}

// ---------------------------------------------------------------------------------------------------------------------
// plugin.json

describe('parseClaudePluginManifest', () => {
  it('reads every documented field form', () => {
    const result = parseClaudePluginManifest(JSON.stringify(FULL_PLUGIN))
    const manifest = result.manifest
    expect(manifest).not.toBeNull()
    expect(manifest).toMatchObject({
      name: 'review-kit',
      displayName: 'Review Kit',
      version: '2.1.0-beta.1',
      description: 'Code review helpers.',
      author: { name: 'Ada Lovelace', email: 'ada@example.invalid', url: 'https://example.invalid/ada' },
      homepage: 'https://example.invalid/review-kit',
      repository: 'https://github.com/example/review-kit',
      license: 'MIT',
      keywords: ['review', 'quality'],
      defaultEnabled: false,
      commands: { paths: ['commands', 'extra/deploy.md'], inline: [] },
      agents: ['agents/code-reviewer.md'],
      skills: ['skills', '.'],
      outputStyles: ['styles'],
      hooks: { files: ['hooks/hooks.json'], inline: [FULL_PLUGIN.hooks[1]] },
      mcpServers: { files: ['.mcp.json'], inline: [{ docs: { type: 'http', url: 'https://docs.example.invalid/mcp' } }] },
      unsupported: ['lspServers', 'channels', 'dependencies', 'settings', 'experimental'],
    })
    expect(manifest?.appendToDefault).toBeUndefined()
    expect(manifest?.userConfig.map(option => option.key)).toEqual(['API_URL', 'API_TOKEN', 'LEVEL', 'TAGS', 'RETRIES', 'VERBOSE', 'WORKDIR', 'CONFIG'])
    expect(manifest?.userConfig[1]).toEqual({ key: 'API_TOKEN', type: 'string', title: 'API token', required: true, multiple: false, sensitive: true })
    expect(manifest?.userConfig[3]).toEqual({ key: 'TAGS', type: 'string', title: 'Tags', required: false, default: ['a'], options: ['a', 'b'], multiple: true, sensitive: false })
    expect(manifest?.userConfig[4]).toMatchObject({ type: 'number', min: 0, max: 5, default: 2 })
    const list = codes(result.diagnostics)
    expect(list).toContain('warning:invalid-field@keywords')
    expect(list).toContain('warning:unsupported-component@mcpServers[2]')
    expect(list).toContain('warning:unsupported-component@mcpServers[3]')
    expect(list).toContain('warning:unknown-field@futureField')
    expect(list).toContain('info:unsupported-component@lspServers')
    expect(list).not.toContain('warning:unknown-field@metadata')
    expect(list).not.toContain('warning:unknown-field@icon')
    expect(result.diagnostics.every(entry => entry.level !== 'error')).toBe(true)
  })

  it('reads the object form of commands', () => {
    const manifest = manifestOf({
      name: 'cmds',
      commands: {
        'about': { source: './README.md', description: 'About this plugin' },
        'hello': { content: 'Say hello to $ARGUMENTS', argumentHint: '[name]', model: 'sonnet', allowedTools: ['Read', 'Bash(git:*)'] },
        'both': { source: './x.md', content: 'x' },
        'neither': { description: 'nothing' },
        'bad/name': { content: 'x' },
        'outside': { source: '../x.md' },
      },
    })
    expect(manifest.commands).toEqual({
      paths: [],
      inline: [
        { name: 'about', source: 'README.md', description: 'About this plugin' },
        { name: 'hello', content: 'Say hello to $ARGUMENTS', argumentHint: '[name]', model: 'sonnet', allowedTools: ['Read', 'Bash(git:*)'] },
      ],
    })
  })

  it('validates component paths', () => {
    const result = parseClaudePluginManifest(JSON.stringify({
      name: 'paths',
      agents: ['./ok.md', '../outside.md', './a/../b.md', 'no-dot.md', '/abs.md', './dir/', 'C:/x.md', './back\\slash.md', 7],
      skills: ['./', '.', './skills'],
      outputStyles: './styles/terse.md',
    }))
    expect(result.manifest?.agents).toEqual(['ok.md'])
    expect(result.manifest?.skills).toEqual(['.', 'skills'])
    expect(result.manifest?.outputStyles).toEqual(['styles/terse.md'])
    expect(codes(result.diagnostics)).toEqual([
      'error:path-outside-root@agents[1]',
      'error:path-outside-root@agents[2]',
      'warning:invalid-path@agents[3]',
      'warning:invalid-path@agents[4]',
      'warning:invalid-path@agents[5]',
      'warning:invalid-path@agents[6]',
      'warning:invalid-path@agents[7]',
      'warning:invalid-field@agents[8]',
    ])
  })

  it('caps component lists', () => {
    const agents = Array.from({ length: 130 }, (_, index) => `./agents/a${index}.md`)
    const styles = Array.from({ length: 30 }, (_, index) => `./styles/s${index}.md`)
    const result = parseClaudePluginManifest(JSON.stringify({ name: 'many', agents, outputStyles: styles }))
    expect(result.manifest?.agents).toHaveLength(CLAUDE_PLUGIN_LIMITS.componentsPerKindMax)
    expect(result.manifest?.outputStyles).toHaveLength(CLAUDE_PLUGIN_LIMITS.outputStylesMax)
    expect(codes(result.diagnostics)).toEqual(['warning:too-many@agents', 'warning:too-many@outputStyles'])
  })

  it.each([
    [{ version: '1' }, 'error:missing-name@name'],
    [{ name: '  ' }, 'error:missing-name@name'],
    [{ name: 7 }, 'error:invalid-name@name'],
    [{ name: 'my plugin' }, 'error:invalid-name@name'],
    [{ name: 'a@b' }, 'error:invalid-name@name'],
    [{ name: 'a:b' }, 'error:invalid-name@name'],
    [{ name: 'a/b' }, 'error:invalid-name@name'],
    [{ name: 'a\u0007b' }, 'error:invalid-name@name'],
    [{ name: 'x'.repeat(129) }, 'error:invalid-name@name'],
  ])('refuses the name of %j', (value, code) => {
    const result = parseClaudePluginManifest(JSON.stringify(value))
    expect(result.manifest).toBeNull()
    expect(codes(result.diagnostics)).toContain(code)
  })

  it('warns about non-kebab and reserved names but keeps the manifest', () => {
    const camel = parseClaudePluginManifest(JSON.stringify({ name: 'MyPlugin' }))
    expect(camel.manifest?.name).toBe('MyPlugin')
    expect(codes(camel.diagnostics)).toEqual(['warning:invalid-name@name'])
    for (const name of ['claude-tools', 'anthropic-helper', 'cc-plugin-x', 'official-claude-pack']) {
      const reserved = parseClaudePluginManifest(JSON.stringify({ name }))
      expect(reserved.manifest?.name).toBe(name)
      expect(codes(reserved.diagnostics)).toEqual(['warning:reserved-name@name'])
    }
  })

  it('refuses unusable files', () => {
    expect(codes(parseClaudePluginManifest('{').diagnostics)).toEqual(['error:invalid-json'])
    expect(codes(parseClaudePluginManifest('[]').diagnostics)).toEqual(['error:not-an-object'])
    expect(codes(parseClaudePluginManifest('null').diagnostics)).toEqual(['error:not-an-object'])
    expect(codes(parseClaudePluginManifest(`{"name":"x","description":"${'a'.repeat(300_000)}"}`).diagnostics)).toEqual(['error:too-large'])
    expect(codes(parseClaudePluginManifest('{"name":"x"}', { maxBytes: 5 }).diagnostics)).toEqual(['error:too-large'])
    expect(parseClaudePluginManifest('{"name":"x"}', { maxBytes: 10_000_000 }).manifest?.name).toBe('x')
    expect(parseClaudePluginManifest(undefined as unknown as string).manifest).toBeNull()
  })

  it('accepts a BOM, an author string and minimal manifests', () => {
    const manifest = parseClaudePluginManifest(`\uFEFF${JSON.stringify({ name: 'mini', author: 'Grace' })}`).manifest
    expect(manifest).toEqual({ name: 'mini', author: { name: 'Grace' }, keywords: [], defaultEnabled: true, userConfig: [], unsupported: [] })
  })

  it('drops bad metadata with warnings', () => {
    const result = parseClaudePluginManifest(JSON.stringify({
      name: 'meta',
      homepage: 'ftp://example.invalid',
      author: { email: 'x@example.invalid' },
      defaultEnabled: 'yes',
      displayName: 'x'.repeat(200),
      version: 3,
      repository: { type: 'git', url: 'https://github.com/a/b' },
    }))
    expect(result.manifest).toMatchObject({ name: 'meta', displayName: 'x'.repeat(128), repository: 'https://github.com/a/b', defaultEnabled: true })
    expect(result.manifest?.homepage).toBeUndefined()
    expect(result.manifest?.author).toBeUndefined()
    expect(result.manifest?.version).toBeUndefined()
    expect(codes(result.diagnostics)).toEqual([
      'warning:invalid-field@homepage',
      'warning:invalid-field@author',
      'warning:invalid-field@defaultEnabled',
      'warning:invalid-field@displayName',
      'warning:invalid-field@version',
    ])
  })

  it('reads userConfig defensively', () => {
    const result = parseClaudePluginManifest(JSON.stringify({
      name: 'cfg',
      userConfig: {
        'GOOD': { type: 'string', title: 'Good', extra: 1 },
        'bad key': { type: 'string', title: 'x' },
        'NO_TYPE': { title: 'x' },
        'WRONG_DEFAULT': { type: 'number', title: 'n', default: 'two' },
        'NO_TITLE': { type: 'boolean' },
        'BAD_OPTIONS': { type: 'string', title: 'o', options: [] },
        'NOT_OBJECT': 'string',
      },
    }))
    expect(result.manifest?.userConfig.map(option => option.key)).toEqual(['GOOD', 'WRONG_DEFAULT', 'NO_TITLE', 'BAD_OPTIONS'])
    expect(result.manifest?.userConfig[2]?.title).toBe('NO_TITLE')
    expect(result.manifest?.userConfig[1]?.default).toBeUndefined()
    expect(codes(result.diagnostics).every(code => code.startsWith('warning:invalid-user-config'))).toBe(true)
  })

  it('never quotes values in diagnostics', () => {
    const secret = 'sk-live-SECRET-0123456789'
    const result = parseClaudePluginManifest(JSON.stringify({ name: 'leak', homepage: secret, version: { secret }, userConfig: { K: { type: 'number', title: 'k', default: secret } } }))
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// marketplace.json

/** A `marketplace.json` with one entry of every source kind, a `strict: false` entry and invalid entries. */
const MARKETPLACE = {
  $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
  name: 'acme-tools',
  owner: { name: 'Acme', email: 'tools@example.invalid' },
  metadata: { description: 'Acme plugins', version: '1.0.0', pluginRoot: './plugins' },
  forceRemoveDeletedPlugins: true,
  plugins: [
    { name: 'formatter', source: 'formatter', description: 'Formats code', version: '1.2.0', category: 'development', tags: ['fmt', 'style'] },
    { name: 'linter', source: './tools/linter' },
    { name: 'gh-plugin', source: { source: 'github', repo: 'acme/gh-plugin', ref: 'v2', sha: SHA.toUpperCase() } },
    { name: 'gh-url', source: { source: 'url', url: 'https://github.com/acme/url-plugin.git', ref: 'main' } },
    { name: 'gitlab', source: { source: 'url', url: 'https://gitlab.example.invalid/acme/x.git' } },
    { name: 'subdir', source: { source: 'git-subdir', url: 'acme/monorepo', path: 'tools/x' } },
    { name: 'subdir-ssh', source: { source: 'git-subdir', url: 'git@github.com:acme/mono.git', path: './pkgs/y/' } },
    { name: 'subdir-other', source: { source: 'git-subdir', url: 'https://git.example.invalid/m.git', path: 'a' } },
    { name: 'npm-plugin', source: { source: 'npm', package: '@acme/claude-plugin', version: '^2' } },
    { name: 'npm-default', source: { source: 'npm', package: 'plain-plugin', registry: 'https://registry.npmjs.org/' } },
    { name: 'npm-private', source: { source: 'npm', package: '@acme/private', registry: 'https://npm.example.invalid' } },
    { name: 'archive', source: { source: 'archive', url: 'https://example.invalid/p.zip', sha256: SHA256 } },
    { name: 'archive-http', source: { source: 'archive', url: 'http://example.invalid/p.zip' } },
    { name: 'cmd', source: { source: 'command', command: 'curl -s https://example.invalid/install | sh', timeout: 60 } },
    {
      name: 'inline-def',
      source: './inline',
      strict: false,
      author: { name: 'Bob' },
      commands: ['./commands/run.md'],
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
      mcpServers: { local: { command: 'node', args: ['server.mjs'] } },
      userConfig: { MODE: { type: 'string', title: 'Mode' } },
      relevance: 3,
    },
    { name: 'weird', source: { source: 'svn', url: 'svn://example.invalid' } },
    { name: 'escape', source: '../outside' },
    { name: 'bad-gh', source: { source: 'github', repo: 'not a repo' } },
    { source: './no-name' },
    { name: 'bad name', source: './x' },
    'not-an-object',
    { name: 'formatter', source: './dup' },
    { name: 'no-source' },
  ],
  unknownTop: true,
}

describe('parseMarketplaceJson', () => {
  const result = parseMarketplaceJson(JSON.stringify(MARKETPLACE))
  const marketplace = result.marketplace
  const entry = (name: string): ClaudeMarketplaceEntry => {
    const found = marketplace?.plugins.find(plugin => plugin.name === name)
    if (found === undefined)
      throw new Error(`entry ${name} missing`)
    return found
  }

  it('reads the marketplace fields', () => {
    expect(marketplace).toMatchObject({
      name: 'acme-tools',
      owner: { name: 'Acme', email: 'tools@example.invalid' },
      description: 'Acme plugins',
      version: '1.0.0',
      pluginRoot: 'plugins',
    })
    expect(marketplace?.plugins.map(plugin => plugin.name)).toEqual([
      'formatter',
      'linter',
      'gh-plugin',
      'gh-url',
      'gitlab',
      'subdir',
      'subdir-ssh',
      'subdir-other',
      'npm-plugin',
      'npm-default',
      'npm-private',
      'archive',
      'archive-http',
      'cmd',
      'inline-def',
      'weird',
      'escape',
      'bad-gh',
    ])
  })

  it.each([
    ['formatter', { kind: 'relative', path: 'plugins/formatter' }, true],
    ['linter', { kind: 'relative', path: 'tools/linter' }, true],
    ['gh-plugin', { kind: 'github', repo: 'acme/gh-plugin', ref: 'v2', sha: SHA }, true],
    ['gh-url', { kind: 'github', repo: 'acme/url-plugin', ref: 'main' }, true],
    ['gitlab', { kind: 'url', url: 'https://gitlab.example.invalid/acme/x.git' }, false],
    ['subdir', { kind: 'github', repo: 'acme/monorepo', path: 'tools/x' }, true],
    ['subdir-ssh', { kind: 'github', repo: 'acme/mono', path: 'pkgs/y' }, true],
    ['subdir-other', { kind: 'git-subdir', url: 'https://git.example.invalid/m.git', path: 'a' }, false],
    ['npm-plugin', { kind: 'npm', package: '@acme/claude-plugin', version: '^2' }, true],
    ['npm-default', { kind: 'npm', package: 'plain-plugin', registry: 'https://registry.npmjs.org/' }, true],
    ['npm-private', { kind: 'npm', package: '@acme/private', registry: 'https://npm.example.invalid' }, false],
    ['archive', { kind: 'archive', url: 'https://example.invalid/p.zip', sha256: SHA256.toLowerCase() }, true],
    ['archive-http', { kind: 'archive', url: 'http://example.invalid/p.zip' }, false],
    ['cmd', { kind: 'command' }, false],
    ['inline-def', { kind: 'relative', path: 'inline' }, true],
    ['weird', { kind: 'unknown' }, false],
    ['escape', { kind: 'unknown' }, false],
    ['bad-gh', { kind: 'unknown' }, false],
  ])('classifies the source of %s', (name, source, supported) => {
    const found = entry(name)
    expect(found.source).toEqual(source)
    expect(found.supported).toBe(supported)
    expect(CLAUDE_ENTRY_SOURCE_KINDS).toContain(found.source.kind)
    if (supported)
      expect(found.unsupportedReason).toBeUndefined()
    else
      expect(found.unsupportedReason).toMatch(/\.$/)
  })

  it('keeps entry metadata, strict and the inline overlay', () => {
    expect(entry('formatter')).toMatchObject({ description: 'Formats code', version: '1.2.0', category: 'development', tags: ['fmt', 'style'], strict: true, overlay: { description: 'Formats code', version: '1.2.0' } })
    const inline = entry('inline-def')
    expect(inline.strict).toBe(false)
    expect(Object.keys(inline.overlay).sort()).toEqual(['author', 'commands', 'hooks', 'mcpServers', 'userConfig'])
    expect(inline.overlay.commands).toEqual(['./commands/run.md'])
  })

  it('drops invalid entries with diagnostics, never the whole file', () => {
    const list = codes(result.diagnostics)
    expect(list).toEqual(expect.arrayContaining([
      'warning:missing-name@plugins[18].name',
      'warning:invalid-name@plugins[19].name',
      'warning:invalid-field@plugins[20]',
      'warning:invalid-field@plugins[21].name',
      'warning:invalid-source@plugins[22].source',
      'warning:path-outside-root@plugins[16].source',
      'warning:invalid-source@plugins[17].source.repo',
      'info:unsupported-source@plugins[13].source',
      'info:unknown-field@plugins[14].relevance',
      'warning:unknown-field@unknownTop',
    ]))
    expect(result.diagnostics.some(entry => entry.level === 'error')).toBe(false)
    expect(CLAUDE_PLUGIN_DIAGNOSTIC_CODES).toEqual(expect.arrayContaining([...new Set(result.diagnostics.map(entry => entry.code))]))
  })

  it('refuses files without a usable name or plugin list', () => {
    expect(parseMarketplaceJson(JSON.stringify({ owner: { name: 'x' }, plugins: [] })).marketplace).toBeNull()
    expect(parseMarketplaceJson(JSON.stringify({ name: 'a..b', owner: { name: 'x' }, plugins: [] })).marketplace).toBeNull()
    expect(parseMarketplaceJson(JSON.stringify({ name: '-x', owner: { name: 'x' }, plugins: [] })).marketplace).toBeNull()
    expect(parseMarketplaceJson(JSON.stringify({ name: 'ok', owner: { name: 'x' } })).marketplace).toBeNull()
    expect(codes(parseMarketplaceJson('nope').diagnostics)).toEqual(['error:invalid-json'])
    const noOwner = parseMarketplaceJson(JSON.stringify({ name: 'ok', plugins: [] }))
    expect(noOwner.marketplace).toEqual({ name: 'ok', owner: { name: '' }, plugins: [] })
    expect(codes(noOwner.diagnostics)).toEqual(['warning:invalid-field@owner'])
  })

  it('reads bare relative sources from the marketplace folder without pluginRoot', () => {
    const plain = parseMarketplaceJson(JSON.stringify({ name: 'plain', owner: { name: 'x' }, plugins: [{ name: 'a', source: 'a' }, { name: 'root', source: './' }] }))
    expect(plain.marketplace?.plugins.map(plugin => plugin.source)).toEqual([{ kind: 'relative', path: 'a' }, { kind: 'relative', path: '.' }])
    expect(codes(plain.diagnostics)).toEqual(['info:invalid-path@plugins[0].source'])
  })

  it('caps the number of entries', () => {
    const plugins = Array.from({ length: CLAUDE_PLUGIN_LIMITS.marketplaceEntriesMax + 5 }, (_, index) => ({ name: `p${index}`, source: `./p${index}` }))
    const capped = parseMarketplaceJson(JSON.stringify({ name: 'big', owner: { name: 'x' }, plugins }))
    expect(capped.marketplace?.plugins).toHaveLength(CLAUDE_PLUGIN_LIMITS.marketplaceEntriesMax)
    expect(codes(capped.diagnostics)).toEqual(['warning:too-many@plugins'])
  })

  it('knows the official marketplace names', () => {
    expect(['claude-plugins-official', 'claude-code-plugins', 'claude-community', 'anthropic-tools', 'Claude-Plugins-Official'].every(isOfficialMarketplaceName)).toBe(true)
    expect(['acme-tools', 'claude-tools', 'anthropics', 7 as unknown as string].some(isOfficialMarketplaceName)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Entry overlay

function entryOf(value: Record<string, unknown>): ClaudeMarketplaceEntry {
  const parsed = parseMarketplaceJson(JSON.stringify({ name: 'm', owner: { name: 'o' }, plugins: [{ source: './p', ...value }] }))
  const found = parsed.marketplace?.plugins[0]
  if (found === undefined)
    throw new Error('entry expected')
  return found
}

describe('mergeEntryOverlay', () => {
  it('uses the entry as the manifest when there is no plugin.json', () => {
    const merged = mergeEntryOverlay(null, entryOf({ name: 'solo', version: '3.0.0', description: 'From the entry', agents: ['./agents/a.md'] }))
    expect(merged.manifest).toEqual({
      name: 'solo',
      version: '3.0.0',
      description: 'From the entry',
      keywords: [],
      defaultEnabled: true,
      agents: ['agents/a.md'],
      userConfig: [],
      unsupported: [],
    })
    expect(merged.diagnostics).toEqual([])
  })

  it('appends component lists with strict: true and lets plugin.json win metadata', () => {
    const own = manifestOf({
      name: 'kit',
      version: '1.0.0',
      commands: './commands',
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'a' }] }], Stop: [{ hooks: [{ type: 'command', command: 'b' }] }] },
      userConfig: { A: { type: 'string', title: 'A' } },
    })
    const entry = entryOf({
      name: 'kit-entry',
      version: '9.9.9',
      description: 'Entry description',
      defaultEnabled: false,
      commands: ['./extra/x.md', './commands'],
      agents: ['./agents/extra.md'],
      skills: './more-skills',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'c' }] }] },
      mcpServers: './extra.mcp.json',
      userConfig: { A: { type: 'number', title: 'A2' }, B: { type: 'boolean', title: 'B' } },
      lspServers: './.lsp.json',
    })
    const merged = mergeEntryOverlay(own, entry).manifest
    expect(merged).toMatchObject({
      name: 'kit',
      version: '1.0.0',
      description: 'Entry description',
      defaultEnabled: false,
      commands: { paths: ['commands', 'extra/x.md'], inline: [] },
      agents: ['agents/extra.md'],
      skills: ['more-skills'],
      mcpServers: { files: ['extra.mcp.json'], inline: [] },
      unsupported: ['lspServers'],
      appendToDefault: ['agents'],
    })
    expect(merged?.hooks?.inline).toEqual([
      { PreToolUse: [{ hooks: [{ type: 'command', command: 'a' }] }] },
      { Stop: [{ hooks: [{ type: 'command', command: 'c' }] }] },
    ])
    expect(merged?.userConfig.map(option => `${option.key}:${option.type}`)).toEqual(['A:string', 'B:boolean'])
  })

  it('makes the entry the whole definition with strict: false', () => {
    const own = manifestOf({ name: 'bare', version: '0.1.0', license: 'MIT' })
    const merged = mergeEntryOverlay(own, entryOf({ name: 'bare-entry', strict: false, commands: ['./c.md'], description: 'E', version: '5.0.0' }))
    expect(merged.manifest).toMatchObject({ name: 'bare', version: '0.1.0', license: 'MIT', description: 'E', commands: { paths: ['c.md'], inline: [] } })
    expect(merged.manifest?.appendToDefault).toBeUndefined()
  })

  it('refuses strict: false when plugin.json also declares components', () => {
    for (const components of [{ commands: './c' }, { skills: './s' }, { hooks: './h.json' }, { mcpServers: { x: { command: 'node' } } }, { lspServers: './l.json' }]) {
      const own = manifestOf({ name: 'both', ...components })
      const merged = mergeEntryOverlay(own, entryOf({ name: 'both', strict: false, agents: ['./a.md'] }))
      expect(merged.manifest).toBeNull()
      expect(codes(merged.diagnostics)).toEqual(['error:conflicting-manifests'])
    }
  })

  it('never throws on malformed input', () => {
    expect(mergeEntryOverlay(null, null as unknown as ClaudeMarketplaceEntry).manifest).toBeNull()
    const odd = { name: 'odd', strict: true, overlay: 'nope', tags: [], supported: true, source: { kind: 'unknown' } } as unknown as ClaudeMarketplaceEntry
    expect(mergeEntryOverlay(null, odd).manifest?.name).toBe('odd')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Plugin ids

describe('claudePluginId', () => {
  const options = { digest: sha256, isReserved: isReservedPluginId }

  it.each([
    ['review-kit', 'review-kit'],
    ['My Cool_Plugin!!', 'my-cool-plugin'],
    ['--a--b--', 'a-b'],
    ['Plugin.v2', 'plugin-v2'],
    ['openai', 'cc-openai'],
    ['core-tools', 'cc-core-tools'],
    ['mock', 'cc-mock'],
  ])('slugs %j', (name, id) => {
    expect(claudePluginId(name, options)).toBe(id)
  })

  it('shortens long names with a sha256 suffix', () => {
    const name = 'a-very-long-plugin-name-that-goes-on-and-on-forever'
    const id = claudePluginId(name, options)
    expect(id).toBe(`a-very-long-plugin-name-that-go-${sha256(name).slice(0, 8)}`)
    expect(id).toHaveLength(40)
    const dashed = claudePluginId('abcdefghij-abcdefghij-abcdefghi-zzzzzzzzzzzzzzzz', options)
    expect(dashed).toBe(`abcdefghij-abcdefghij-abcdefghi-${sha256('abcdefghij-abcdefghij-abcdefghi-zzzzzzzzzzzzzzzz').slice(0, 8)}`)
  })

  it('prefixes long reserved ids and still fits 40 characters', () => {
    const name = `core-${'x'.repeat(35)}`
    const id = claudePluginId(name, options)
    expect(id.startsWith('cc-core-')).toBe(true)
    expect(id).toHaveLength(40)
    expect(PLUGIN_ID_PATTERN.test(id)).toBe(true)
  })

  it('names empty slugs plugin-<hex>', () => {
    expect(claudePluginId('', options)).toBe(`plugin-${sha256('').slice(0, 8)}`)
    expect(claudePluginId('!!!', options)).toBe(`plugin-${sha256('!!!').slice(0, 8)}`)
    expect(claudePluginId('日本語', options)).toBe(`plugin-${sha256('日本語').slice(0, 8)}`)
  })

  it('falls back to FNV-1a when the digest is unusable', () => {
    const fail = (): string => {
      throw new Error('no digest')
    }
    const throwing = claudePluginId('', { digest: fail, isReserved: () => false })
    const garbage = claudePluginId('', { digest: () => 'zz', isReserved: () => false })
    expect(throwing).toMatch(/^plugin-[\da-f]{8}$/)
    expect(garbage).toBe(throwing)
    expect(claudePluginId('x', { digest: sha256, isReserved: () => true })).toMatch(/^plugin-[\da-f]{8}$/)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Variables

describe('substitutePluginVariables', () => {
  const vars = {
    pluginRoot: '/data/plugins/review-kit',
    pluginData: '/data/plugin-data/review-kit',
    projectDir: '/work/app',
    skillDir: '/data/plugins/review-kit/skills/pdf',
    userConfig: { API_URL: 'https://api.example.invalid', API_TOKEN: 'sk-secret-token', DOLLAR: '$& $1 $$' },
    sensitiveKeys: new Set(['API_TOKEN']),
  }

  it('substitutes every known variable in exec mode', () => {
    const result = substitutePluginVariables('${CLAUDE_PLUGIN_ROOT}/bin/run --data ${CLAUDE_PLUGIN_DATA} --cwd ${CLAUDE_PROJECT_DIR} --skill ${CLAUDE_SKILL_DIR} --url ${user_config.API_URL} --token ${user_config.API_TOKEN}', vars, { mode: 'exec' })
    expect(result).toEqual({
      text: '/data/plugins/review-kit/bin/run --data /data/plugin-data/review-kit --cwd /work/app --skill /data/plugins/review-kit/skills/pdf --url https://api.example.invalid --token sk-secret-token',
      unresolved: [],
    })
  })

  it('never puts sensitive values into markdown', () => {
    const result = substitutePluginVariables('Use ${user_config.API_URL} with token "${user_config.API_TOKEN}".', vars, { mode: 'markdown' })
    expect(result).toEqual({ text: 'Use https://api.example.invalid with token "".', unresolved: ['user_config.API_TOKEN'] })
    expect(result.text).not.toContain('sk-secret-token')
  })

  it('keeps unknown and missing references literal and reports them', () => {
    const result = substitutePluginVariables('${CLAUDE_PROJECT_DIR} ${user_config.MISSING} ${HOME} ${VAR:-fallback} ${a + b} $CLAUDE_PLUGIN_ROOT ${user_config.constructor}', { pluginRoot: '/p' }, { mode: 'markdown' })
    expect(result.text).toBe('${CLAUDE_PROJECT_DIR} ${user_config.MISSING} ${HOME} ${VAR:-fallback} ${a + b} $CLAUDE_PLUGIN_ROOT ${user_config.constructor}')
    expect(result.unresolved).toEqual(['CLAUDE_PROJECT_DIR', 'user_config.MISSING', 'HOME', 'VAR', 'user_config.constructor'])
  })

  it('honors escapes of known variables only', () => {
    const result = substitutePluginVariables('\\${CLAUDE_PLUGIN_ROOT} \\${user_config.API_TOKEN} \\${OTHER} \\$ARGUMENTS ${CLAUDE_PLUGIN_ROOT}', vars, { mode: 'markdown' })
    expect(result).toEqual({ text: '${CLAUDE_PLUGIN_ROOT} ${user_config.API_TOKEN} \\${OTHER} \\$ARGUMENTS /data/plugins/review-kit', unresolved: [] })
  })

  it('inserts values literally and never reads the server environment', () => {
    expect(substitutePluginVariables('[${user_config.DOLLAR}]', vars, { mode: 'exec' }).text).toBe('[$& $1 $$]')
    process.env.HF_C41_CANARY = 'canary-value'
    try {
      const result = substitutePluginVariables('${HF_C41_CANARY} ${user_config.HF_C41_CANARY}', {}, { mode: 'exec' })
      expect(result.text).toBe('${HF_C41_CANARY} ${user_config.HF_C41_CANARY}')
    }
    finally {
      delete process.env.HF_C41_CANARY
    }
  })

  it('never throws on odd input', () => {
    expect(substitutePluginVariables(undefined as unknown as string, vars, { mode: 'exec' })).toEqual({ text: '', unresolved: [] })
    expect(substitutePluginVariables('${CLAUDE_PLUGIN_ROOT}', null as unknown as object, null as unknown as { mode: 'exec' }).text).toBe('${CLAUDE_PLUGIN_ROOT}')
    const many = Array.from({ length: 80 }, (_, index) => `\${V${index}}`).join(' ')
    expect(substitutePluginVariables(many, {}, { mode: 'exec' }).unresolved).toHaveLength(50)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// userConfig → settings

describe('userConfigToSettings', () => {
  it('maps every option type to a valid plugin settings schema', () => {
    const options = manifestOf(FULL_PLUGIN).userConfig
    const result = userConfigToSettings(options)
    expect(settingsSchemaSchema.safeParse(result.schema).success).toBe(true)
    expect(result.schema).toEqual({
      type: 'object',
      properties: {
        API_URL: { type: 'string', title: 'API URL', description: 'Base URL of the review API.', default: 'https://api.example.invalid' },
        API_TOKEN: { type: 'string', title: 'API token', format: 'secret' },
        LEVEL: { type: 'string', title: 'Level', enum: ['low', 'high'], default: 'low' },
        TAGS: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['a', 'b'] }, default: ['a'] },
        RETRIES: { type: 'number', title: 'Retries', minimum: 0, maximum: 5, default: 2 },
        VERBOSE: { type: 'boolean', title: 'Verbose', default: false },
        WORKDIR: { type: 'string', title: 'Work folder', description: '(absolute path on the server)', pattern: '^/', default: '/srv/work' },
        CONFIG: { type: 'string', title: 'Config file', description: '(absolute path on the server)', pattern: '^/' },
      },
      required: ['API_TOKEN', 'CONFIG'],
    })
    expect(result.diagnostics).toEqual([])
  })

  it('drops what a settings schema cannot hold, with warnings', () => {
    const options: ClaudeUserConfigOption[] = [
      { key: 'SECRET', type: 'string', title: 'Secret', required: false, default: 'leaked-default', multiple: true, sensitive: true },
      { key: 'COUNT', type: 'number', title: 'Count', required: false, min: 10, max: 1, default: 20, multiple: false, sensitive: false },
      { key: 'RANGE', type: 'number', title: 'Range', required: false, min: 0, max: 3, default: 9, multiple: false, sensitive: false },
      { key: 'DIR', type: 'directory', title: 'Dir', required: false, default: 'relative/path', multiple: false, sensitive: false },
      { key: 'DIRS', type: 'directory', title: 'Dirs', required: false, default: ['/a', '/b'], multiple: true, sensitive: false },
      { key: 'PICK', type: 'string', title: 'Pick', required: false, options: ['x'], default: 'y', multiple: false, sensitive: false },
      { key: 'FLAG', type: 'boolean', title: 'Flag', required: false, default: 'yes' as unknown as boolean, multiple: false, sensitive: false },
      { key: 'NUM_OPTS', type: 'number', title: 'N', required: false, options: ['1'], multiple: false, sensitive: false },
      { key: '_private', type: 'string', title: 'P', required: true, multiple: false, sensitive: false },
      { key: 'SECRET', type: 'string', title: 'Again', required: false, multiple: false, sensitive: false },
    ]
    const result = userConfigToSettings(options)
    expect(settingsSchemaSchema.safeParse(result.schema).success).toBe(true)
    const properties = result.schema.properties as Record<string, Record<string, unknown>>
    expect(properties.SECRET).toEqual({ type: 'string', title: 'Secret', format: 'secret' })
    expect(properties.COUNT).toEqual({ type: 'number', title: 'Count', default: 20 })
    expect(properties.RANGE).toEqual({ type: 'number', title: 'Range', minimum: 0, maximum: 3 })
    expect(properties.DIR).toEqual({ type: 'string', title: 'Dir', description: '(absolute path on the server)', pattern: '^/' })
    expect(properties.DIRS).toEqual({ type: 'array', title: 'Dirs', description: '(absolute paths on the server)', items: { type: 'string' }, default: ['/a', '/b'] })
    expect(properties.PICK).toEqual({ type: 'string', title: 'Pick', enum: ['x'] })
    expect(properties.FLAG).toEqual({ type: 'boolean', title: 'Flag' })
    expect(properties.NUM_OPTS).toEqual({ type: 'number', title: 'N' })
    expect(Object.keys(properties)).not.toContain('_private')
    expect(result.schema.required).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('leaked-default')
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(9)
    expect(result.diagnostics.every(entry => entry.level === 'warning')).toBe(true)
  })

  it('keeps at most 50 options', () => {
    const options = Array.from({ length: 60 }, (_, index): ClaudeUserConfigOption => ({ key: `K${index}`, type: 'string', title: `K${index}`, required: false, multiple: false, sensitive: false }))
    const result = userConfigToSettings(options)
    expect(Object.keys(result.schema.properties as object)).toHaveLength(CLAUDE_PLUGIN_LIMITS.userConfigMax)
    expect(settingsSchemaSchema.safeParse(result.schema).success).toBe(true)
    expect(codes(result.diagnostics)).toEqual(['warning:too-many@userConfig'])
  })

  it('never throws on malformed input', () => {
    expect(userConfigToSettings(null as unknown as ClaudeUserConfigOption[]).schema).toEqual({ type: 'object', properties: {} })
    const weird = userConfigToSettings([null, 7, { key: '__proto__', type: 'string', title: 'x' }, { key: 'toString', type: 'string', title: 'x' }] as unknown as ClaudeUserConfigOption[])
    expect(Object.keys(weird.schema.properties as object)).toEqual(['toString'])
    expect(settingsSchemaSchema.safeParse(weird.schema).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// "Add marketplace" input

describe('parseMarketplaceShorthand', () => {
  it.each<[string, MarketplaceShorthand | null]>([
    ['anthropics/claude-plugins-official', { kind: 'github', repo: 'anthropics/claude-plugins-official' }],
    ['  acme/tools  ', { kind: 'github', repo: 'acme/tools' }],
    ['acme/tools#v2', { kind: 'github', repo: 'acme/tools', ref: 'v2' }],
    ['acme/tools@release/1.x', { kind: 'github', repo: 'acme/tools', ref: 'release/1.x' }],
    ['acme/tools.git', { kind: 'github', repo: 'acme/tools' }],
    ['https://github.com/acme/tools', { kind: 'github', repo: 'acme/tools' }],
    ['https://github.com/acme/tools.git', { kind: 'github', repo: 'acme/tools' }],
    ['https://github.com/acme/tools/', { kind: 'github', repo: 'acme/tools' }],
    ['https://www.github.com/acme/tools#main', { kind: 'github', repo: 'acme/tools', ref: 'main' }],
    ['https://github.com/acme/tools/tree/dev', { kind: 'github', repo: 'acme/tools', ref: 'dev' }],
    ['git@github.com:acme/tools.git', { kind: 'github', repo: 'acme/tools' }],
    ['https://example.invalid/claude/marketplace.json', { kind: 'url', url: 'https://example.invalid/claude/marketplace.json' }],
    ['https://raw.githubusercontent.com/acme/tools/main/.claude-plugin/marketplace.json', { kind: 'url', url: 'https://raw.githubusercontent.com/acme/tools/main/.claude-plugin/marketplace.json' }],
    ['/srv/marketplaces/acme', { kind: 'path', path: '/srv/marketplaces/acme' }],
    ['/srv//marketplaces/acme/', { kind: 'path', path: '/srv/marketplaces/acme' }],
    ['', null],
    ['   ', null],
    ['acme', null],
    ['acme/tools/extra', null],
    ['acme/tools#', null],
    ['acme/tools#a..b', null],
    ['acme/tools@v1#v2', null],
    ['-acme/tools', null],
    ['acme/..', null],
    ['http://github.com/acme/tools', null],
    ['https://gitlab.example.invalid/acme/tools.git', null],
    ['https://example.invalid/marketplace.json#x', null],
    ['https://user:pass@example.invalid/marketplace.json', null],
    ['https://github.com/acme/tools/blob/main/x', null],
    ['./local-dir', null],
    ['~/marketplace', null],
    ['/srv/../etc', null],
    ['C:\\marketplaces', null],
    ['acme /tools', null],
    ['acme/tools\u0000', null],
  ])('parses %j', (input, expected) => {
    expect(parseMarketplaceShorthand(input)).toEqual(expected)
  })

  it('refuses non-strings and very long input', () => {
    expect(parseMarketplaceShorthand(42 as unknown as string)).toBeNull()
    expect(parseMarketplaceShorthand(`acme/${'x'.repeat(3000)}`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Fuzzing

const KEYS = [
  'name',
  'source',
  'strict',
  'commands',
  'agents',
  'skills',
  'outputStyles',
  'hooks',
  'mcpServers',
  'userConfig',
  'plugins',
  'owner',
  'metadata',
  'pluginRoot',
  'type',
  'repo',
  'url',
  'path',
  'ref',
  'sha',
  'package',
  'registry',
  'sha256',
  'options',
  'default',
  'title',
  'sensitive',
  'multiple',
  '__proto__',
  'constructor',
]
const STRINGS = ['', '.', './a', '../x', 'github', 'npm', 'archive', 'url', 'git-subdir', 'command', 'acme/tools', 'https://github.com/a/b', 'string', 'number', '${CLAUDE_PLUGIN_ROOT}', 'é', '\u0000', 'x'.repeat(300)]

function randomValue(random: () => number, depth: number): unknown {
  const pick = random()
  if (depth <= 0 || pick < 0.3)
    return STRINGS[Math.floor(random() * STRINGS.length)]
  if (pick < 0.4)
    return Math.floor(random() * 200) - 100
  if (pick < 0.5)
    return random() < 0.5
  if (pick < 0.55)
    return null
  if (pick < 0.75)
    return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth - 1))
  const object: Record<string, unknown> = {}
  for (let index = Math.floor(random() * 6); index > 0; index--)
    object[KEYS[Math.floor(random() * KEYS.length)] as string] = randomValue(random, depth - 1)
  return object
}

describe('fuzzing', () => {
  it('never throws on random JSON and stays bounded', () => {
    const random = prng(0xC41C41)
    const started = Date.now()
    for (let round = 0; round < 1500; round++) {
      const value = randomValue(random, 4)
      const text = random() < 0.1 ? JSON.stringify(value).slice(0, Math.floor(random() * 40)) : JSON.stringify(value)
      const manifest = parseClaudePluginManifest(text)
      const marketplace = parseMarketplaceJson(text)
      expect(manifest.diagnostics.length).toBeLessThanOrEqual(CLAUDE_PLUGIN_LIMITS.diagnosticsMax)
      expect(marketplace.diagnostics.length).toBeLessThanOrEqual(CLAUDE_PLUGIN_LIMITS.diagnosticsMax)
      for (const entry of [...manifest.diagnostics, ...marketplace.diagnostics])
        expect(CLAUDE_PLUGIN_DIAGNOSTIC_CODES).toContain(entry.code)
      for (const entry of marketplace.marketplace?.plugins ?? []) {
        expect(CLAUDE_ENTRY_SOURCE_KINDS).toContain(entry.source.kind)
        const merged = mergeEntryOverlay(manifest.manifest, entry)
        expect(merged.manifest === null || typeof merged.manifest.name === 'string').toBe(true)
      }
      if (manifest.manifest !== null) {
        for (const path of [...(manifest.manifest.agents ?? []), ...(manifest.manifest.skills ?? []), ...(manifest.manifest.commands?.paths ?? [])])
          expect(path.split('/')).not.toContain('..')
        const settings = userConfigToSettings(manifest.manifest.userConfig)
        expect(settingsSchemaSchema.safeParse(settings.schema).success).toBe(true)
      }
      const name = typeof value === 'string' ? value : text.slice(0, 60)
      const id = claudePluginId(name, { digest: sha256, isReserved: isReservedPluginId })
      expect(PLUGIN_ID_PATTERN.test(id)).toBe(true)
      expect(isReservedPluginId(id)).toBe(false)
      substitutePluginVariables(text, { pluginRoot: '/p', userConfig: { a: 'b' }, sensitiveKeys: new Set(['a']) }, { mode: random() < 0.5 ? 'exec' : 'markdown' })
      parseMarketplaceShorthand(name)
    }
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
