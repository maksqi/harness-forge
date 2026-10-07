// Pure parts of the marketplace service (Phase 12, W12.2-T4): the catalog DTOs, the entry install plans, the update
// rules and the GitHub answer mapping.
import type { ClaudeMarketplaceEntry, MarketplaceSource } from '@harness-forge/shared'
import type { PluginRecord } from '../types.ts'
import type { StoredMarketplace } from './store.ts'
import { LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { claudeMarketplaceJson } from '../../testing/claude-fixtures.ts'
import { createFakeRemoteRoutes, createFakeSafeFetch } from '../../testing/fake-remote.ts'
import { diagnosticDtos, entryDto, readCatalog, RELATIVE_FROM_URL_REASON, sourceText } from './catalog.ts'
import { githubAnswerError, githubBases, resolveGithubCommit } from './github.ts'
import { entryOverlay, planEntryInstall } from './sources.ts'
import { hasUpdate, installedEntries, updatesOf } from './updates.ts'

const encoder = new TextEncoder()
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function stored(source: MarketplaceSource, resolvedRef: string | null, plugins?: ClaudeMarketplaceEntry[]): StoredMarketplace {
  const catalog = readCatalog(encoder.encode(claudeMarketplaceJson()))
  return {
    id: 'mkt_AAAAAAAAAAAAAAAA',
    name: 'acme-tools',
    source,
    resolvedRef,
    catalog: plugins === undefined ? catalog : { ...catalog, marketplace: { ...catalog.marketplace, plugins } },
    fetchedAt: 1,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function entry(fields: Partial<ClaudeMarketplaceEntry>): ClaudeMarketplaceEntry {
  return { name: 'kit', source: { kind: 'relative', path: 'plugins/kit' }, supported: true, tags: [], strict: true, overlay: {}, ...fields }
}

function record(id: string, origin: PluginRecord['origin'], version = '1.0.0'): PluginRecord {
  return { id, source: 'marketplace', sourceRef: null, version, enabled: true, trustedHash: null, loadingSince: null, lastError: null, installedAt: 1, updatedAt: 1, format: 'claude', origin }
}

describe('catalog', () => {
  it('readCatalog keeps the parsed marketplace; an unusable file is 400, a huge one 413', () => {
    const catalog = readCatalog(encoder.encode(claudeMarketplaceJson()))
    expect(catalog).toMatchObject({ version: 1, marketplace: { name: 'acme-tools', pluginRoot: 'plugins' } })
    expect(() => readCatalog(encoder.encode('{"name": 1}'))).toThrow(expect.objectContaining({ code: 'validation_error' }))
    expect(() => readCatalog(new Uint8Array([0xFF, 0xFE]))).toThrow(expect.objectContaining({ code: 'validation_error' }))
    expect(() => readCatalog(new Uint8Array(LIMITS.marketplaceJsonBytes + 1))).toThrow(expect.objectContaining({ code: 'payload_too_large' }))
  })

  it('source texts, support and DTO limits', () => {
    expect(sourceText({ kind: 'relative', path: '.' })).toBe('./')
    expect(sourceText({ kind: 'github', repo: 'o/r', sha: SHA_A, path: 'x' })).toBe(`o/r@${SHA_A.slice(0, 12)}/x`)
    expect(sourceText({ kind: 'npm', package: '@o/p' })).toBe('@o/p')
    expect(sourceText({ kind: 'command' })).toBe('command')
    const url: MarketplaceSource = { type: 'url', url: 'https://example.com/m.json' }
    expect(entryDto(entry({}), url, { installedPluginId: null, updateAvailable: false })).toMatchObject({ supported: false, unsupportedReason: RELATIVE_FROM_URL_REASON })
    const long = entryDto(entry({ tags: Array.from({ length: 30 }, (_, index) => `t${index}`), description: 'd'.repeat(5000), overlay: { author: { name: 'Acme' } } }), { type: 'path', path: '/m' }, { installedPluginId: 'kit', updateAvailable: true })
    expect(long).toMatchObject({ author: 'Acme', installedPluginId: 'kit', updateAvailable: true, supported: true })
    expect(long.tags).toHaveLength(20)
    expect(long.description).toHaveLength(1000)
    expect(diagnosticDtos([{ level: 'warning', code: 'unknown-field', message: 'x', field: 'plugins[1].foo' }])).toEqual([{ level: 'warning', code: 'unknown-field', message: 'x', component: 'plugins[1].foo', path: '.claude-plugin/marketplace.json' }])
  })
})

describe('planEntryInstall', () => {
  it('relative entries: the stored commit (github) or the folder (path); github / archive / npm entries as is', () => {
    const github = stored({ type: 'github', repo: 'acme/m' }, SHA_A)
    expect(planEntryInstall(github, github.id, 'review-kit')).toMatchObject({ staging: { kind: 'github', repo: 'acme/m', sha: SHA_A, path: 'plugins/review-kit' }, needsNetwork: true })
    expect(planEntryInstall(github, github.id, 'gh-plugin').staging).toEqual({ kind: 'github', repo: 'acme/gh-plugin', ref: 'v1' })
    expect(planEntryInstall(github, github.id, 'archive-plugin').staging).toMatchObject({ kind: 'archive', url: 'https://downloads.example.com/archive-plugin.zip' })
    expect(planEntryInstall(github, github.id, 'npm-plugin').staging).toEqual({ kind: 'npm', package: '@acme/npm-plugin', spec: '@acme/npm-plugin@^1.0.0' })
    const folder = stored({ type: 'path', path: '/srv/m' }, null)
    expect(planEntryInstall(folder, folder.id, 'bare-notes')).toMatchObject({ staging: { kind: 'folder', root: '/srv/m', path: 'plugins/notes-only' }, needsNetwork: false })
    expect(planEntryInstall(folder, folder.id, 'inline-tools').overlay).toMatchObject({ name: 'inline-tools', strict: false, version: '0.1.0' })
  })

  it('unknown marketplace or entry: 404; unsupported: 400', () => {
    const github = stored({ type: 'github', repo: 'acme/m' }, SHA_A)
    expect(() => planEntryInstall(null, 'mkt_x', 'x')).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => planEntryInstall(github, github.id, 'missing')).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() => planEntryInstall(github, github.id, 'command-plugin')).toThrow(expect.objectContaining({ code: 'validation_error' }))
    const url = stored({ type: 'url', url: 'https://example.com/m.json' }, 'c'.repeat(64))
    expect(() => planEntryInstall(url, url.id, 'review-kit')).toThrow(expect.objectContaining({ code: 'validation_error' }))
  })

  it('entryOverlay keeps only the overlay fields', () => {
    expect(entryOverlay(entry({ version: '2.0.0', description: 'd', overlay: { commands: ['./c.md'] } }))).toEqual({ name: 'kit', strict: true, version: '2.0.0', description: 'd', overlay: { commands: ['./c.md'] } })
  })
})

describe('updates', () => {
  const github = stored({ type: 'github', repo: 'acme/m' }, SHA_B, [
    entry({ name: 'versioned', version: '2.0.0' }),
    entry({ name: 'by-commit' }),
    entry({ name: 'pinned', source: { kind: 'github', repo: 'o/r', sha: SHA_B } }),
    entry({ name: 'archive', source: { kind: 'archive', url: 'https://x/a.zip', sha256: 'd'.repeat(64) } }),
    entry({ name: 'npm', source: { kind: 'npm', package: 'p', version: '1.2.0' } }),
    entry({ name: 'ref-only', source: { kind: 'github', repo: 'o/r', ref: 'main' } }),
  ])
  const origin = (plugin: string, fields: Record<string, unknown> = {}): PluginRecord['origin'] => ({ kind: 'marketplace', marketplaceId: github.id, marketplace: 'acme-tools', plugin, sourceKind: 'relative', version: null, ...fields }) as PluginRecord['origin']
  const records = [
    record('versioned', origin('versioned', { version: '1.0.0' })),
    record('by-commit', origin('by-commit', { commit: SHA_A })),
    record('pinned', origin('pinned', { commit: SHA_A, sourceKind: 'github' })),
    record('archive', origin('archive', { archiveSha256: 'e'.repeat(64), sourceKind: 'archive' })),
    record('npm', origin('npm', { npmVersion: '1.1.0', sourceKind: 'npm' })),
    record('ref-only', origin('ref-only', { commit: SHA_A, sourceKind: 'github' })),
    record('elsewhere', { kind: 'github', repo: 'o/r', ref: null, commit: SHA_A, path: null }),
  ]

  it('version first, then the commit, the pinned sha, the archive sha256, an exact npm version; a bare ref reports nothing', () => {
    const installed = installedEntries(records, github)
    expect([...installed.keys()].sort()).toEqual(['archive', 'by-commit', 'npm', 'pinned', 'ref-only', 'versioned'])
    const result = Object.fromEntries((github.catalog?.marketplace.plugins ?? []).map(item => [item.name, hasUpdate(item, installed.get(item.name)!, github)]))
    expect(result).toEqual({ 'versioned': true, 'by-commit': true, 'pinned': true, 'archive': true, 'npm': true, 'ref-only': false })
    expect(updatesOf(github, records).find(update => update.pluginId === 'versioned')).toEqual({ pluginId: 'versioned', marketplaceId: github.id, plugin: 'versioned', version: '1.0.0', availableVersion: '2.0.0' })
  })

  it('a dangling origin matches by the marketplace name; another marketplace never matches', () => {
    const renamed = { ...github, id: 'mkt_BBBBBBBBBBBBBBBB' }
    expect(installedEntries(records, renamed).size).toBe(6)
    expect(installedEntries(records, { id: 'mkt_CCCCCCCCCCCCCCCC', name: 'other' }).size).toBe(0)
  })
})

describe('github answers', () => {
  it('a full sha needs no request; refs resolve with the sha accept header', async () => {
    const routes = createFakeRemoteRoutes()
    const sha = routes.commit('acme/repo', { 'a.txt': 'a' }, { refs: ['main', 'v1'] })
    const fake = createFakeSafeFetch(routes)
    const context = { safeFetch: fake.safeFetch, bases: githubBases() }
    expect(await resolveGithubCommit(context, 'acme/repo', SHA_A.toUpperCase())).toBe(SHA_A)
    expect(fake.calls).toEqual([])
    expect(await resolveGithubCommit(context, 'acme/repo', 'v1')).toBe(sha)
    expect(fake.calls[0]?.options.headers?.accept).toBe('application/vnd.github.sha')
    expect(fake.calls[0]?.options.protocols).toEqual(['https:'])
    await expect(resolveGithubCommit(context, 'acme/repo', 'nope')).rejects.toMatchObject({ code: 'not_found' })
    await expect(resolveGithubCommit(context, 'acme/repo', '../x')).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('maps rate limits (403 / 429) with retryAfterMs, 404 / 422 to not_found, others to provider_error', () => {
    const answer = (status: number, headers: Record<string, string> = {}): { url: string, status: number, headers: Headers, body: Uint8Array } => ({ url: 'https://api.github.com/x', status, headers: new Headers(headers), body: new Uint8Array() })
    const what = { notFound: 'missing', failed: 'failed' }
    expect(githubAnswerError(answer(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1060' }), what, 1_000_000)).toMatchObject({ code: 'rate_limited', retryAfterMs: 60_000 })
    expect(githubAnswerError(answer(429, { 'retry-after': '7' }), what)).toMatchObject({ code: 'rate_limited', retryAfterMs: 7000 })
    expect(githubAnswerError(answer(403), what)).toMatchObject({ code: 'provider_error' })
    expect(githubAnswerError(answer(422), what)).toMatchObject({ code: 'not_found', message: 'missing' })
    expect(githubAnswerError(answer(500), what)).toMatchObject({ code: 'provider_error', message: 'failed (HTTP 500).' })
  })
})
