import { describe, expect, it } from 'vitest'
import { marketplaceEntrySourceKindSchema, marketplaceSourceTypeSchema, pluginFormatSchema, pluginSourceSchema } from '../enums.ts'
import { conflictReasonSchema } from '../errors.ts'
import { createServerEvent, serverEventSchema } from '../events.ts'
import { CLAUDE_ENTRY_SOURCE_KINDS } from '../util/claude-plugins.ts'
import {
  commitShaSchema,
  githubRepoSchema,
  gitRefSchema,
  isReservedMarketplaceName,
  MARKETPLACE_SUGGESTIONS,
  marketplaceAddBodySchema,
  marketplaceChangedDataSchema,
  marketplaceDetailSchema,
  marketplaceListSchema,
  marketplaceNameSchema,
  marketplaceParamsSchema,
  marketplaceSourceSchema,
  marketplaceSummarySchema,
  pluginUpdateSchema,
  repoSubpathSchema,
} from './marketplaces.ts'
import {
  claudePluginInfoSchema,
  pluginContributionsSchema,
  pluginDetailSchema,
  pluginInspectBodySchema,
  pluginInspectFormSchema,
  pluginInspectionSchema,
  pluginInstallBodySchema,
  pluginInstallFormSchema,
  pluginOriginSchema,
  pluginSummarySchema,
} from './plugins.ts'

const MARKETPLACE_ID = 'mkt_ABCdef0123456789'
const COMMIT = 'a1'.repeat(20)
const SHA = 'b'.repeat(64)

const summary = {
  id: MARKETPLACE_ID,
  name: 'claude-plugins-official',
  description: 'Official plugins',
  owner: 'Anthropic',
  source: { type: 'github', repo: 'anthropics/claude-plugins-official' },
  resolvedRef: COMMIT,
  plugins: 2,
  updates: 1,
  fetchedAt: 10,
  lastError: null,
  createdAt: 1,
  updatedAt: 10,
} as const

const entry = {
  name: 'review-kit',
  description: 'Reviews',
  version: '1.2.0',
  category: 'development',
  tags: ['review'],
  author: 'Anthropic',
  source: { kind: 'relative', text: './plugins/review-kit' },
  supported: true,
  installedPluginId: 'review-kit',
  updateAvailable: true,
} as const

const info = {
  name: 'review-kit',
  displayName: 'Review kit',
  version: 'v2-beta',
  namespace: 'review-kit',
  components: { commands: 3, agents: 1, skills: 1, outputStyles: 1, hooks: 2, mcpServers: 1 },
  executables: [{ kind: 'hook', label: 'PostToolUse Write', command: 'sh hooks/format.sh' }],
  hosts: ['api.example.com'],
  userConfig: [{ key: 'API_TOKEN', title: 'API token', sensitive: true, required: true }],
  unsupported: [{ component: '.lsp.json', reason: 'LSP servers are not supported.' }],
  diagnostics: [{ level: 'info', code: 'unknown-event', message: 'The event "Elicitation" is not supported.', component: 'hooks', path: 'hooks/hooks.json' }],
} as const

describe('enums (Phase 12, ADR-053 / ADR-054)', () => {
  it('adds the plugin sources, the plugin format and the marketplace kinds', () => {
    expect(pluginSourceSchema.options).toEqual(['builtin', 'created', 'zip', 'npm', 'url', 'link', 'copy', 'github', 'marketplace'])
    expect(pluginFormatSchema.options).toEqual(['harness', 'claude'])
    expect(marketplaceSourceTypeSchema.options).toEqual(['github', 'url', 'path'])
    expect(marketplaceEntrySourceKindSchema.options).toEqual([...CLAUDE_ENTRY_SOURCE_KINDS])
    expect(conflictReasonSchema.options.at(-1)).toBe('offline')
  })
})

describe('names, repositories and refs', () => {
  it('validates marketplace names and tells the reserved ones apart', () => {
    for (const name of ['claude-plugins-official', 'my.market_place-2', 'A'])
      expect(marketplaceNameSchema.safeParse(name).success, name).toBe(true)
    for (const name of ['', 'has space', 'a/b', 'x'.repeat(65)])
      expect(marketplaceNameSchema.safeParse(name).success, name).toBe(false)
    for (const name of ['claude-plugins-official', 'claude-code-plugins', 'claude-community', 'anthropic-tools', 'Anthropic-Labs'])
      expect(isReservedMarketplaceName(name), name).toBe(true)
    for (const name of ['my-plugins', 'anthropics', 'claude-plugins'])
      expect(isReservedMarketplaceName(name), name).toBe(false)
  })

  it('validates GitHub repositories, refs, commits and subpaths', () => {
    for (const repo of ['anthropics/claude-plugins-official', 'a/b', 'user-1/repo.name_x'])
      expect(githubRepoSchema.safeParse(repo).success, repo).toBe(true)
    for (const repo of ['anthropics', 'a/b/c', '-a/b', 'a/..', 'a/.', 'a b/c', `a/${'r'.repeat(101)}`])
      expect(githubRepoSchema.safeParse(repo).success, repo).toBe(false)
    for (const ref of ['main', 'v1.2.0', 'feature/x', COMMIT, 'release_2026'])
      expect(gitRefSchema.safeParse(ref).success, ref).toBe(true)
    for (const ref of ['', '/main', '-x', 'a..b', 'a//b', 'main/', 'a b', 'a~1', 'x'.repeat(256)])
      expect(gitRefSchema.safeParse(ref).success, ref).toBe(false)
    expect(commitShaSchema.safeParse(COMMIT).success).toBe(true)
    expect(commitShaSchema.safeParse(COMMIT.toUpperCase()).success).toBe(false)
    expect(commitShaSchema.safeParse(COMMIT.slice(0, 12)).success).toBe(false)
    for (const path of ['plugins/review-kit', 'a', 'with space/x'])
      expect(repoSubpathSchema.safeParse(path).success, path).toBe(true)
    for (const path of ['', '/abs', 'a/../b', './a', 'a//b', 'a\\b', 'a/'])
      expect(repoSubpathSchema.safeParse(path).success, path).toBe(false)
  })
})

