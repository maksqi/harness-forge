import type { SafeFetch } from '../../security/types.ts'
// The marketplace service (Phase 12, W12.2-T4 / T5): add github / url / path sources through the fake remote (no real
// network), unsupported entries, the reserved names, 409 `exists` (name, 50 rows), 404, 413, 429, 502, `HF_OFFLINE`,
// refresh (a moved ref, a failure keeps the catalog), the update state, remove keeps plugins, stop aborts.
import type { FakeRemoteRoutes } from '../../testing/fake-remote.ts'
import type { SourcesTestApp, SourcesTestAppOptions } from './testing.ts'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMarketplaceId, LIMITS, MARKETPLACE_SUGGESTIONS, marketplaceDetailSchema, marketplaceListSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { marketplaces as marketplacesTable } from '../../db/schema.ts'
import {
  CLAUDE_MARKETPLACE,
  claudeMarketplaceFiles,
  claudeMarketplaceJson,
  claudePluginFiles,
  registerClaudeMarketplaceRemote,
  writeFileTree,
} from '../../testing/claude-fixtures.ts'
import { createFakeRemoteRoutes } from '../../testing/fake-remote.ts'
import { RELATIVE_FROM_URL_REASON } from './catalog.ts'
import { createMarketplaceService } from './index.ts'
import { createSourcesTestApp } from './testing.ts'
import { GITHUB_API_BASE, GITHUB_CODELOAD_BASE, GITHUB_RAW_BASE } from './types.ts'

const apps: SourcesTestApp[] = []
const folders: string[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true })
})

async function start(options: SourcesTestAppOptions = {}): Promise<SourcesTestApp> {
  const app = await createSourcesTestApp(options)
  apps.push(app)
  return app
}

async function tempFolder(): Promise<string> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'hf-mkt-')))
  folders.push(folder)
  return folder
}

