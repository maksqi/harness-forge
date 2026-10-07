// The GitHub and marketplace install sources (Phase 12, W12.2-T2 / T3 / T5): the commit's zip over HTTPS (no git), the
// subtree, the exec bits, the archive refusals, the rate-limit fallback, moved refs and stale reviews, 409 `exists` for
// another origin or format, `defaultEnabled`, `HF_OFFLINE`, and every supported marketplace entry kind. Claude Code
// plugins are read by the stand-in reader of `marketplaces/testing.ts` (W12.1's reader is probed at the gate).
import type { FakeRemoteRoutes } from '../../testing/fake-remote.ts'
import type { SourcesTestApp, SourcesTestAppOptions } from '../marketplaces/testing.ts'
import type { PluginInstallInput, PluginInstallOptions } from '../types.ts'
import { statSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createMarketplaceId, pluginInspectionSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_MARKETPLACE,
  claudeMarketplaceArchive,
  claudeMarketplaceFiles,
  claudePluginFiles,
  inFolder,
  registerClaudeMarketplaceRemote,
  writeFileTree,
} from '../../testing/claude-fixtures.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeRemoteRoutes, startFakeRemote } from '../../testing/fake-remote.ts'
import { createFakeIconService, createMemorySecretStore } from '../../testing/fakes.ts'
import { createPluginHost } from '../host.ts'
import { createSourcesTestApp, withFakeClaudeReader } from '../marketplaces/testing.ts'
import { CLAUDE_TREE_PIN_WARNING, INSTALLS_DISABLED_WARNING } from './inspection.ts'
import { allowAll, declarativePlugin } from './testing.ts'

const apps: SourcesTestApp[] = []
const folders: string[] = []
const posix = process.platform !== 'win32'

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
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'hf-src-')))
  folders.push(folder)
  return folder
}

async function rejection(promise: Promise<unknown>): Promise<{ code: string, message: string, details?: unknown }> {
  try {
    await promise
  }
  catch (error) {
    return error as { code: string, message: string }
  }
  throw new Error('expected a rejection')
}

function modeOf(app: SourcesTestApp, id: string, path: string): number {
  return statSync(join(app.t.env.paths.plugins, id, ...path.split('/'))).mode & 0o777
}

function requests(app: SourcesTestApp): string[] {
  return app.routes.requests.map(request => `${request.host}${request.path}`)
}

const trusted: PluginInstallOptions = { trust: true, authorize: allowAll }