describe('marketplace sources and DTOs', () => {
  it('parses the three source types (strict) and the add body', () => {
    for (const source of [
      { type: 'github', repo: 'anthropics/claude-plugins-official' },
      { type: 'github', repo: 'acme/plugins', ref: 'v2' },
      { type: 'url', url: 'https://example.com/.claude-plugin/marketplace.json' },
      { type: 'path', path: '/srv/marketplace' },
    ])
      expect(marketplaceSourceSchema.parse(source)).toEqual(source)
    for (const source of [
      { type: 'url', url: 'http://example.com/marketplace.json' },
      { type: 'url', url: 'https://user:pass@example.com/m.json' },
      { type: 'path', path: 'relative' },
      { type: 'git', url: 'https://example.com/x.git' },
      { type: 'github', repo: 'a/b', sha: COMMIT },
    ])
      expect(marketplaceSourceSchema.safeParse(source).success, JSON.stringify(source)).toBe(false)
    expect(marketplaceAddBodySchema.parse({ source: { type: 'path', path: '/m' } })).toEqual({ source: { type: 'path', path: '/m' } })
    expect(marketplaceAddBodySchema.safeParse({ source: { type: 'path', path: '/m' }, name: 'x' }).success).toBe(false)
    expect(marketplaceParamsSchema.safeParse({ id: MARKETPLACE_ID }).success).toBe(true)
    expect(marketplaceParamsSchema.safeParse({ id: 'prj_ABCdef0123456789' }).success).toBe(false)
  })

  it('parses summaries, details, the list and the event', () => {
    expect(marketplaceSummarySchema.parse(summary)).toEqual(summary)
    const detail = { ...summary, entries: [entry, { ...entry, name: 'gitlab', source: { kind: 'git', text: 'https://gitlab.example/x.git' }, supported: false, unsupportedReason: 'Only GitHub git sources are supported.', installedPluginId: null, updateAvailable: false }], diagnostics: [] }
    expect(marketplaceDetailSchema.parse(detail)).toEqual(detail)
    expect(marketplaceDetailSchema.safeParse({ ...detail, entries: [{ ...entry, source: { kind: 'svn', text: 'x' } }] }).success).toBe(false)
    const update = { pluginId: 'review-kit', marketplaceId: MARKETPLACE_ID, plugin: 'review-kit', version: '1.1.0', availableVersion: '1.2.0' }
    expect(pluginUpdateSchema.parse(update)).toEqual(update)
    const list = { items: [summary], suggestions: [...MARKETPLACE_SUGGESTIONS], updates: [update] }
    expect(marketplaceListSchema.parse(list)).toEqual(list)
    expect(marketplaceChangedDataSchema.parse({ id: MARKETPLACE_ID, marketplace: null })).toEqual({ id: MARKETPLACE_ID, marketplace: null })
    expect(serverEventSchema.parse(createServerEvent('marketplace.changed', { id: MARKETPLACE_ID, marketplace: summary }, 3)).data).toEqual({ id: MARKETPLACE_ID, marketplace: summary })
  })

  it('suggests only the official marketplace, from the anthropics owner', () => {
    expect(MARKETPLACE_SUGGESTIONS).toHaveLength(1)
    expect(MARKETPLACE_SUGGESTIONS[0]?.source).toEqual({ type: 'github', repo: 'anthropics/claude-plugins-official' })
    expect(isReservedMarketplaceName(MARKETPLACE_SUGGESTIONS[0]!.name)).toBe(true)
    expect(Object.isFrozen(MARKETPLACE_SUGGESTIONS)).toBe(true)
  })
})