function marketplaceRoutes(): { routes: FakeRemoteRoutes, shas: ReturnType<typeof registerClaudeMarketplaceRemote> } {
  const routes = createFakeRemoteRoutes()
  return { routes, shas: registerClaudeMarketplaceRemote(routes) }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function hosts(app: SourcesTestApp): string[] {
  return app.routes.requests.map(request => `${request.host}${request.path.split('?')[0]}`)
}

describe('add', () => {
  it('a GitHub marketplace: the ref resolves to a commit, the catalog comes from that commit, entries are classified', async () => {
    const { routes, shas } = marketplaceRoutes()
    const app = await start({ routes })
    const detail = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    expect(marketplaceDetailSchema.parse(detail)).toMatchObject({
      name: 'acme-tools',
      owner: 'Acme Tools',
      description: 'Plugins of the harness-forge tests.',
      source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo },
      resolvedRef: shas.marketplace,
      lastError: null,
      updates: 0,
    })
    expect(hosts(app)).toEqual([
      `api.github.com/repos/${CLAUDE_MARKETPLACE.repo}/commits/HEAD`,
      `raw.githubusercontent.com/${CLAUDE_MARKETPLACE.repo}/${shas.marketplace}/.claude-plugin/marketplace.json`,
    ])
    const entries = Object.fromEntries(detail.entries.map(entry => [entry.name, entry]))
    expect(Object.keys(entries)).toEqual(['review-kit', 'notes-only', 'bare-notes', 'gh-plugin', 'url-plugin', 'subdir-plugin', 'archive-plugin', 'npm-plugin', 'private-plugin', 'command-plugin', 'gitlab-plugin', 'inline-tools', 'bad-github', 'escape'])
    expect(entries['review-kit']).toMatchObject({ supported: true, version: '1.2.0', category: 'development', tags: ['review'], source: { kind: 'relative', text: './plugins/review-kit' }, installedPluginId: null, updateAvailable: false })
    expect(entries['bare-notes']?.source).toEqual({ kind: 'relative', text: './plugins/notes-only' })
    expect(entries['gh-plugin']).toMatchObject({ supported: true, source: { kind: 'github', text: `${CLAUDE_MARKETPLACE.githubRepo}@v1` } })
    expect(entries['url-plugin']).toMatchObject({ supported: true, source: { kind: 'github' } })
    expect(entries['subdir-plugin']).toMatchObject({ supported: true, source: { kind: 'github', text: `${CLAUDE_MARKETPLACE.monorepo}@main/${CLAUDE_MARKETPLACE.subdirPath}` } })
    expect(entries['archive-plugin']).toMatchObject({ supported: true, source: { kind: 'archive', text: CLAUDE_MARKETPLACE.archiveUrl } })
    expect(entries['npm-plugin']).toMatchObject({ supported: true, source: { kind: 'npm', text: `${CLAUDE_MARKETPLACE.npmPackage}@^1.0.0` } })
    for (const name of ['private-plugin', 'command-plugin', 'gitlab-plugin', 'bad-github', 'escape']) {
      expect(entries[name]?.supported, name).toBe(false)
      expect(entries[name]?.unsupportedReason, name).toMatch(/\.$/)
    }
    expect(detail.diagnostics.length).toBeGreaterThan(0)
    expect(detail.diagnostics.every(diagnostic => diagnostic.path === '.claude-plugin/marketplace.json')).toBe(true)
    const changed = app.events.ofType('marketplace.changed')
    expect(changed).toHaveLength(1)
    expect(changed[0]?.data).toMatchObject({ id: detail.id, marketplace: { name: 'acme-tools', plugins: 14 } })
    expect(await app.t.deps.marketplaces.get(detail.id)).toEqual(detail)
  })

  it('a URL marketplace: the sha256 of the JSON is the resolved ref; relative entries are unsupported', async () => {
    const { routes } = marketplaceRoutes()
    const app = await start({ routes })
    const detail = await app.t.deps.marketplaces.add({ source: { type: 'url', url: CLAUDE_MARKETPLACE.jsonUrl } })
    expect(detail.resolvedRef).toBe(createHash('sha256').update(claudeMarketplaceJson()).digest('hex'))
    const review = detail.entries.find(entry => entry.name === 'review-kit')
    expect(review).toMatchObject({ supported: false, unsupportedReason: RELATIVE_FROM_URL_REASON })
    expect(detail.entries.find(entry => entry.name === 'gh-plugin')?.supported).toBe(true)
  })

  it('a folder marketplace: read on the server host, no resolved ref, no network', async () => {
    const app = await start()
    const folder = await tempFolder()
    await writeFileTree(folder, claudeMarketplaceFiles())
    const detail = await app.t.deps.marketplaces.add({ source: { type: 'path', path: folder } })
    expect(detail).toMatchObject({ name: 'acme-tools', resolvedRef: null, source: { type: 'path', path: folder } })
    expect(detail.entries.find(entry => entry.name === 'review-kit')?.supported).toBe(true)
    expect(app.routes.requests).toEqual([])
  })

  it('nothing is stored when the fetch or the catalog fails: 404, 400, 413, 429, 502', async () => {
    const routes = createFakeRemoteRoutes()
    routes.commit('acme/empty', { 'README.md': 'nothing here\n' })
    routes.commit('acme/broken', { '.claude-plugin/marketplace.json': '{ "name": ' })
    routes.commit('acme/huge', { '.claude-plugin/marketplace.json': json({ name: 'huge', owner: { name: 'x' }, plugins: [], padding: 'x'.repeat(LIMITS.marketplaceJsonBytes) }) })
    routes.serve('https://example.com/failing/marketplace.json', { status: 500, body: 'oops' })
    const app = await start({ routes })
    const add = app.t.deps.marketplaces.add
    await expect(add({ source: { type: 'github', repo: 'acme/missing' } })).rejects.toMatchObject({ code: 'not_found' })
    await expect(add({ source: { type: 'github', repo: 'acme/empty', ref: 'no-such-branch' } })).rejects.toMatchObject({ code: 'not_found' })
    await expect(add({ source: { type: 'github', repo: 'acme/empty' } })).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining('.claude-plugin/marketplace.json') })
    await expect(add({ source: { type: 'github', repo: 'acme/broken' } })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(add({ source: { type: 'github', repo: 'acme/huge' } })).rejects.toMatchObject({ code: 'payload_too_large' })
    await expect(add({ source: { type: 'url', url: 'https://example.com/failing/marketplace.json' } })).rejects.toMatchObject({ code: 'provider_error' })
    routes.setRateLimited(true, { resetAt: Math.floor(Date.now() / 1000) + 120 })
    const limited = await add({ source: { type: 'github', repo: 'acme/empty' } }).catch((error: unknown) => error)
    expect(limited).toMatchObject({ code: 'rate_limited' })
    expect((limited as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(60_000)
    expect((await app.t.deps.marketplaces.list()).items).toEqual([])
    expect(app.events.ofType('marketplace.changed')).toEqual([])
  })

  it('a missing folder is 404; a folder without the file is 404; a link to the file is refused', async () => {
    const app = await start()
    const folder = await tempFolder()
    await expect(app.t.deps.marketplaces.add({ source: { type: 'path', path: join(folder, 'missing') } })).rejects.toMatchObject({ code: 'not_found' })
    await expect(app.t.deps.marketplaces.add({ source: { type: 'path', path: folder } })).rejects.toMatchObject({ code: 'not_found' })
    await expect(app.t.deps.marketplaces.add({ source: { type: 'path', path: app.t.env.dataDir } })).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('reserved names come only from anthropics repositories (400 on ["source"]); a taken name is 409 exists', async () => {
    const routes = createFakeRemoteRoutes()
    const official = json({ name: 'claude-plugins-official', owner: { name: 'Anthropic' }, plugins: [] })
    routes.commit('evil/claude-plugins-official', { '.claude-plugin/marketplace.json': official })
    routes.commit('anthropics/claude-plugins-official', { '.claude-plugin/marketplace.json': official })
    routes.commit('evil/anthropic-tools', { '.claude-plugin/marketplace.json': json({ name: 'anthropic-tools', owner: { name: 'x' }, plugins: [] }) })
    routes.commit('other/copy', { '.claude-plugin/marketplace.json': official })
    const app = await start({ routes })
    const refused = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: 'evil/claude-plugins-official' } }).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['source'] }] } })
    await expect(app.t.deps.marketplaces.add({ source: { type: 'github', repo: 'evil/anthropic-tools' } })).rejects.toMatchObject({ code: 'validation_error' })
    const folder = await tempFolder()
    await writeFileTree(folder, { '.claude-plugin/marketplace.json': official })
    await expect(app.t.deps.marketplaces.add({ source: { type: 'path', path: folder } })).rejects.toMatchObject({ code: 'validation_error' })

    const added = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: 'anthropics/claude-plugins-official' } })
    expect(added.name).toBe('claude-plugins-official')
    expect((await app.t.deps.marketplaces.list()).suggestions).toEqual([])
    const taken = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: 'Anthropics/claude-plugins-official' } }).catch((error: unknown) => error)
    expect(taken).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
  })

  it('at most 50 marketplaces (409 exists before any request)', async () => {
    const app = await start()
    const now = Date.now()
    await app.t.db.insert(marketplacesTable).values(Array.from({ length: LIMITS.marketplacesMax }, (_, index) => ({
      id: createMarketplaceId(),
      name: `market-${index}`,
      source: { type: 'path' as const, path: `/srv/market-${index}` },
      resolvedRef: null,
      catalog: null,
      fetchedAt: now,
      lastError: null,
      createdAt: now + index,
      updatedAt: now + index,
    })))
    await expect(app.t.deps.marketplaces.add({ source: { type: 'github', repo: 'acme/one-more' } })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect(app.routes.requests).toEqual([])
    expect((await app.t.deps.marketplaces.list()).items).toHaveLength(LIMITS.marketplacesMax)
  })
})