describe('github source', () => {
  it('inspects and installs a Claude Code plugin from the commit zip: sourceRef, origin, exec bits kept', async () => {
    const routes = createFakeRemoteRoutes()
    const sha = routes.commit('acme/review-kit', claudePluginFiles('review-kit'))
    const app = await start({ routes })
    const input: PluginInstallInput = { source: 'github', repo: 'acme/review-kit', format: 'claude' }
    const inspection = pluginInspectionSchema.parse(await app.t.deps.installer.inspect(input))
    expect(inspection).toMatchObject({ format: 'claude', source: 'github', sourceRef: `acme/review-kit@${sha.slice(0, 12)}`, requiresTrust: true, existing: null })
    expect(inspection.manifest.id).toBe('review-kit')
    expect(inspection.claude?.namespace).toBe('review-kit')
    expect(inspection.warnings).toContain(CLAUDE_TREE_PIN_WARNING)
    expect(inspection.warnings.some(warning => warning.startsWith('Runs a command on your server'))).toBe(true)
    expect(requests(app)).toEqual([`api.github.com/repos/acme/review-kit/commits/HEAD`, `codeload.github.com/acme/review-kit/zip/${sha}`])

    const detail = await app.t.deps.installer.install(input, { ...trusted, sha256: inspection.sha256 })
    expect(detail).toMatchObject({ id: 'review-kit', state: 'active', source: 'github', sourceRef: `acme/review-kit@${sha.slice(0, 12)}` })
    const record = await app.t.deps.plugins.record('review-kit')
    expect(record).toMatchObject({ format: 'claude', source: 'github', enabled: true, trustedHash: inspection.sha256, origin: { kind: 'github', repo: 'acme/review-kit', ref: null, commit: sha, path: null } })
    if (posix) {
      expect(modeOf(app, 'review-kit', 'hooks/format.sh')).toBe(0o755)
      expect(modeOf(app, 'review-kit', 'skills/pdf/scripts/fill.sh')).toBe(0o755)
      expect(modeOf(app, 'review-kit', 'README.md')).toBe(0o644)
    }
  })

  it('without a format the layout decides: a Claude Code repository is detected (detectPluginLayout)', async () => {
    const routes = createFakeRemoteRoutes()
    routes.commit('acme/review-kit', claudePluginFiles('review-kit'))
    routes.commit('acme/single', claudePluginFiles('single-skill'))
    routes.commit('acme/readme', { 'README.md': 'not a plugin\n' })
    const app = await start({ routes })
    expect(await app.t.deps.installer.inspect({ source: 'github', repo: 'acme/review-kit' })).toMatchObject({ format: 'claude', manifest: { id: 'review-kit' } })
    expect(await app.t.deps.installer.inspect({ source: 'github', repo: 'acme/single' })).toMatchObject({ format: 'claude', manifest: { id: 'single' } })
    expect(await rejection(app.t.deps.installer.inspect({ source: 'github', repo: 'acme/readme' }))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('No plugin found') })
  })

  it('a harness plugin from GitHub is detected by its plugin.json and stays 0644', async () => {
    const routes = createFakeRemoteRoutes()
    routes.commit('acme/provider', { ...declarativePlugin('gh-provider'), 'run.sh': { content: '#!/bin/sh\n', mode: 0o755 } })
    const app = await start({ routes })
    const inspection = await app.t.deps.installer.inspect({ source: 'github', repo: 'acme/provider', ref: 'main' })
    expect(inspection).toMatchObject({ format: 'harness', source: 'github', claude: null })
    await app.t.deps.installer.install({ source: 'github', repo: 'acme/provider', ref: 'main' }, { authorize: allowAll })
    expect(await app.t.deps.plugins.record('gh-provider')).toMatchObject({ format: 'harness', origin: { kind: 'github', ref: 'main', path: null } })
    if (posix)
      expect(modeOf(app, 'gh-provider', 'run.sh')).toBe(0o644)
  })

  it('only the chosen folder is extracted and counted; a link outside it is ignored', async () => {
    const routes = createFakeRemoteRoutes()
    const others = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`docs/page-${index}.md`, `page ${index}\n`]))
    const sha = routes.commit('acme/monorepo', { ...others, ...inFolder('plugins/notes', claudePluginFiles('notes-only')) }, { variant: 'link' })
    const app = await start({ routes, installer: { limits: { entries: 10 } } })
    const input: PluginInstallInput = { source: 'github', repo: 'acme/monorepo', path: 'plugins/notes', format: 'claude' }
    const inspection = await app.t.deps.installer.inspect(input)
    expect(inspection).toMatchObject({ sourceRef: `acme/monorepo@${sha.slice(0, 12)}/plugins/notes`, requiresTrust: false, files: { count: 2 } })
    await app.t.deps.installer.install(input, { authorize: allowAll })
    expect(await app.t.deps.plugins.record('notes')).toMatchObject({ origin: { kind: 'github', path: 'plugins/notes', commit: sha } })
    // The whole repository is over the entry cap of this app, and holds the link entry: refused either way.
    expect(await rejection(app.t.deps.installer.inspect({ source: 'github', repo: 'acme/monorepo', format: 'claude' }))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('more than 10 entries') })
    const wide = await start({ routes })
    expect(await rejection(wide.t.deps.installer.inspect({ source: 'github', repo: 'acme/monorepo', format: 'claude' }))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('symbolic link') })
    expect(await rejection(app.t.deps.installer.inspect({ source: 'github', repo: 'acme/monorepo', path: 'plugins/missing' }))).toMatchObject({ code: 'not_found' })
  })

  it('refuses oversize, traversal, link, wrong-comment and wrong-top-folder archives', async () => {
    const routes = createFakeRemoteRoutes()
    for (const variant of ['oversize', 'traversal', 'link', 'wrong-comment', 'wrong-top-folder'] as const)
      routes.commit(`acme/${variant}`, claudePluginFiles('notes-only'), { variant })
    const app = await start({ routes })
    const inspect = (repo: string): Promise<unknown> => app.t.deps.installer.inspect({ source: 'github', repo, format: 'claude' })
    expect(await rejection(inspect('acme/oversize'))).toMatchObject({ code: 'payload_too_large' })
    expect(await rejection(inspect('acme/traversal'))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('..') })
    expect(await rejection(inspect('acme/link'))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('symbolic link') })
    expect(await rejection(inspect('acme/wrong-comment'))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('comment') })
    expect(await rejection(inspect('acme/wrong-top-folder'))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('top folder') })
    expect(await rejection(inspect('acme/unknown'))).toMatchObject({ code: 'not_found' })
    expect(await rejection(app.t.deps.installer.inspect({ source: 'github', repo: 'acme/link', ref: 'no-such-branch' }))).toMatchObject({ code: 'not_found' })
    // Every zip came from codeload without a redirect (maxRedirects 0) and only from the GitHub hosts.
    const zipCalls = app.fake.calls.filter(call => call.url.startsWith('https://codeload.github.com/'))
    expect(zipCalls.length).toBeGreaterThan(0)
    expect(zipCalls.every(call => call.options.maxRedirects === 0 && call.options.protocols?.join() === 'https:')).toBe(true)
    expect(app.fake.calls.every(call => /^https:\/\/(?:api\.github\.com|codeload\.github\.com)\//.test(call.url))).toBe(true)
  })

  it('a rate-limited API falls back to the ref zip and reads the sha from its comment', async () => {
    const routes = createFakeRemoteRoutes()
    const sha = routes.commit('acme/notes', claudePluginFiles('notes-only'))
    routes.setRateLimited(true)
    const app = await start({ routes })
    const byRef = await app.t.deps.installer.inspect({ source: 'github', repo: 'acme/notes', ref: 'main', format: 'claude' })
    expect(byRef.sourceRef).toBe(`acme/notes@${sha.slice(0, 12)}`)
    expect(byRef.warnings.some(warning => warning.includes('API limit'))).toBe(true)
    const byDefault = await app.t.deps.installer.inspect({ source: 'github', repo: 'acme/notes', format: 'claude' })
    expect(byDefault.sourceRef).toBe(`acme/notes@${sha.slice(0, 12)}`)
    expect(requests(app)).toEqual([
      'api.github.com/repos/acme/notes/commits/main',
      'codeload.github.com/acme/notes/zip/refs/heads/main',
      'api.github.com/repos/acme/notes/commits/HEAD',
      'codeload.github.com/acme/notes/zip/HEAD',
    ])
  })

  it('a moved ref gives a new commit; installing the old review is 409 stale; offline is 409 offline', async () => {
    const routes = createFakeRemoteRoutes()
    routes.commit('acme/notes', claudePluginFiles('notes-only'))
    const app = await start({ routes })
    const input: PluginInstallInput = { source: 'github', repo: 'acme/notes', ref: 'main', format: 'claude' }
    const first = await app.t.deps.installer.inspect(input)
    const moved = routes.commit('acme/notes', { ...claudePluginFiles('notes-only'), 'commands/extra.md': { content: '---\ndescription: Extra\n---\n\nExtra.\n', mode: 0o644 } })
    const second = await app.t.deps.installer.inspect(input)
    expect(second.sourceRef).toBe(`acme/notes@${moved.slice(0, 12)}`)
    expect(second.sha256).not.toBe(first.sha256)
    expect(await rejection(app.t.deps.installer.install(input, { authorize: allowAll, sha256: first.sha256 }))).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    // Without a hash in the request the review log of the same ref decides.
    routes.commit('acme/notes', { ...claudePluginFiles('notes-only'), 'commands/third.md': { content: 'Third.\n', mode: 0o644 } })
    expect(await rejection(app.t.deps.installer.install(input, { authorize: allowAll }))).toMatchObject({ code: 'conflict', details: { reason: 'stale' } })

    const offline = await start({ routes, env: { HF_OFFLINE: '1' } })
    const before = routes.requests.length
    expect(await rejection(offline.t.deps.installer.inspect(input))).toMatchObject({ code: 'conflict', details: { reason: 'offline' } })
    expect(routes.requests.length).toBe(before)
  })

  it('hF_OFFLINE leaves npm installs unchanged', async () => {
    const routes = createFakeRemoteRoutes()
    routes.npmPackage('acme-notes', { '1.0.0': { files: claudePluginFiles('notes-only') } })
    const app = await start({ routes, env: { HF_OFFLINE: '1' } })
    const detail = await app.t.deps.installer.install({ source: 'npm', spec: 'acme-notes@1.0.0', format: 'claude' }, { authorize: allowAll })
    expect(detail).toMatchObject({ id: 'acme-notes', source: 'npm', sourceRef: 'acme-notes@1.0.0', state: 'active' })
    expect(await app.t.deps.plugins.record('acme-notes')).toMatchObject({ format: 'claude', origin: null })
  })

  it('another origin or format holding the id is 409 exists; the same origin updates', async () => {
    const routes = createFakeRemoteRoutes()
    routes.commit('acme/notes', claudePluginFiles('notes-only'))
    routes.commit('other/notes', claudePluginFiles('notes-only'))
    const app = await start({ routes })
    await app.t.deps.installer.install({ source: 'github', repo: 'acme/notes', format: 'claude' }, { authorize: allowAll })
    const inspection = await app.t.deps.installer.inspect({ source: 'github', repo: 'other/notes', format: 'claude' })
    expect(inspection.existing).toMatchObject({ source: 'github' })
    expect(inspection.warnings.some(warning => warning.includes('acme/notes'))).toBe(true)
    expect(await rejection(app.t.deps.installer.install({ source: 'github', repo: 'other/notes', format: 'claude' }, { authorize: allowAll }))).toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    // The same origin is an update.
    const update = await app.t.deps.installer.install({ source: 'github', repo: 'acme/notes', ref: 'main', format: 'claude' }, { authorize: allowAll })
    expect(update.id).toBe('notes')

    // A harness plugin of the same id from the same repository folder: another format.
    routes.commit('acme/notes', declarativePlugin('notes'))
    expect(await rejection(app.t.deps.installer.install({ source: 'github', repo: 'acme/notes' }, { authorize: allowAll }))).toMatchObject({ code: 'conflict', details: { reason: 'exists' }, message: expect.stringContaining('Claude Code plugin') })
  })

  it('defaultEnabled false installs turned off unless the request sets enable', async () => {
    const routes = createFakeRemoteRoutes()
    const files = { ...claudePluginFiles('notes-only'), '.claude-plugin/plugin.json': { content: JSON.stringify({ name: 'quiet', defaultEnabled: false }), mode: 0o644 } }
    routes.commit('acme/quiet', files)
    routes.commit('acme/loud', { ...files, '.claude-plugin/plugin.json': { content: JSON.stringify({ name: 'loud', defaultEnabled: false }), mode: 0o644 } })
    const app = await start({ routes })
    const inspection = await app.t.deps.installer.inspect({ source: 'github', repo: 'acme/quiet', format: 'claude' })
    expect(inspection.warnings).toContain(INSTALLS_DISABLED_WARNING)
    const quiet = await app.t.deps.installer.install({ source: 'github', repo: 'acme/quiet', format: 'claude' }, { authorize: allowAll })
    expect(quiet).toMatchObject({ id: 'quiet', enabled: false, state: 'disabled' })
    const loud = await app.t.deps.installer.install({ source: 'github', repo: 'acme/loud', format: 'claude' }, { authorize: allowAll, enable: true })
    expect(loud).toMatchObject({ id: 'loud', enabled: true, state: 'active' })
  })
})