describe('plugins (Phase 12)', () => {
  const contributions = { providers: [], models: 0, tools: [], mcpServers: ['review-kit'], commands: ['review-kit:review', 'review-kit:db:migrate'], hooks: [], agents: ['review-kit:code-reviewer'], skills: ['review-kit:pdf'], commandHooks: 1, outputStyles: ['review-kit:terse'] }
  const pluginSummary = {
    id: 'review-kit',
    name: 'Review kit',
    version: '0.0.0+v2-beta',
    description: null,
    icon: null,
    kind: 'declarative',
    format: 'claude',
    source: 'marketplace',
    sourceRef: 'review-kit@claude-plugins-official',
    builtin: false,
    removable: true,
    enabled: true,
    state: 'untrusted',
    runsCode: true,
    contributions,
    lastError: null,
    installedAt: 1,
    updatedAt: 1,
  } as const

  it('lists qualified contributions and the format; v1.7 summaries without a format no longer parse', () => {
    expect(pluginContributionsSchema.parse(contributions)).toEqual(contributions)
    expect(pluginSummarySchema.parse(pluginSummary)).toEqual(pluginSummary)
    const { format: _format, ...v17 } = pluginSummary
    expect(pluginSummarySchema.safeParse(v17).success).toBe(false)
    expect(pluginContributionsSchema.safeParse({ ...contributions, commands: ['Review-Kit:review'] }).success).toBe(false)
  })

  it('carries the origin and the Claude Code plugin info in details', () => {
    const origin = { kind: 'marketplace', marketplaceId: MARKETPLACE_ID, marketplace: 'claude-plugins-official', plugin: 'review-kit', sourceKind: 'relative', commit: COMMIT, path: 'plugins/review-kit', version: null } as const
    expect(pluginOriginSchema.parse(origin)).toEqual(origin)
    const github = { kind: 'github', repo: 'acme/plugins', ref: null, commit: COMMIT, path: null } as const
    expect(pluginOriginSchema.parse(github)).toEqual(github)
    expect(pluginOriginSchema.safeParse({ ...origin, overlay: { strict: false } }).success).toBe(true)
    expect(pluginOriginSchema.parse({ ...origin, overlay: { strict: false } })).not.toHaveProperty('overlay')
    expect(claudePluginInfoSchema.parse(info)).toEqual(info)
    expect(claudePluginInfoSchema.safeParse({ ...info, executables: [{ kind: 'lsp', label: 'x', command: 'x' }] }).success).toBe(false)
    const manifest = { manifestVersion: 1, id: 'review-kit', name: 'Review kit', version: '0.0.0+v2-beta', engines: { harness: '^1.6.0' } }
    const detail = { ...pluginSummary, manifest, trust: { required: true, trusted: false, hash: SHA, trustedHash: null }, editable: false, hasSettings: true, origin, claude: info }
    expect(pluginDetailSchema.parse(detail)).toEqual(detail)
    expect(pluginDetailSchema.parse({ ...detail, format: 'harness', source: 'zip', origin: null, claude: null }).claude).toBeNull()
  })

  it('takes the github and marketplace install sources and the format', () => {
    for (const body of [
      { source: 'github', repo: 'acme/plugins' },
      { source: 'github', repo: 'acme/plugins', ref: 'v1.0.0', path: 'plugins/review-kit', format: 'claude' },
      { source: 'marketplace', marketplaceId: MARKETPLACE_ID, plugin: 'review-kit' },
      { source: 'npm', spec: 'harness-forge-plugin-x@1.0.0', format: 'harness' },
    ]) {
      expect(pluginInspectBodySchema.parse(body)).toEqual(body)
      expect(pluginInstallBodySchema.parse({ ...body, trust: true, sha256: SHA })).toEqual({ ...body, trust: true, sha256: SHA })
    }
    for (const body of [
      { source: 'github', repo: 'acme' },
      { source: 'github', repo: 'acme/plugins', path: '../x' },
      { source: 'github', repo: 'acme/plugins', ref: '..' },
      { source: 'marketplace', marketplaceId: 'mkt_short', plugin: 'review-kit' },
      { source: 'marketplace', marketplaceId: MARKETPLACE_ID },
      { source: 'npm', spec: 'x', format: 'vscode' },
    ])
      expect(pluginInspectBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    expect(pluginInstallFormSchema.parse({ trust: 'true', format: 'claude' })).toEqual({ trust: 'true', format: 'claude' })
    expect(pluginInspectFormSchema.parse({ format: 'claude' })).toEqual({ format: 'claude' })
    expect(pluginInspectFormSchema.safeParse({ format: 'other' }).success).toBe(false)
  })

  it('previews the format and the Claude Code plugin info', () => {
    const inspection = {
      manifest: { manifestVersion: 1, id: 'review-kit', name: 'Review kit', version: '1.2.0', engines: { harness: '^1.6.0' } },
      kind: 'declarative',
      format: 'claude',
      source: 'github',
      sourceRef: `acme/plugins@${COMMIT.slice(0, 12)}/plugins/review-kit`,
      sha256: SHA,
      contributions,
      networkHosts: [],
      secretsRequested: ['API_TOKEN'],
      permissions: [],
      requiresTrust: true,
      compatible: true,
      existing: null,
      files: { count: 12, bytes: 4000 },
      warnings: [],
      claude: info,
    }
    expect(pluginInspectionSchema.parse(inspection)).toEqual(inspection)
    const { claude: _claude, ...withoutInfo } = inspection
    expect(pluginInspectionSchema.safeParse(withoutInfo).success).toBe(false)
  })
})