describe('list, refresh, remove', () => {
  it('list: no network, the suggestion until added, the summaries', async () => {
    const { routes } = marketplaceRoutes()
    const app = await start({ routes })
    expect(await app.t.deps.marketplaces.list()).toEqual({ items: [], suggestions: [...MARKETPLACE_SUGGESTIONS], updates: [] })
    expect(app.routes.requests).toEqual([])
    const detail = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    const list = marketplaceListSchema.parse(await app.t.deps.marketplaces.list())
    expect(list.items).toEqual([{ ...detail, entries: undefined, diagnostics: undefined }].map(({ entries: _e, diagnostics: _d, ...summary }) => summary))
    expect(list.suggestions.map(suggestion => suggestion.name)).toEqual(['claude-plugins-official'])
  })

  it('refresh: a moved ref gives a new commit; a failure keeps the catalog and stores lastError; 404', async () => {
    const { routes, shas } = marketplaceRoutes()
    const app = await start({ routes })
    const added = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    const next = routes.commit(CLAUDE_MARKETPLACE.repo, {
      ...claudeMarketplaceFiles(),
      '.claude-plugin/marketplace.json': { content: json({ name: 'acme-tools', owner: { name: 'Acme Tools' }, plugins: [{ name: 'review-kit', source: './plugins/review-kit', version: '1.3.0' }] }), mode: 0o644 },
    })
    expect(next).not.toBe(shas.marketplace)
    const refreshed = await app.t.deps.marketplaces.refresh(added.id)
    expect(refreshed).toMatchObject({ resolvedRef: next, plugins: 1, lastError: null })
    expect(refreshed.entries[0]).toMatchObject({ name: 'review-kit', version: '1.3.0' })

    routes.setRateLimited(true)
    await expect(app.t.deps.marketplaces.refresh(added.id)).rejects.toMatchObject({ code: 'rate_limited' })
    const kept = await app.t.deps.marketplaces.get(added.id)
    expect(kept).toMatchObject({ resolvedRef: next, plugins: 1, lastError: { code: 'rate_limited' } })
    routes.setRateLimited(false)
    expect((await app.t.deps.marketplaces.refresh(added.id)).lastError).toBeNull()
    await expect(app.t.deps.marketplaces.refresh(createMarketplaceId())).rejects.toMatchObject({ code: 'not_found' })
    expect(app.events.ofType('marketplace.changed').length).toBe(4)
  })

  it('refresh refuses a renamed marketplace (lastError) and a path marketplace is read again', async () => {
    const app = await start()
    const folder = await tempFolder()
    await writeFileTree(folder, claudeMarketplaceFiles())
    const added = await app.t.deps.marketplaces.add({ source: { type: 'path', path: folder } })
    await writeFileTree(folder, { '.claude-plugin/marketplace.json': { content: json({ name: 'acme-tools', owner: { name: 'Acme' }, plugins: [] }), mode: 0o644 } })
    expect((await app.t.deps.marketplaces.refresh(added.id)).plugins).toBe(0)
    await writeFileTree(folder, { '.claude-plugin/marketplace.json': { content: json({ name: 'renamed', owner: { name: 'Acme' }, plugins: [] }), mode: 0o644 } })
    await expect(app.t.deps.marketplaces.refresh(added.id)).rejects.toMatchObject({ code: 'validation_error' })
    expect((await app.t.deps.marketplaces.get(added.id)).lastError).toMatchObject({ code: 'validation_error' })
  })

  it('remove: 204 semantics, the event with null, 404 after; the suggestion comes back', async () => {
    const routes = createFakeRemoteRoutes()
    routes.commit('anthropics/claude-plugins-official', { '.claude-plugin/marketplace.json': json({ name: 'claude-plugins-official', owner: { name: 'Anthropic' }, plugins: [] }) })
    const app = await start({ routes })
    const added = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: 'anthropics/claude-plugins-official' } })
    await app.t.deps.marketplaces.remove(added.id)
    expect(app.events.ofType('marketplace.changed').at(-1)?.data).toEqual({ id: added.id, marketplace: null })
    await expect(app.t.deps.marketplaces.get(added.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(app.t.deps.marketplaces.remove(added.id)).rejects.toMatchObject({ code: 'not_found' })
    expect((await app.t.deps.marketplaces.list()).suggestions).toHaveLength(1)
  })
})