describe('marketplace source', () => {
  function marketplaceApp(options: SourcesTestAppOptions = {}): { routes: FakeRemoteRoutes, shas: ReturnType<typeof registerClaudeMarketplaceRemote>, app: Promise<SourcesTestApp> } {
    const routes = options.routes ?? createFakeRemoteRoutes()
    const shas = registerClaudeMarketplaceRemote(routes)
    return { routes, shas, app: start({ ...options, routes }) }
  }

  it('a relative entry comes from the stored commit (also after the ref moved); the origin keeps the overlay', async () => {
    const { routes, shas, app: pending } = marketplaceApp()
    const app = await pending
    const marketplace = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    routes.commit(CLAUDE_MARKETPLACE.repo, { 'README.md': { content: 'moved\n', mode: 0o644 } })
    const input: PluginInstallInput = { source: 'marketplace', marketplaceId: marketplace.id, plugin: 'review-kit' }
    const inspection = await app.t.deps.installer.inspect(input)
    expect(inspection).toMatchObject({ format: 'claude', source: 'marketplace', sourceRef: `${CLAUDE_MARKETPLACE.repo}@${shas.marketplace.slice(0, 12)}/plugins/review-kit`, requiresTrust: true })
    expect(requests(app).at(-1)).toBe(`codeload.github.com/${CLAUDE_MARKETPLACE.repo}/zip/${shas.marketplace}`)
    const detail = await app.t.deps.installer.install(input, { ...trusted, sha256: inspection.sha256 })
    expect(detail).toMatchObject({ id: 'review-kit', source: 'marketplace', sourceRef: 'review-kit@acme-tools', state: 'active' })
    const record = await app.t.deps.plugins.record('review-kit')
    expect(record?.origin).toMatchObject({
      kind: 'marketplace',
      marketplaceId: marketplace.id,
      marketplace: 'acme-tools',
      plugin: 'review-kit',
      sourceKind: 'relative',
      commit: shas.marketplace,
      path: 'plugins/review-kit',
      version: '1.2.0',
      overlay: { name: 'review-kit', strict: true, version: '1.2.0' },
    })
    const entry = (await app.t.deps.marketplaces.get(marketplace.id)).entries.find(item => item.name === 'review-kit')
    expect(entry).toMatchObject({ installedPluginId: 'review-kit', updateAvailable: false })
  })

  it('updates: a new entry version after a refresh, plugin.changed, then inspect → install again; remove keeps the plugin', async () => {
    const { routes, app: pending } = marketplaceApp()
    const app = await pending
    const marketplace = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    const input: PluginInstallInput = { source: 'marketplace', marketplaceId: marketplace.id, plugin: 'notes-only' }
    await app.t.deps.installer.install(input, { authorize: allowAll })
    const files = claudeMarketplaceFiles()
    const text = (files['.claude-plugin/marketplace.json']!.content as string).replace('"version": "0.3.0"', '"version": "0.4.0"')
    routes.commit(CLAUDE_MARKETPLACE.repo, { ...files, '.claude-plugin/marketplace.json': { content: text, mode: 0o644 } })
    app.events.clear()
    const refreshed = await app.t.deps.marketplaces.refresh(marketplace.id)
    expect(refreshed.updates).toBe(1)
    expect(refreshed.entries.find(entry => entry.name === 'notes-only')).toMatchObject({ installedPluginId: 'notes-only', updateAvailable: true, version: '0.4.0' })
    expect((await app.t.deps.marketplaces.list()).updates).toEqual([{ pluginId: 'notes-only', marketplaceId: marketplace.id, plugin: 'notes-only', version: '0.3.0', availableVersion: '0.4.0' }])
    expect(app.events.ofType('plugin.changed').map(event => event.data.id)).toEqual(['notes-only'])

    await app.t.deps.installer.install(input, { authorize: allowAll })
    expect((await app.t.deps.marketplaces.list()).updates).toEqual([])
    expect((await app.t.deps.plugins.record('notes-only'))?.origin).toMatchObject({ version: '0.4.0' })

    await app.t.deps.marketplaces.remove(marketplace.id)
    expect(await app.t.deps.plugins.record('notes-only')).toMatchObject({ source: 'marketplace', origin: { marketplace: 'acme-tools' } })
    // Added again (a new id): the dangling origin is found by the marketplace's name.
    const again = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    expect(again.entries.find(entry => entry.name === 'notes-only')?.installedPluginId).toBe('notes-only')
  })

  it('github, github.com url, git-subdir, archive and npm entries install; their origins record the source', async () => {
    const { shas, app: pending } = marketplaceApp()
    const app = await pending
    const marketplace = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    const install = (plugin: string): Promise<unknown> => app.t.deps.installer.install({ source: 'marketplace', marketplaceId: marketplace.id, plugin }, trusted)
    await install('gh-plugin')
    // No plugin.json: the entry name is the plugin's name.
    expect((await app.t.deps.plugins.record('gh-plugin'))?.origin).toMatchObject({ plugin: 'gh-plugin', sourceKind: 'github', commit: shas.githubPlugin })
    await install('url-plugin')
    expect((await app.t.deps.plugins.record('url-plugin'))?.origin).toMatchObject({ sourceKind: 'github', commit: shas.urlPlugin })
    await install('subdir-plugin')
    expect((await app.t.deps.plugins.record('subdir-plugin'))?.origin).toMatchObject({ sourceKind: 'github', commit: shas.monorepo, path: CLAUDE_MARKETPLACE.subdirPath })
    await install('archive-plugin')
    expect((await app.t.deps.plugins.record('archive-plugin'))?.origin).toMatchObject({ sourceKind: 'archive', archiveSha256: claudeMarketplaceArchive().sha256 })
    await install('npm-plugin')
    expect((await app.t.deps.plugins.record('npm-plugin'))?.origin).toMatchObject({ sourceKind: 'npm', npmVersion: '1.0.0' })
    expect(app.routes.requests.some(request => request.host === 'registry.npmjs.org')).toBe(true)
  })

  it('an archive whose bytes differ from the pinned sha256 is refused', async () => {
    const { routes, app: pending } = marketplaceApp()
    const app = await pending
    routes.serve(CLAUDE_MARKETPLACE.archiveUrl, claudeMarketplaceArchive().zip.slice(0, -1))
    const marketplace = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    expect(await rejection(app.t.deps.installer.inspect({ source: 'marketplace', marketplaceId: marketplace.id, plugin: 'archive-plugin' }))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('sha256') })
  })

  it('unsupported (400), unknown entry or marketplace (404), url relative entries (400)', async () => {
    const { app: pending } = marketplaceApp()
    const app = await pending
    const marketplace = await app.t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
    for (const plugin of ['command-plugin', 'private-plugin', 'gitlab-plugin', 'escape'])
      expect(await rejection(app.t.deps.installer.inspect({ source: 'marketplace', marketplaceId: marketplace.id, plugin })), plugin).toMatchObject({ code: 'validation_error' })
    expect(await rejection(app.t.deps.installer.inspect({ source: 'marketplace', marketplaceId: marketplace.id, plugin: 'nope' }))).toMatchObject({ code: 'not_found' })
    expect(await rejection(app.t.deps.installer.inspect({ source: 'marketplace', marketplaceId: createMarketplaceId(), plugin: 'review-kit' }))).toMatchObject({ code: 'not_found' })
    await app.t.deps.marketplaces.remove(marketplace.id)
    const hosted = await app.t.deps.marketplaces.add({ source: { type: 'url', url: CLAUDE_MARKETPLACE.jsonUrl } })
    expect(await rejection(app.t.deps.installer.inspect({ source: 'marketplace', marketplaceId: hosted.id, plugin: 'review-kit' }))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('URL') })
  })

  it('a folder marketplace installs its relative entries offline; entries that need the network are 409 offline', async () => {
    const { app: pending } = marketplaceApp({ env: { HF_OFFLINE: '1' } })
    const app = await pending
    const folder = await tempFolder()
    await writeFileTree(folder, claudeMarketplaceFiles())
    const marketplace = await app.t.deps.marketplaces.add({ source: { type: 'path', path: folder } })
    const input: PluginInstallInput = { source: 'marketplace', marketplaceId: marketplace.id, plugin: 'notes-only' }
    const inspection = await app.t.deps.installer.inspect(input)
    expect(inspection).toMatchObject({ format: 'claude', requiresTrust: false, sourceRef: join(folder, 'plugins', 'notes-only') })
    expect(await app.t.deps.installer.install(input, { authorize: allowAll })).toMatchObject({ id: 'notes-only', source: 'marketplace', sourceRef: 'notes-only@acme-tools', state: 'active' })
    expect((await app.t.deps.plugins.record('notes-only'))?.origin).toMatchObject({ sourceKind: 'relative', path: 'plugins/notes-only' })
    expect(await app.t.deps.installer.install({ source: 'marketplace', marketplaceId: marketplace.id, plugin: 'review-kit' }, trusted)).toMatchObject({ id: 'review-kit', state: 'active' })
    if (posix)
      expect(modeOf(app, 'review-kit', 'hooks/format.sh')).toBe(0o755)
    expect(await rejection(app.t.deps.installer.inspect({ source: 'marketplace', marketplaceId: marketplace.id, plugin: 'gh-plugin' }))).toMatchObject({ code: 'conflict', details: { reason: 'offline' } })
    expect(await rejection(app.t.deps.installer.inspect({ source: 'marketplace', marketplaceId: marketplace.id, plugin: 'npm-plugin' }))).toMatchObject({ code: 'conflict', details: { reason: 'offline' } })
    expect(app.routes.requests).toEqual([])
  })

  it('a strict: false entry is read with its overlay (the overlay joins the stand-in tree hash)', async () => {
    const { app: pending } = marketplaceApp()
    const app = await pending
    const folder = await tempFolder()
    await writeFileTree(folder, claudeMarketplaceFiles())
    const marketplace = await app.t.deps.marketplaces.add({ source: { type: 'path', path: folder } })
    const inspection = await app.t.deps.installer.inspect({ source: 'marketplace', marketplaceId: marketplace.id, plugin: 'inline-tools' })
    expect(inspection.manifest).toMatchObject({ id: 'inline-tools', version: '0.1.0' })
    const copy = await app.t.deps.installer.inspect({ source: 'path', path: join(folder, 'plugins', 'inline-tools'), mode: 'copy', format: 'claude' })
    expect(copy.sha256).not.toBe(inspection.sha256)
  })
})

describe('hF_TEST_REMOTE_URL (with HF_MOCK_PROVIDER=1)', () => {
  it('reroutes the GitHub, archive and npm fetches of the production installer and marketplaces to the loopback fake', async () => {
    const remote = await startFakeRemote()
    try {
      const shas = registerClaudeMarketplaceRemote(remote.routes)
      const t = await createTestApp({
        env: { HF_MOCK_PROVIDER: '1', HF_TEST_REMOTE_URL: remote.url },
        start: false,
        builtins: [],
        overrides: { secrets: createMemorySecretStore(), icons: createFakeIconService() },
        factories: { plugins: deps => withFakeClaudeReader(createPluginHost(deps), deps) },
      })
      try {
        await t.deps.plugins.start()
        const marketplace = await t.deps.marketplaces.add({ source: { type: 'github', repo: CLAUDE_MARKETPLACE.repo } })
        expect(marketplace.resolvedRef).toBe(shas.marketplace)
        for (const plugin of ['notes-only', 'gh-plugin', 'archive-plugin', 'npm-plugin'])
          expect(await t.deps.installer.install({ source: 'marketplace', marketplaceId: marketplace.id, plugin }, trusted), plugin).toMatchObject({ source: 'marketplace', state: 'active' })
        const hostsSeen = new Set(remote.requests.map(request => request.host))
        expect([...hostsSeen].sort()).toEqual(['api.github.com', 'codeload.github.com', 'downloads.example.com', 'raw.githubusercontent.com', 'registry.npmjs.org'])
        expect(remote.requests.every(request => request.status === 200)).toBe(true)
      }
      finally {
        await t.close()
      }
    }
    finally {
      await remote.close()
    }
  })
})