describe('hF_OFFLINE', () => {
  it('github and url sources are 409 offline (add and refresh, lastError kept); a folder marketplace still works', async () => {
    const { routes } = marketplaceRoutes()
    const app = await start({ routes, env: { HF_OFFLINE: '1' } })
    await expect(app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'offline' } })
    await expect(app.t.deps.marketplaces.add({ source: { type: 'url', url: CLAUDE_MARKETPLACE.jsonUrl } })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'offline' } })
    const folder = await tempFolder()
    await writeFileTree(folder, claudeMarketplaceFiles())
    const added = await app.t.deps.marketplaces.add({ source: { type: 'path', path: folder } })
    expect((await app.t.deps.marketplaces.refresh(added.id)).name).toBe('acme-tools')
    expect(app.routes.requests).toEqual([])

    // A github marketplace added while online, refreshed offline.
    const now = Date.now()
    const id = createMarketplaceId()
    await app.t.db.insert(marketplacesTable).values({ id, name: 'online', source: { type: 'github', repo: 'acme/online' }, resolvedRef: 'a'.repeat(40), catalog: null, fetchedAt: now, lastError: null, createdAt: now, updatedAt: now })
    await expect(app.t.deps.marketplaces.refresh(id)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'offline' } })
    expect((await app.t.deps.marketplaces.get(id)).lastError).toMatchObject({ code: 'conflict' })
  })
})

describe('stop', () => {
  it('aborts the fetches in flight: the add stores nothing', async () => {
    const t = await start()
    let started: () => void = () => {}
    const begun = new Promise<void>((resolve) => {
      started = resolve
    })
    const hanging: SafeFetch = (_url, options) => new Promise((_resolve, reject) => {
      started()
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
    const service = createMarketplaceService(t.t.deps, { safeFetch: hanging, githubApi: 'https://api.github.com' })
    const adding = service.add({ source: { type: 'github', repo: 'acme/slow' } })
    await begun
    await service.stop()
    await expect(adding).rejects.toMatchObject({ code: 'provider_unreachable' })
    await expect(service.add({ source: { type: 'github', repo: 'acme/slow' } })).rejects.toMatchObject({ code: 'provider_unreachable' })
    await service.stop()
    expect((await service.list()).items).toEqual([])
  })

  it('the GitHub hosts are https constants', () => {
    expect([GITHUB_API_BASE, GITHUB_RAW_BASE, GITHUB_CODELOAD_BASE]).toEqual(['https://api.github.com', 'https://raw.githubusercontent.com', 'https://codeload.github.com'])
  })
})

describe('logs', () => {
  it('carry the id, name, repository and a 12-character sha only (never the JSON)', async () => {
    const { routes, shas } = marketplaceRoutes()
    const app = await start({ routes })
    await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    const record = app.t.logs.records.find(entry => entry.msg === 'marketplace added')
    expect(record).toMatchObject({ name: 'acme-tools', repo: CLAUDE_MARKETPLACE.repo, sha: shas.marketplace.slice(0, 12) })
    const text = JSON.stringify(app.t.logs.records)
    expect(text).not.toContain('Plugins of the harness-forge tests.')
    expect(text).not.toContain(claudePluginFiles('review-kit')['.claude-plugin/plugin.json']!.content as string)
  })
})
